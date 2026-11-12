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

test('a newer qfq-only bar gets that day raw and does not keep the older batch quote', async () => {
  const calls = [];
  const provider = createDailyQuoteProvider({
    baseUrl: 'http://market.example',
    fetchImpl(url, init) {
      calls.push({ url, method: init.method });
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json() {
            return {
              data: {
                '000001.SZ': [
                  { date: '2026-10-21', raw_close: '99.9', close: '80' },
                  { date: AS_OF, close: '11.11' },
                  { date: '2026-10-16', raw_close: '10.5', close: '9.9' },
                ],
                '600519.SH': [
                  { date: '2026-10-21', raw_close: '1700', close: '1600' },
                  { date: AS_OF, raw_close: '1680.5', close: '1500' },
                ],
              },
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json() {
          return {
            symbol: '000001.SZ',
            rows: [
              { date: '2026-10-21', raw_close: '99.9', close: '88' },
              { date: AS_OF, raw_close: '12.34', close: '13.13' },
              { date: '2026-10-16', raw_close: '10.5', close: '9.9' },
            ],
          };
        },
      };
    },
  });

  const quotes = await provider(['000001.SZ', '600519.SH'], AS_OF);

  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
  assert.equal(calls[0].url, 'http://market.example/api/kline/daily-batch');
  assert.equal(
    calls[1].url,
    'http://market.example/api/kline/daily?symbol=000001.SZ&end_date=2026-10-20&days=120',
  );
  assert.equal(quotes.size, 2);
  assert.deepEqual(quotes.get('000001.SZ'), {
    price: '12.34',
    price_as_of: AS_OF,
    price_status: 'fresh',
  });
  assert.equal(quotes.get('600519.SH').price, '1680.5');
  assert.equal(quotes.get('600519.SH').price_as_of, AS_OF);
  assert.equal(quotes.get('600519.SH').price_status, 'fresh');
});

test('one failed GET drops only that symbol and the next call retries it', async () => {
  let posts = 0;
  const gets = [];
  const provider = createDailyQuoteProvider({
    baseUrl: 'http://market.example',
    now: () => 0,
    logger: { warn() {} },
    fetchImpl(url, init) {
      if (init.method === 'POST') {
        posts += 1;
        return {
          ok: true,
          status: 200,
          json() {
            return {
              data: {
                '600000.SH': [
                  { date: AS_OF, raw_close: '21.08', close: '18.01' },
                ],
                '000001.SZ': [
                  { date: AS_OF, close: '7.77' },
                ],
                '000002.SZ': [
                  { date: AS_OF, close: '4.44' },
                ],
              },
            };
          },
        };
      }
      const symbol = new URL(url).searchParams.get('symbol');
      gets.push(symbol);
      if (symbol === '000002.SZ' && gets.filter((item) => item === '000002.SZ').length === 1) {
        return {
          ok: false,
          status: 500,
          json() {
            throw new Error('error body must stay unread');
          },
        };
      }
      const raw = symbol === '000001.SZ' ? '8.88' : '3.33';
      const close = symbol === '000001.SZ' ? '1.11' : '9.99';
      return {
        ok: true,
        status: 200,
        json() {
          return {
            symbol,
            rows: [{ date: AS_OF, raw_close: raw, close }],
          };
        },
      };
    },
  });

  const symbols = ['600000.SH', '000001.SZ', '000002.SZ'];
  const first = await provider(symbols, AS_OF);
  assert.equal(posts, 1);
  assert.deepEqual(gets, ['000001.SZ', '000002.SZ']);
  assert.equal(first.size, 2);
  assert.equal(first.has('000002.SZ'), false);
  assert.deepEqual(first.get('600000.SH'), {
    price: '21.08',
    price_as_of: AS_OF,
    price_status: 'fresh',
  });
  assert.deepEqual(first.get('000001.SZ'), {
    price: '8.88',
    price_as_of: AS_OF,
    price_status: 'fresh',
  });

  const second = await provider(symbols, AS_OF);
  assert.equal(posts, 1);
  assert.deepEqual(gets, ['000001.SZ', '000002.SZ', '000002.SZ']);
  assert.equal(second.size, 3);
  assert.deepEqual(second.get('600000.SH'), first.get('600000.SH'));
  assert.deepEqual(second.get('000001.SZ'), first.get('000001.SZ'));
  assert.deepEqual(second.get('000002.SZ'), {
    price: '3.33',
    price_as_of: AS_OF,
    price_status: 'fresh',
  });
});

test('a changed position set does not renew an older quote through the batch cache', async () => {
  const A = '000001.SZ';
  const B = '600519.SH';
  let nowMs = 0;
  const posts = [];
  const gets = [];
  const qfqClose = { [A]: '9.01', [B]: '19.01' };
  const raws = { [A]: ['10', '11'], [B]: ['20', '21'] };
  const used = { [A]: 0, [B]: 0 };
  const provider = createDailyQuoteProvider({
    baseUrl: 'http://market.example',
    now: () => nowMs,
    fetchImpl(url, init) {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ url, status: 200, symbols: body.symbols });
        const data = {};
        for (const symbol of body.symbols) {
          data[symbol] = [{ date: AS_OF, close: qfqClose[symbol] }];
        }
        return {
          ok: true,
          status: 200,
          json() {
            return { data };
          },
        };
      }
      const symbol = new URL(url).searchParams.get('symbol');
      const raw = raws[symbol][used[symbol]];
      used[symbol] += 1;
      gets.push({ url, status: 200, symbol, raw });
      return {
        ok: true,
        status: 200,
        json() {
          return {
            symbol,
            rows: [{ date: AS_OF, raw_close: raw, close: qfqClose[symbol] }],
          };
        },
      };
    },
  });

  const quote = (price) => ({
    price,
    price_as_of: AS_OF,
    price_status: 'fresh',
  });
  const getUrl = (symbol) => (
    `http://market.example/api/kline/daily?symbol=${symbol}&end_date=${AS_OF}&days=120`
  );

  const alone = await provider([A], AS_OF);
  assert.deepEqual(posts, [{
    url: 'http://market.example/api/kline/daily-batch',
    status: 200,
    symbols: [A],
  }]);
  assert.deepEqual(gets, [{ url: getUrl(A), status: 200, symbol: A, raw: '10' }]);
  assert.equal(alone.size, 1);
  assert.deepEqual(alone.get(A), quote('10'));
  assert.notEqual(alone.get(A).price, qfqClose[A]);

  nowMs = 59000;
  const widened = await provider([A, B], AS_OF);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], {
    url: 'http://market.example/api/kline/daily-batch',
    status: 200,
    symbols: [A, B],
  });
  assert.deepEqual(gets, [
    { url: getUrl(A), status: 200, symbol: A, raw: '10' },
    { url: getUrl(B), status: 200, symbol: B, raw: '20' },
  ]);
  assert.deepEqual(widened.get(A), quote('10'));
  assert.deepEqual(widened.get(B), quote('20'));
  assert.notEqual(widened.get(B).price, qfqClose[B]);

  nowMs = 59999;
  const held = await provider([A, B], AS_OF);
  assert.equal(posts.length, 2);
  assert.equal(gets.length, 2);
  assert.deepEqual(held.get(A), quote('10'));
  assert.deepEqual(held.get(B), quote('20'));

  nowMs = 60000;
  const refreshed = await provider([A, B], AS_OF);
  assert.equal(posts.length, 2);
  assert.deepEqual(gets, [
    { url: getUrl(A), status: 200, symbol: A, raw: '10' },
    { url: getUrl(B), status: 200, symbol: B, raw: '20' },
    { url: getUrl(A), status: 200, symbol: A, raw: '11' },
  ]);
  assert.equal(gets.filter((call) => call.symbol === B).length, 1);
  assert.deepEqual(refreshed.get(A), quote('11'));
  assert.deepEqual(refreshed.get(B), quote('20'));
});
