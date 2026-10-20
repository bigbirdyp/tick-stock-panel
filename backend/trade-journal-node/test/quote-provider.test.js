import assert from 'node:assert/strict';
import test from 'node:test';

import { createDailyQuoteProvider } from '../src/quote-provider.js';

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

test('deadline cancels a fetch and a json body that ignore the signal', async () => {
  const { warnings, logger } = collectLogger();
  let fetchSignal;
  const hangingFetch = createDailyQuoteProvider({
    fetchImpl(_url, init) {
      fetchSignal = init.signal;
      return new Promise(() => {});
    },
    logger,
    timeoutMs: 10,
  });

  const fromFetch = await hangingFetch(['000001.SZ'], AS_OF);
  assert.equal(fromFetch.size, 0);
  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(warnings, [{ reason: 'timeout', status: null, count: 1 }]);

  warnings.length = 0;
  let jsonSignal;
  const hangingJson = createDailyQuoteProvider({
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
    timeoutMs: 10,
  });

  const fromJson = await hangingJson(['000001.SZ'], AS_OF);
  assert.equal(fromJson.size, 0);
  assert.equal(jsonSignal.aborted, true);
  assert.deepEqual(warnings, [{ reason: 'timeout', status: 200, count: 1 }]);
});

test('non-2xx aborts the error body and is not cached', async () => {
  const { warnings, logger } = collectLogger();
  const signals = [];
  let calls = 0;
  const provider = createDailyQuoteProvider({
    fetchImpl(_url, init) {
      calls += 1;
      signals.push(init.signal);
      return {
        ok: false,
        status: 500,
        json() {
          throw new Error('error body must stay unread');
        },
      };
    },
    logger,
    timeoutMs: 3000,
  });

  const first = await provider(['600519.SH'], AS_OF);
  const second = await provider(['600519.SH'], AS_OF);

  assert.equal(first.size, 0);
  assert.equal(second.size, 0);
  assert.equal(calls, 2);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(warnings, [
    { reason: 'http', status: 500, count: 1 },
    { reason: 'http', status: 500, count: 1 },
  ]);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('one successful POST is deduped and cached until 60s', async () => {
  let nowMs = 0;
  let calls = 0;
  const urls = [];
  const bodies = [];
  const payload = {
    data: {
      '000001.SZ': [
        { date: AS_OF, raw_close: '12.34', close: '11.11' },
      ],
      '600519.SH': [
        { date: '2026-10-16', raw_close: '1680.5', close: '1500' },
      ],
    },
  };
  const provider = createDailyQuoteProvider({
    baseUrl: 'http://market.example/',
    now: () => nowMs,
    fetchImpl(url, init) {
      calls += 1;
      urls.push(url);
      assert.equal(init.method, 'POST');
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json() {
          return payload;
        },
      };
    },
  });

  const first = await provider(['600519.SH', '000001.SZ', '600519.SH'], AS_OF);
  assert.equal(calls, 1);
  assert.deepEqual(urls, ['http://market.example/api/kline/daily-batch']);
  assert.deepEqual(bodies, [{
    symbols: ['600519.SH', '000001.SZ'],
    days: 5,
  }]);
  assert.equal(first.size, 2);
  assert.deepEqual(first.get('000001.SZ'), {
    price: '12.34',
    price_as_of: AS_OF,
    price_status: 'fresh',
  });
  assert.deepEqual(first.get('600519.SH'), {
    price: '1680.5',
    price_as_of: '2026-10-16',
    price_status: 'stale',
  });

  const shuffled = await provider(['000001.SZ', '600519.SH', '000001.SZ'], AS_OF);
  assert.equal(calls, 1);
  assert.deepEqual(shuffled.get('000001.SZ'), first.get('000001.SZ'));
  assert.deepEqual(shuffled.get('600519.SH'), first.get('600519.SH'));

  nowMs = 59999;
  const withinTtl = await provider(['000001.SZ', '600519.SH'], AS_OF);
  assert.equal(calls, 1);
  assert.equal(withinTtl.get('000001.SZ').price_status, 'fresh');
  assert.equal(withinTtl.get('600519.SH').price_status, 'stale');

  nowMs = 60000;
  const expired = await provider(['000001.SZ', '600519.SH', '000001.SZ'], AS_OF);
  assert.equal(calls, 2);
  assert.equal(urls[1], 'http://market.example/api/kline/daily-batch');
  assert.deepEqual(bodies[1], {
    symbols: ['000001.SZ', '600519.SH'],
    days: 5,
  });
  assert.deepEqual(expired.get('000001.SZ'), first.get('000001.SZ'));
  assert.deepEqual(expired.get('600519.SH'), first.get('600519.SH'));
});

test('a different asOf refetches and concurrent callers share one POST', async () => {
  let nowMs = 0;
  let calls = 0;
  const gate = deferred();
  const earlier = '2026-10-18';
  const payload = {
    data: {
      '000001.SZ': [
        { date: '2026-10-21', raw_close: '99.9', close: '80' },
        { date: AS_OF, raw_close: '12.34', close: '11.11' },
        { date: '2026-10-16', raw_close: '10.5', close: '9.9' },
      ],
    },
  };
  const provider = createDailyQuoteProvider({
    baseUrl: 'http://market.example',
    now: () => nowMs,
    fetchImpl() {
      calls += 1;
      return gate.promise.then(() => ({
        ok: true,
        status: 200,
        json() {
          return payload;
        },
      }));
    },
  });

  const left = provider(['000001.SZ', '000001.SZ'], AS_OF);
  const right = provider(['000001.SZ'], AS_OF);
  await Promise.resolve();
  assert.equal(calls, 1);

  gate.resolve();
  const [todayA, todayB] = await Promise.all([left, right]);
  assert.equal(calls, 1);
  const fresh = {
    price: '12.34',
    price_as_of: AS_OF,
    price_status: 'fresh',
  };
  assert.deepEqual(todayA.get('000001.SZ'), fresh);
  assert.deepEqual(todayB.get('000001.SZ'), fresh);

  const past = await provider(['000001.SZ'], earlier);
  assert.equal(calls, 2);
  assert.equal(past.size, 1);
  assert.deepEqual(past.get('000001.SZ'), {
    price: '10.5',
    price_as_of: '2026-10-16',
    price_status: 'stale',
  });
});
