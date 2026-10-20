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
