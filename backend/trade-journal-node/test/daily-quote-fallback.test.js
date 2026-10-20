import assert from 'node:assert/strict';
import test from 'node:test';

import { createDailyQuoteFallback } from '../src/daily-quote-fallback.js';

const AS_OF = '2026-10-20';

function collectLogger() {
  const warnings = [];
  return {
    warnings,
    logger: {
      warn(entry) {
        warnings.push(entry);
      },
    },
  };
}

function quoteResponse(symbol, rows) {
  return {
    ok: true,
    status: 200,
    json() {
      return { symbol, rows, source: 'enriched' };
    },
  };
}

async function until(predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.equal(predicate(), true);
}

test('empty and blank symbols do not fetch', async () => {
  let calls = 0;
  const fallback = createDailyQuoteFallback({
    fetchImpl() {
      calls += 1;
      throw new Error('must not fetch');
    },
  });

  assert.equal((await fallback([], AS_OF)).size, 0);
  assert.equal((await fallback(null, AS_OF)).size, 0);
  assert.equal((await fallback([''], AS_OF)).size, 0);
  assert.equal(calls, 0);
});

test('deadline returns when fetch or json ignores AbortSignal', async () => {
  const { warnings, logger } = collectLogger();
  let fetchSignal;
  const hangingFetch = createDailyQuoteFallback({
    fetchImpl(_url, init) {
      fetchSignal = init.signal;
      return new Promise(() => {});
    },
    logger,
    timeoutMs: 20,
  });

  const fromFetch = await hangingFetch(['000001.SZ'], AS_OF);
  assert.deepEqual(fromFetch.get('000001.SZ'), { cacheable: false, quote: null });
  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(warnings, [{ reason: 'timeout', status: null, count: 1 }]);
  assert.equal(JSON.stringify(warnings).includes('http'), false);

  warnings.length = 0;
  let jsonSignal;
  const hangingJson = createDailyQuoteFallback({
    fetchImpl(_url, init) {
      jsonSignal = init.signal;
      return {
        ok: true,
        status: 200,
        json() {
          return new Promise(() => {});
        },
      };
    },
    logger,
    timeoutMs: 20,
  });

  const fromJson = await hangingJson(['000001.SZ'], AS_OF);
  assert.deepEqual(fromJson.get('000001.SZ'), { cacheable: false, quote: null });
  assert.equal(jsonSignal.aborted, true);
  assert.deepEqual(warnings, [{ reason: 'timeout', status: 200, count: 1 }]);
});

test('one http failure stays uncached and does not drop a sibling quote', async () => {
  const { warnings, logger } = collectLogger();
  const calls = [];
  const cancels = [];
  const signals = [];
  const fallback = createDailyQuoteFallback({
    baseUrl: 'http://market.example/',
    logger,
    now: () => 0,
    fetchImpl(url, init) {
      const symbol = new URL(url).searchParams.get('symbol');
      calls.push({ url, method: init.method, symbol });
      if (symbol === 'FAIL.SZ') {
        signals.push(init.signal);
        return {
          ok: false,
          status: 500,
          body: {
            cancel() {
              cancels.push(symbol);
            },
          },
          json() {
            throw new Error('error body must stay unread');
          },
        };
      }
      if (symbol === 'OK.SZ') {
        return quoteResponse(symbol, [
          { date: AS_OF, raw_close: '12.34', close: '1.00' },
        ]);
      }
      return quoteResponse('OTHER.SZ', [
        { date: AS_OF, raw_close: '3.00', close: '3.00' },
      ]);
    },
  });

  const first = await fallback(['FAIL.SZ', 'OK.SZ', 'SHAPE.SZ', 'FAIL.SZ'], AS_OF);
  assert.deepEqual(first.get('FAIL.SZ'), { cacheable: false, quote: null });
  assert.deepEqual(first.get('OK.SZ'), {
    cacheable: true,
    quote: { price: '12.34', price_as_of: AS_OF, price_status: 'fresh' },
  });
  assert.deepEqual(first.get('SHAPE.SZ'), { cacheable: false, quote: null });
  assert.deepEqual(calls.map((call) => call.symbol), ['FAIL.SZ', 'OK.SZ', 'SHAPE.SZ']);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://market.example/api/kline/daily?symbol=FAIL.SZ&end_date=2026-10-20&days=120');
  assert.equal(calls[1].url, 'http://market.example/api/kline/daily?symbol=OK.SZ&end_date=2026-10-20&days=120');
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(cancels, ['FAIL.SZ']);
  assert.deepEqual(warnings, [
    { reason: 'http', status: 500, count: 1 },
    { reason: 'bad_shape', status: 200, count: 1 },
  ]);
  assert.equal(JSON.stringify(warnings).includes('http://'), false);
  assert.equal(JSON.stringify(warnings).includes('raw_close'), false);

  warnings.length = 0;
  const second = await fallback(['OK.SZ', 'FAIL.SZ', 'SHAPE.SZ'], AS_OF);
  assert.deepEqual(second.get('OK.SZ'), first.get('OK.SZ'));
  assert.deepEqual(second.get('FAIL.SZ'), { cacheable: false, quote: null });
  assert.deepEqual(second.get('SHAPE.SZ'), { cacheable: false, quote: null });
  assert.deepEqual(calls.map((call) => call.symbol), ['FAIL.SZ', 'OK.SZ', 'SHAPE.SZ', 'FAIL.SZ', 'SHAPE.SZ']);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(cancels, ['FAIL.SZ', 'FAIL.SZ']);
  assert.deepEqual(warnings, [
    { reason: 'http', status: 500, count: 1 },
    { reason: 'bad_shape', status: 200, count: 1 },
  ]);
});

