import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDailyQuote } from '../src/daily-quotes.js';
import { decimalUnits } from '../src/money.js';

test('uses the as-of session raw_close and marks it fresh', () => {
  const quote = selectDailyQuote([
    { symbol: '600519.SH', date: '2026-10-16', open: 10, close: '99.5', raw_close: '10.50' },
  ], '2026-10-16');
  assert.deepEqual(quote, {
    price: '10.5',
    price_as_of: '2026-10-16',
    price_status: 'fresh',
  });
  assert.equal(decimalUnits(quote.price), decimalUnits('10.5'));
});

test('accepts a JSON number raw_close without adopting a different close', () => {
  const quote = selectDailyQuote([
    { date: '2026-10-16', raw_close: 12.34, close: 99 },
  ], '2026-10-16');
  assert.deepEqual(quote, {
    price: '12.34',
    price_as_of: '2026-10-16',
    price_status: 'fresh',
  });
  assert.equal(decimalUnits(quote.price), decimalUnits('12.34'));
});

test('weekend asOf reuses the previous session and stays stale', () => {
  // 2026-10-18 is Sunday. Friday 2026-10-16 is the last real session.
  const quote = selectDailyQuote([
    { date: '2026-10-16', raw_close: '8.08', close: '8.80' },
    { date: '2026-10-17', raw_close: '', close: '9' },
    { date: '2026-10-18', close: '9.10' },
  ], '2026-10-18');
  assert.deepEqual(quote, {
    price: '8.08',
    price_as_of: '2026-10-16',
    price_status: 'stale',
  });
});

test('a halted session with no bar reuses the previous raw close', () => {
  const quote = selectDailyQuote([
    { date: '2026-10-15', raw_close: '7.01', close: '1' },
    { date: '2026-10-19', close: '7.50' },
  ], '2026-10-19');
  assert.deepEqual(quote, {
    price: '7.01',
    price_as_of: '2026-10-15',
    price_status: 'stale',
  });
});

test('returns null for an empty list, future bars, or dates that are not calendar days', () => {
  const future = { date: '2026-10-20', raw_close: '10', close: '10' };
  assert.equal(selectDailyQuote([], '2026-10-16'), null);
  assert.equal(selectDailyQuote([future], '2026-10-16'), null);
  assert.equal(selectDailyQuote([
    { date: '2026-02-31', raw_close: '10' },
    { date: '2025-02-29', raw_close: '10' },
    { date: '1900-02-29', raw_close: '10' },
    { date: '2026-10-17T00:00:00Z', raw_close: '10' },
    { date: '20261016', raw_close: '10' },
    { date: '2026-4-16', raw_close: '10' },
    null,
    '2026-10-16',
  ], '2026-10-16'), null);
  assert.equal(selectDailyQuote([future], '2026-02-31'), null);
  assert.equal(selectDailyQuote(null, '2026-10-16'), null);
  assert.equal(selectDailyQuote([{ date: '2026-10-16', raw_close: '10' }], '2026-10-16T00:00:00Z'), null);
});

test('accepts a real leap day and ignores a non-leap February 29', () => {
  assert.deepEqual(
    selectDailyQuote([{ date: '2024-02-29', raw_close: '2.5', close: '9' }], '2024-02-29'),
    { price: '2.5', price_as_of: '2024-02-29', price_status: 'fresh' },
  );
  assert.deepEqual(
    selectDailyQuote([{ date: '2000-02-29', raw_close: '4' }], '2000-03-01'),
    { price: '4', price_as_of: '2000-02-29', price_status: 'stale' },
  );
});

test('prefers raw_close when close is a different number', () => {
  const quote = selectDailyQuote([
    { date: '2026-10-16', raw_close: '10.01', close: '10.80' },
  ], '2026-10-16');
  assert.deepEqual(quote, {
    price: '10.01',
    price_as_of: '2026-10-16',
    price_status: 'fresh',
  });
});

test('returns null when a bar only has forward-adjusted close', () => {
  assert.equal(selectDailyQuote([
    { date: '2026-10-16', close: '10.5' },
    { date: '2026-10-15', close: 10.5, raw_close: undefined },
  ], '2026-10-16'), null);
});

test('rejects prices that decimalUnits must not receive', () => {
  const asOf = '2026-10-16';
  const rejected = [
    undefined, null, true, false, '', ' ', 'NaN', 'Infinity', '-1', '0', '0.0',
    '1e2', '1E-2', '1.2e1', '+10', '10.', '.5', '1.123456789', '1000000.00000001',
    '1000001', '0x10', '1_000', {}, [], NaN, Infinity, -Infinity, 0, -1, 1000000.01,
    1e21, 1e-10,
  ];
  for (const raw_close of rejected) {
    assert.equal(
      selectDailyQuote([{ date: asOf, raw_close, close: '88.8' }], asOf),
      null,
      `rejected ${typeof raw_close}:${JSON.stringify(raw_close) ?? 'undefined'}`,
    );
  }
});

test('keeps a positive price on the 1e-8 yuan scale up to 1000000', () => {
  assert.deepEqual(
    selectDailyQuote([{ date: '2026-10-16', raw_close: '1000000.00000000' }], '2026-10-16'),
    { price: '1000000', price_as_of: '2026-10-16', price_status: 'fresh' },
  );
  assert.equal(
    selectDailyQuote([{ date: '2026-10-16', raw_close: '0.00000001' }], '2026-10-16'),
    null,
  );
  assert.equal(
    selectDailyQuote([{ date: '2026-10-16', raw_close: 1e-7, close: 9 }], '2026-10-16'),
    null,
  );
  const fine = selectDailyQuote([{ date: '2026-10-16', raw_close: 10.123456789, close: 1 }], '2026-10-16');
  assert.equal(fine.price, '10.12345679');
  assert.equal(decimalUnits(fine.price), decimalUnits('10.12345679'));
  assert.equal(decimalUnits('0.00000001'), 1n);
});

test('selects the newest valid raw close on or before asOf regardless of order', () => {
  const rows = [
    { date: '2026-10-14', raw_close: '14', close: '1' },
    { date: '2026-10-20', raw_close: '20', close: '2' },
    { date: '2026-10-15', raw_close: '15.5', close: '3' },
    { date: '2026-02-31', raw_close: '99', close: '4' },
    { date: '2026-10-16', raw_close: false, close: '16' },
    { date: '2026-10-13', raw_close: '13', close: '5' },
    null,
  ];
  const expected = { price: '15.5', price_as_of: '2026-10-15', price_status: 'stale' };
  assert.deepEqual(selectDailyQuote(rows, '2026-10-16'), expected);
  assert.deepEqual(selectDailyQuote([...rows].reverse(), '2026-10-16'), expected);
});

test('a later valid bar on the same date wins, and an invalid one does not erase it', () => {
  assert.equal(selectDailyQuote([
    { date: '2026-10-16', raw_close: '1', close: '9' },
    { date: '2026-10-16', raw_close: '2.5', close: '8' },
  ], '2026-10-16').price, '2.5');
  assert.deepEqual(selectDailyQuote([
    { date: '2026-10-16', raw_close: '1.25', close: '9' },
    { date: '2026-10-16', raw_close: '1e2', close: '8' },
  ], '2026-10-16'), {
    price: '1.25',
    price_as_of: '2026-10-16',
    price_status: 'fresh',
  });
});