test('at most four symbol GETs run at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  const releases = [];
  const symbols = ['S1.SZ', 'S2.SZ', 'S3.SZ', 'S4.SZ', 'S5.SZ', 'S6.SZ'];
  const fallback = createDailyQuoteFallback({
    concurrency: 8,
    fetchImpl(url) {
      const symbol = new URL(url).searchParams.get('symbol');
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve(quoteResponse(symbol, [
            { date: AS_OF, raw_close: '1.25', close: '9' },
          ]));
        });
      });
    },
  });

  const pending = fallback(symbols, AS_OF);
  await until(() => started === 4 && releases.length === 4);
  assert.equal(maxInFlight, 4);

  releases.shift()();
  await until(() => started === 5);
  assert.equal(maxInFlight, 4);

  for (let i = 0; i < 40 && (started < symbols.length || releases.length > 0); i += 1) {
    if (releases.length > 0) releases.shift()();
    await Promise.resolve();
  }

  const outcomes = await pending;
  assert.equal(started, 6);
  assert.equal(maxInFlight, 4);
  assert.equal(inFlight, 0);
  for (const symbol of symbols) {
    assert.deepEqual(outcomes.get(symbol), {
      cacheable: true,
      quote: { price: '1.25', price_as_of: AS_OF, price_status: 'fresh' },
    });
  }
});

test('as-of live raw_close stays fresh and an older live bar stays stale', async () => {
  let nowMs = 0;
  const urls = [];
  const fallback = createDailyQuoteFallback({
    baseUrl: 'http://market.example',
    now: () => nowMs,
    fetchImpl(url) {
      urls.push(url);
      const symbol = new URL(url).searchParams.get('symbol');
      assert.equal(new URL(url).searchParams.get('days'), '120');
      if (symbol === 'NONE.SZ') {
        return quoteResponse(symbol, [
          { date: AS_OF, raw_close: '', close: '8.80', is_live: true },
        ]);
      }
      if (symbol === 'OLD.SZ') {
        return quoteResponse(symbol, [
          { date: '2026-10-16', raw_close: '10.50', close: '99', is_live: true },
        ]);
      }
      return quoteResponse(symbol, [
        { date: '2026-10-21', raw_close: '50', close: '1', is_live: true },
        { date: AS_OF, raw_close: '11.44', close: '99.99', is_live: true },
        { date: '2026-10-16', raw_close: '10.50', close: '1' },
      ]);
    },
  });

  const first = await fallback(['LIVE.SZ', 'LIVE.SZ', 'OLD.SZ', 'NONE.SZ'], AS_OF);
  assert.equal(urls.length, 3);
  assert.equal(new URL(urls[0]).searchParams.get('end_date'), AS_OF);
  assert.deepEqual(first.get('LIVE.SZ'), {
    cacheable: true,
    quote: { price: '11.44', price_as_of: AS_OF, price_status: 'fresh' },
  });
  assert.deepEqual(first.get('OLD.SZ'), {
    cacheable: true,
    quote: { price: '10.5', price_as_of: '2026-10-16', price_status: 'stale' },
  });
  assert.deepEqual(first.get('NONE.SZ'), { cacheable: true, quote: null });

  const cached = await fallback(['NONE.SZ', 'OLD.SZ', 'LIVE.SZ'], AS_OF);
  assert.equal(urls.length, 3);
  assert.deepEqual(cached.get('LIVE.SZ'), first.get('LIVE.SZ'));
  assert.deepEqual(cached.get('NONE.SZ'), { cacheable: true, quote: null });
  assert.equal(cached.get('OLD.SZ').quote.price_status, 'stale');

  nowMs = 60_000;
  const expired = await fallback(['LIVE.SZ'], '2026-10-19');
  assert.equal(urls.length, 4);
  assert.equal(new URL(urls[3]).searchParams.get('end_date'), '2026-10-19');
  assert.deepEqual(expired.get('LIVE.SZ'), {
    cacheable: true,
    quote: { price: '10.5', price_as_of: '2026-10-16', price_status: 'stale' },
  });
});
