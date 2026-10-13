import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { journalPort } from '../src/config.js';
import { sortPositions } from '../src/positions.js';
import { createApp } from '../src/server.js';
import { JournalStore } from '../src/store.js';
import { recordInput } from '../src/validation.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function harness(t, initialState) {
  const directory = mkdtempSync(join(tmpdir(), 'trade-journal-test-'));
  const filePath = join(directory, 'journal.json');
  if (initialState !== undefined) writeFileSync(filePath, JSON.stringify(initialState));
  const store = new JournalStore(filePath);
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body, options = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: options.headers ?? (body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const raw = await response.text();
    return {
      status: response.status,
      body: raw ? JSON.parse(raw) : null,
      raw,
      contentType: response.headers.get('content-type'),
    };
  }
  return { request, store, filePath, directory };
}

const trade = (overrides = {}) => ({
  trader: '示例',
  trade_date: '2025-01-06', code: '600519', name: '贵州茅台', side: 'buy', price: 10,
  quantity: 100, fee: 5, ...overrides,
});

test('rejects malformed JSON, unsupported media, invalid dates/codes, and out-of-range pagination', async (t) => {
  const { request } = await harness(t);
  const badJson = await request('POST', '/api/records', undefined, { headers: { 'Content-Type': 'application/json' }, raw: '{' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'BAD_REQUEST');
  const media = await request('POST', '/api/reviews', { date: '2025-01-06', content: 'x' }, { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(media.status, 400);
  const date = await request('POST', '/api/records', trade({ trade_date: '2026-02-29' }));
  assert.equal(date.status, 422);
  assert.equal(date.body.error.details.fields[0].path, 'trade_date');
  const code = await request('POST', '/api/records', trade({ code: '999999' }));
  assert.equal(code.status, 422);
  assert.equal(code.body.error.code, 'INVALID_STOCK_CODE');
  const symbol = await request('POST', '/api/records', trade({ symbol: '600519.SZ' }));
  assert.equal(symbol.body.error.code, 'VALIDATION_ERROR');
  const limit = await request('GET', '/api/records?limit=201');
  assert.equal(limit.status, 422);
  assert.equal(limit.body.error.details.fields[0].path, 'limit');
  const fractional = await request('POST', '/api/records', trade({ price: 10.12345 }));
  assert.equal(fractional.status, 422);
  assert.equal(fractional.body.error.details.fields[0].path, 'price');
  const identity = await request('POST', '/api/records', trade({ owner_id: 'someone' }));
  assert.equal(identity.body.error.code, 'VALIDATION_ERROR');
  const missingTrader = await request('POST', '/api/records', {
    trade_date: '2025-01-06', code: '600519', name: '贵州茅台', side: 'buy', price: 10, quantity: 100,
  });
  assert.equal(missingTrader.status, 422);
  assert.equal(missingTrader.body.error.details.fields[0].path, 'trader');
  assert.equal(missingTrader.body.error.details.fields[0].message, '必填');
  const blankTrader = await request('POST', '/api/records', trade({ trader: ' \n ' }));
  assert.equal(blankTrader.status, 422);
  assert.equal(blankTrader.body.error.details.fields[0].path, 'trader');
  const dates = await request('GET', '/api/reviews?from=2025-02-01&to=2025-01-01');
  assert.equal(dates.body.error.code, 'INVALID_DATE');
});

test('idempotent creates, lifecycle, version conflict, and persistence survive restart', async (t) => {
  const { request, filePath } = await harness(t);
  const input = trade({ client_request_id: '__proto__' });
  const created = await request('POST', '/api/records', input);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.trader, '示例');
  assert.equal(created.body.data.symbol, '600519.SH');
  assert.equal(created.body.data.version, 1);
  assert.equal(created.body.data.trade_time, null);
  const duplicate = await request('POST', '/api/records', input);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.meta.duplicate, true);
  assert.equal(duplicate.body.data.id, created.body.data.id);
  const collision = await request('POST', '/api/records', { ...input, price: 11 });
  assert.equal(collision.status, 409);
  assert.equal(collision.body.error.code, 'DUPLICATE_RECORD');
  const id = created.body.data.id;
  const detail = await request('GET', `/api/records/${id}`);
  assert.equal(detail.body.data.id, id);
  const missingPrecondition = await request('PATCH', `/api/records/${id}`, { note: 'x' });
  assert.equal(missingPrecondition.status, 428);
  const patched = await request('PATCH', `/api/records/${id}`, { expected_version: 1, price: 10.25 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.version, 2);
  assert.equal(patched.body.data.price, 10.25);
  assert.equal((await request('PATCH', `/api/records/${id}`, { expected_version: 1, note: 'stale' })).body.error.code, 'VERSION_CONFLICT');
  const reloaded = new JournalStore(filePath);
  assert.equal(reloaded.getRecord(id).price, 10.25);
  const replayed = reloaded.createRecord(recordInput(input));
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.record.price, 10.25);
  assert.equal(replayed.record.version, 2);
  assert.equal((await request('DELETE', `/api/records/${id}`)).status, 428);
  assert.equal((await request('DELETE', `/api/records/${id}?expected_version=1`)).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await request('DELETE', `/api/records/${id}?expected_version=2`)).status, 204);
  assert.equal((await request('GET', `/api/records/${id}`)).status, 404);
  const empty = await request('GET', '/api/records');
  assert.deepEqual(empty.body.data.pagination, { limit: 50, offset: 0, total: 0, has_more: false });
});

test('FIFO aggregates two buy lots into one sell row and keeps exact remaining cost', async (t) => {
  const { request } = await harness(t);
  const first = await request('POST', '/api/records', trade({ price: 10, fee: 5 }));
  const second = await request('POST', '/api/records', trade({ trade_date: '2025-01-07', price: 12, fee: 5 }));
  const sell = await request('POST', '/api/records', trade({ trade_date: '2025-01-08', side: 'sell', quantity: 150, price: 15, fee: 3, tax: 2 }));
  assert.equal(sell.status, 201);
  const history = await request('GET', '/api/positions/history');
  assert.equal(history.body.data.pagination.total, 1);
  const row = history.body.data.history[0];
  assert.equal(row.sell_record_id, sell.body.data.id);
  assert.deepEqual(row.buy_record_ids, [first.body.data.id, second.body.data.id]);
  assert.equal(row.cost_amount, 1607.5);
  assert.equal(row.exit_amount, 2245);
  assert.equal(row.realized_pnl, 637.5);
  assert.equal(row.return_rate, 0.396579);
  assert.equal(row.holding_days, 2);
  const current = await request('GET', '/api/positions/current?as_of=2025-01-08');
  assert.equal(current.body.data.positions[0].quantity, 50);
  assert.equal(current.body.data.positions[0].cost_amount, 602.5);
  assert.equal(current.body.data.positions[0].cost, 12.05);
  assert.equal(current.body.data.positions[0].price_status, 'unavailable');
  assert.equal(current.body.data.positions[0].market_value, null);
  const earlier = await request('GET', '/api/positions/current?as_of=2025-01-06');
  assert.equal(earlier.body.data.positions[0].quantity, 100);
  assert.equal(earlier.body.data.positions[0].cost_amount, 1005);
});

test('history pnl rounds the exact exit-minus-cost difference, not the rounded amounts', async (t) => {
  const { request } = await harness(t);
  const buy = await request('POST', '/api/records', trade({ price: 10.005, quantity: 1, fee: 0, tax: 0 }));
  const sell = await request('POST', '/api/records', trade({
    trade_date: '2025-01-07', side: 'sell', price: 10.014, quantity: 1, fee: 0, tax: 0,
  }));
  assert.equal(buy.status, 201);
  assert.equal(sell.status, 201);
  const history = await request('GET', '/api/positions/history');
  const row = history.body.data.history[0];
  assert.equal(row.cost_amount, 10.01);
  assert.equal(row.exit_amount, 10.01);
  assert.equal(row.cost, 10.005);
  assert.equal(row.realized_pnl, 0.01);
  assert.equal(row.return_rate, 0.0009);
  assert.deepEqual((await request('GET', '/api/positions/current?as_of=2025-01-07')).body.data.positions, []);
});

test('cost rounds exact internal amount per share, including after the lot is closed', async (t) => {
  const { request } = await harness(t);
  const buy = await request('POST', '/api/records', trade({ price: 10.0001, quantity: 3, fee: 0, tax: 0 }));
  assert.equal(buy.status, 201);
  const open = await request('GET', '/api/positions/current?as_of=2025-01-06');
  assert.equal(open.body.data.positions[0].quantity, 3);
  assert.equal(open.body.data.positions[0].cost_amount, 30);
  assert.equal(open.body.data.positions[0].cost, 10.0001);
  const sell = await request('POST', '/api/records', trade({
    trade_date: '2025-01-07', side: 'sell', price: 11, quantity: 3, fee: 0, tax: 0,
  }));
  assert.equal(sell.status, 201);
  const row = (await request('GET', '/api/positions/history')).body.data.history[0];
  assert.equal(row.cost_amount, 30);
  assert.equal(row.cost, 10.0001);
  assert.equal(row.realized_pnl, 3);
  assert.equal(row.return_rate, 0.099989);
  assert.deepEqual((await request('GET', '/api/positions/current?as_of=2025-01-07')).body.data.positions, []);
});

test('no-short is checked over the entire chronological path on create, patch, and delete', async (t) => {
  const { request } = await harness(t);
  const buy = await request('POST', '/api/records', trade());
  const sell = await request('POST', '/api/records', trade({ trade_date: '2025-01-07', side: 'sell', quantity: 80 }));
  assert.equal(sell.status, 201);
  const earlySell = await request('POST', '/api/records', trade({ trade_date: '2025-01-05', side: 'sell', quantity: 1 }));
  assert.equal(earlySell.body.error.code, 'INSUFFICIENT_POSITION');
  const patch = await request('PATCH', `/api/records/${buy.body.data.id}`, { expected_version: 1, quantity: 70 });
  assert.equal(patch.body.error.code, 'INSUFFICIENT_POSITION');
  const deleted = await request('DELETE', `/api/records/${buy.body.data.id}?expected_version=1`);
  assert.equal(deleted.body.error.code, 'INSUFFICIENT_POSITION');
  assert.equal((await request('GET', `/api/records/${buy.body.data.id}`)).body.data.quantity, 100);
  assert.equal((await request('GET', '/api/records')).body.data.pagination.total, 2);
});

test('simultaneous edits of the same version serialize: one succeeds and one conflicts', async (t) => {
  const { request } = await harness(t);
  const created = await request('POST', '/api/records', trade());
  const id = created.body.data.id;
  const results = await Promise.all([
    request('PATCH', `/api/records/${id}`, { expected_version: 1, note: 'A' }),
    request('PATCH', `/api/records/${id}`, { expected_version: 1, note: 'B' }),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
  assert.equal(results.find((item) => item.status === 409).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await request('GET', `/api/records/${id}`)).body.data.version, 2);
});

test('simultaneous POST with the same request key creates only one record', async (t) => {
  const { request } = await harness(t);
  const input = trade({ client_request_id: 'retry-key' });
  const results = await Promise.all([
    request('POST', '/api/records', input),
    request('POST', '/api/records', { ...input, tax: 0, note: null }),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 201]);
  assert.equal(results[0].body.data.id, results[1].body.data.id);
  assert.equal((await request('GET', '/api/records')).body.data.pagination.total, 1);
});

test('records/reviews filter, paginate, and sort deterministically with null trade time last', async (t) => {
  const { request } = await harness(t);
  const a = await request('POST', '/api/records', trade({ trade_time: null }));
  const laterNull = await request('POST', '/api/records', trade({ trade_time: null }));
  const b = await request('POST', '/api/records', trade({ trade_time: '10:00:00' }));
  const c = await request('POST', '/api/records', trade({ trade_time: '11:00:00', code: '000001', name: '平安银行' }));
  const asc = await request('GET', '/api/records?sort=trade_date_asc&limit=2&offset=0');
  assert.deepEqual(asc.body.data.records.map((item) => item.id), [b.body.data.id, c.body.data.id]);
  assert.deepEqual(asc.body.data.pagination, { limit: 2, offset: 0, total: 4, has_more: true });
  const ascNull = await request('GET', '/api/records?sort=trade_date_asc&offset=2');
  assert.deepEqual(ascNull.body.data.records.map((item) => item.id), [a.body.data.id, laterNull.body.data.id]);
  const desc = await request('GET', '/api/records?sort=trade_date_desc&offset=2');
  assert.deepEqual(desc.body.data.records.map((item) => item.id), [laterNull.body.data.id, a.body.data.id]);
  const filtered = await request('GET', '/api/records?code=000001&side=buy');
  assert.equal(filtered.body.data.pagination.total, 1);
  const review = await request('POST', '/api/reviews', { date: '2025-01-06', content: '首次复盘', tags: ['观察'] });
  assert.equal(review.status, 201);
  assert.equal((await request('POST', '/api/reviews', { date: '2025-01-06', content: '重复' })).body.error.code, 'DUPLICATE_REVIEW');
  const id = review.body.data.id;
  assert.equal((await request('GET', '/api/reviews?tag=观察')).body.data.pagination.total, 1);
  assert.equal((await request('GET', `/api/reviews/${id}`)).body.data.content, '首次复盘');
  assert.equal((await request('PATCH', `/api/reviews/${id}`, { content: '遗漏版本' })).status, 428);
  const patched = await request('PATCH', `/api/reviews/${id}`, { expected_version: 1, content: '修订复盘' });
  assert.equal(patched.body.data.version, 2);
  assert.equal((await request('PATCH', `/api/reviews/${id}`, { expected_version: 1, tags: [] })).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await request('DELETE', `/api/reviews/${id}?expected_version=2`)).status, 204);
  assert.equal((await request('GET', '/api/reviews')).body.data.pagination.total, 0);
});

test('failed file replacement leaves both disk and memory at their previous state', async (t) => {
  const { request, store, filePath, directory } = await harness(t);
  await request('POST', '/api/records', trade());
  const priorFile = readFileSync(filePath, 'utf8');
  const blocked = join(directory, 'directory-in-place-of-file');
  mkdirSync(blocked);
  store.filePath = blocked;
  const failed = await request('POST', '/api/records', trade({ code: '000001', name: '平安银行' }));
  store.filePath = filePath;
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'INTERNAL_ERROR');
  assert.equal(readFileSync(filePath, 'utf8'), priorFile);
  assert.equal((await request('GET', '/api/records')).body.data.pagination.total, 1);
});

test('PATCH moving a sell between symbols rebuilds both FIFO paths', async (t) => {
  const { request } = await harness(t);
  const sourceBuy = await request('POST', '/api/records', trade({ trade_time: '09:30:00', price: 10, quantity: 100, fee: 5 }));
  const sourceSell = await request('POST', '/api/records', trade({
    trade_date: '2025-01-08', trade_time: '14:00:00', side: 'sell', price: 15, quantity: 40, fee: 1, tax: 0,
  }));
  const consumedLot = await request('POST', '/api/records', trade({
    trade_date: '2025-01-05', trade_time: '09:30:00', code: '000001', name: '平安银行', price: 8, quantity: 40, fee: 0,
  }));
  const remainderLot = await request('POST', '/api/records', trade({
    trade_date: '2025-01-07', trade_time: '09:30:00', code: '000001', name: '平安银行', price: 10.0001, quantity: 3, fee: 0,
  }));
  assert.equal(sourceBuy.status, 201);
  assert.equal(sourceSell.status, 201);
  assert.equal((await request('GET', '/api/positions/history?code=600519')).body.data.pagination.total, 1);
  assert.equal((await request('GET', '/api/positions/current?as_of=2025-01-08&code=600519')).body.data.positions[0].quantity, 60);

  const moved = await request('PATCH', `/api/records/${sourceSell.body.data.id}`, {
    expected_version: 1, code: '000001', name: '平安银行',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.version, 2);
  assert.equal(moved.body.data.symbol, '000001.SZ');
  assert.equal(moved.body.data.code, '000001');

  const sourceHistory = await request('GET', '/api/positions/history?code=600519');
  assert.equal(sourceHistory.body.data.pagination.total, 0);
  const sourcePosition = (await request('GET', '/api/positions/current?as_of=2025-01-08&code=600519')).body.data.positions[0];
  assert.equal(sourcePosition.quantity, 100);
  assert.equal(sourcePosition.cost_amount, 1005);
  assert.equal(sourcePosition.cost, 10.05);

  const destinationHistory = await request('GET', '/api/positions/history?code=000001');
  assert.equal(destinationHistory.body.data.pagination.total, 1);
  const row = destinationHistory.body.data.history[0];
  assert.equal(row.sell_record_id, sourceSell.body.data.id);
  assert.deepEqual(row.buy_record_ids, [consumedLot.body.data.id]);
  assert.equal(row.symbol, '000001.SZ');
  assert.equal(row.quantity, 40);
  assert.equal(row.cost_amount, 320);
  assert.equal(row.cost, 8);
  assert.equal(row.exit_amount, 599);
  assert.equal(row.realized_pnl, 279);
  assert.equal(row.return_rate, 0.871875);
  assert.equal(row.open_date, '2025-01-05');
  assert.equal(row.holding_days, 3);

  const destination = (await request('GET', '/api/positions/current?as_of=2025-01-08&code=000001')).body.data.positions[0];
  assert.equal(destination.quantity, 3);
  assert.equal(destination.trader, '示例');
  assert.equal(destination.position_key, '示例\u001f000001.SZ');
  assert.equal(destination.open_date, '2025-01-07');
  assert.equal(destination.cost_amount, 30);
  assert.equal(destination.cost, 10.0001);
  assert.equal((await request('GET', `/api/records/${remainderLot.body.data.id}`)).body.data.symbol, '000001.SZ');
});

test('PATCH that would short either symbol leaves both FIFO paths unchanged', async (t) => {
  const { request } = await harness(t);
  const buy = await request('POST', '/api/records', trade({ quantity: 100, price: 10, fee: 0 }));
  const sell = await request('POST', '/api/records', trade({
    trade_date: '2025-01-08', side: 'sell', quantity: 40, price: 11, fee: 0,
  }));
  const other = await request('POST', '/api/records', trade({
    code: '000001', name: '平安银行', quantity: 30, price: 8, fee: 0,
  }));
  const beforeSource = await request('GET', '/api/positions/current?as_of=2025-01-08&code=600519');
  const beforeOther = await request('GET', '/api/positions/current?as_of=2025-01-08&code=000001');
  const beforeHistory = await request('GET', '/api/positions/history?code=600519');

  const rejected = await request('PATCH', `/api/records/${sell.body.data.id}`, { expected_version: 1, code: '000001' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'INSUFFICIENT_POSITION');
  assert.equal((await request('GET', `/api/records/${sell.body.data.id}`)).body.data.code, '600519');
  assert.equal((await request('GET', `/api/records/${sell.body.data.id}`)).body.data.version, 1);
  assert.equal((await request('GET', `/api/records/${buy.body.data.id}`)).body.data.version, 1);
  assert.equal((await request('GET', `/api/records/${other.body.data.id}`)).body.data.version, 1);
  assert.deepEqual(
    (await request('GET', '/api/positions/current?as_of=2025-01-08&code=600519')).body.data.positions,
    beforeSource.body.data.positions,
  );
  assert.deepEqual(
    (await request('GET', '/api/positions/current?as_of=2025-01-08&code=000001')).body.data.positions,
    beforeOther.body.data.positions,
  );
  assert.deepEqual(
    (await request('GET', '/api/positions/history?code=600519')).body.data.history,
    beforeHistory.body.data.history,
  );
  assert.equal((await request('GET', '/api/positions/history?code=000001')).body.data.pagination.total, 0);
});

test('invalid JSON root types and unknown or mistyped query parameters use contract error codes', async (t) => {
  const { request } = await harness(t);
  for (const raw of ['[]', 'null', '1', '"600519"', 'true']) {
    const response = await request('POST', '/api/records', undefined, {
      headers: { 'Content-Type': 'application/json' }, raw,
    });
    assert.equal(response.status, 422, raw);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(response.body.error.details.fields[0].path, '$');
  }
  const syntax = await request('POST', '/api/records', undefined, {
    headers: { 'Content-Type': 'application/json' }, raw: '{',
  });
  assert.equal(syntax.status, 400);
  assert.equal(syntax.body.error.code, 'BAD_REQUEST');
  const unknown = await request('GET', '/api/records?page=1');
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.code, 'VALIDATION_ERROR');
  assert.equal(unknown.body.error.details.fields[0].path, 'page');
  const mistyped = await request('GET', '/api/records?limit=abc');
  assert.equal(mistyped.status, 422);
  assert.equal(mistyped.body.error.details.fields[0].path, 'limit');
  const repeated = await request('GET', '/api/reviews?offset=0&offset=1');
  assert.equal(repeated.status, 422);
  assert.equal(repeated.body.error.details.fields[0].path, 'offset');
  const wrongSort = await request('GET', '/api/positions/history?sort=trade_date_desc');
  assert.equal(wrongSort.status, 422);
  assert.equal(wrongSort.body.error.details.fields[0].path, 'sort');
  const wrongResource = await request('GET', '/api/positions/current?side=buy');
  assert.equal(wrongResource.status, 422);
  assert.equal(wrongResource.body.error.details.fields[0].path, 'side');
});

test('current positions serve the dev query, an empty book, unavailable quotes, and every contract sort', async (t) => {
  const { request } = await harness(t);
  const exact = await request('GET', '/api/positions/current?as_of=2026-10-12&limit=20&offset=0&sort=symbol_asc');
  assert.equal(exact.status, 200);
  assert.equal(exact.contentType, 'application/json; charset=utf-8');
  assert.equal(exact.body.error, undefined);
  assert.equal(exact.body.data.as_of, '2026-10-12');
  assert.deepEqual(exact.body.data.positions, []);
  assert.deepEqual(exact.body.data.pagination, { limit: 20, offset: 0, total: 0, has_more: false });

  assert.equal((await request('POST', '/api/records', trade({ trade_date: '2026-10-10', code: '600519', name: '贵州茅台' }))).status, 201);
  assert.equal((await request('POST', '/api/records', trade({ trade_date: '2026-10-10', code: '000001', name: '平安银行' }))).status, 201);
  const beforeOpen = await request('GET', '/api/positions/current?as_of=2026-10-09&limit=20&offset=0&sort=symbol_asc');
  assert.equal(beforeOpen.status, 200);
  assert.deepEqual(beforeOpen.body.data.positions, []);

  for (const sort of ['symbol_asc', 'market_value_desc', 'return_rate_desc']) {
    const response = await request('GET', `/api/positions/current?as_of=2026-10-12&limit=20&offset=0&sort=${sort}`);
    assert.equal(response.status, 200, sort);
    const positions = response.body.data.positions;
    assert.deepEqual(positions.map((row) => row.symbol), ['000001.SZ', '600519.SH'], sort);
    assert.deepEqual(response.body.data.pagination, { limit: 20, offset: 0, total: 2, has_more: false });
    for (const row of positions) {
      assert.equal(row.trader, '示例');
      assert.equal(row.position_key, `${row.trader}\u001f${row.symbol}`);
      assert.equal(row.open_date, '2026-10-10');
      assert.equal(row.quantity, 100);
      assert.equal(row.cost_amount, 1005);
      assert.equal(row.cost, 10.05);
      assert.equal(row.price_status, 'unavailable');
      assert.equal(row.current_price, null);
      assert.equal(row.price_source, null);
      assert.equal(row.price_as_of, null);
      assert.equal(row.market_value, null);
      assert.equal(row.unrealized_pnl, null);
      assert.equal(row.return_rate, null);
    }
    assert.equal(positions.find((row) => row.code === '000001').name, '平安银行');
    assert.equal(positions.find((row) => row.code === '600519').name, '贵州茅台');
  }
});

test('current position sorts place null market value and return rate last', () => {
  const row = (symbol, positionKey, marketValue, returnRate) => ({
    symbol, position_key: positionKey, market_value: marketValue, return_rate: returnRate,
  });
  const rows = [
    row('600519.SH', '600519.SH', null, null),
    row('000001.SZ', '000001.SZ', 1000, 0.01),
    row('300750.SZ', '300750.SZ', 5000, -0.02),
    row('601318.SH', '601318.SH', 1000, 0.2),
    row('000002.SZ', '000002.SZ', null, null),
    row('601398.SH', '601398.SH', 2000, 0),
  ];
  assert.deepEqual(sortPositions(rows, 'symbol_asc').map((item) => item.symbol), [
    '000001.SZ', '000002.SZ', '300750.SZ', '600519.SH', '601318.SH', '601398.SH',
  ]);
  assert.deepEqual(sortPositions(rows, 'market_value_desc').map((item) => item.symbol), [
    '300750.SZ', '601398.SH', '000001.SZ', '601318.SH', '000002.SZ', '600519.SH',
  ]);
  assert.deepEqual(sortPositions(rows, 'return_rate_desc').map((item) => item.symbol), [
    '601318.SH', '000001.SZ', '601398.SH', '300750.SZ', '000002.SZ', '600519.SH',
  ]);
  const tied = [
    row('600519.SH', 'lot-b', 1000, 0.1),
    row('600519.SH', 'lot-a', 1000, 0.1),
  ];
  assert.deepEqual(sortPositions(tied, 'market_value_desc').map((item) => item.position_key), ['lot-a', 'lot-b']);
  assert.deepEqual(sortPositions(tied, 'return_rate_desc').map((item) => item.position_key), ['lot-a', 'lot-b']);
  const byTrader = [
    { symbol: '600519.SH', trader: 'a', position_key: 'a\u001f600519.SH', market_value: 1, return_rate: 0.1 },
    { symbol: '600519.SH', trader: 'Z', position_key: 'Z\u001f600519.SH', market_value: 1, return_rate: 0.1 },
  ];
  assert.deepEqual(sortPositions(byTrader, 'symbol_asc').map((item) => item.trader), ['Z', 'a']);
});

test('journal listen port stays on the contract default when ambient PORT is taken', () => {
  assert.equal(journalPort({ PORT: '3457' }), 3022);
  assert.equal(journalPort({ PORT: '3018', TRADE_JOURNAL_PORT: '' }), 3022);
  assert.equal(journalPort({ TRADE_JOURNAL_PORT: '3023' }), 3023);
  assert.throws(() => journalPort({ TRADE_JOURNAL_PORT: '0' }), /TRADE_JOURNAL_PORT/);
  assert.throws(() => journalPort({ TRADE_JOURNAL_PORT: '65536' }), /TRADE_JOURNAL_PORT/);
});

test('seed command is idempotent and produces current/history/review fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-journal-seed-test-'));
  try {
    const filePath = join(directory, 'journal.json');
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = spawnSync(process.execPath, ['src/seed.js'], {
        cwd: packageRoot,
        env: { ...process.env, TRADE_JOURNAL_DATA_FILE: filePath },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
    }
    const store = new JournalStore(filePath);
    assert.equal(store.state.records.length, 3);
    assert.equal(store.state.reviews.length, 1);
    assert.deepEqual(store.listTraders(), { traders: [{ trader: '示例', record_count: 3 }] });
    assert.equal(store.current({ as_of: '2025-01-08', limit: 50, offset: 0, sort: 'symbol_asc' }).positions[0].quantity, 50);
    assert.equal(store.history({ limit: 50, offset: 0, sort: 'close_date_desc' }).history.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function legacyRecord(fields) {
  return {
    trade_time: null, fee: '0', tax: '0', note: null, version: 1,
    created_at: '2025-01-06T09:00:00+08:00', updated_at: '2025-01-06T09:00:00+08:00',
    ...fields,
  };
}

function legacyFingerprint(record) {
  return JSON.stringify([
    record.trade_date, record.trade_time, record.code, record.symbol, record.name,
    record.side, record.price, record.quantity, record.fee, record.tax,
    record.note, record.client_request_id,
  ]);
}

test('v1 journal migrates traders and creation fingerprints without rewriting economics', async (t) => {
  const review = {
    id: 'rev_keep', version: 4, date: '2025-01-08', content: '保留复盘', tags: ['复盘'],
    created_at: '2025-01-08T20:00:00+08:00', updated_at: '2025-01-08T21:00:00+08:00',
  };
  const yang = legacyRecord({
    id: 'rec_yang', version: 3, trader: '  杨鹏  ', trade_date: '2025-01-06',
    code: '600519', symbol: '600519.SH', name: '贵州茅台', side: 'buy', price: '99', quantity: 100,
    client_request_id: 'key-yang', updated_at: '2025-01-07T09:00:00+08:00',
  });
  const missing = legacyRecord({
    id: 'rec_missing', trade_date: '2025-01-06', code: '000001', symbol: '000001.SZ',
    name: '平安银行', side: 'buy', price: '8', quantity: 10, client_request_id: 'key-missing',
  });
  const blank = legacyRecord({
    id: 'rec_blank', trader: '   ', trade_date: '2025-01-06', code: '000858', symbol: '000858.SZ',
    name: '五粮液', side: 'buy', price: '7', quantity: 10, client_request_id: 'key-blank',
  });
  const none = legacyRecord({
    id: 'rec_null', trader: null, trade_date: '2025-01-06', code: '300750', symbol: '300750.SZ',
    name: '宁德时代', side: 'buy', price: '6', quantity: 10, client_request_id: 'key-null',
  });
  const tooLong = legacyRecord({
    id: 'rec_long', trader: 'x'.repeat(65), trade_date: '2025-01-06', code: '601318', symbol: '601318.SH',
    name: '中国平安', side: 'buy', price: '5', quantity: 10, client_request_id: 'key-long',
  });
  const corrupt = legacyRecord({
    id: 'rec_corrupt', trader: '示例', trade_date: '2025-01-06', code: '000002', symbol: '000002.SZ',
    name: '万科A', side: 'buy', price: '4', quantity: 10, client_request_id: 'key-corrupt',
  });
  const already = legacyRecord({
    id: 'rec_v2', trader: '杨鹏', trade_date: '2025-01-06', code: '600519', symbol: '600519.SH',
    name: '贵州茅台', side: 'buy', price: '20', quantity: 50, client_request_id: 'key-v2',
  });
  const yangV1 = legacyFingerprint({ ...yang, price: '10' });
  const missingV1 = legacyFingerprint(missing);
  const v2Fingerprint = JSON.stringify(['杨鹏', '2025-01-06', null, '600519', '600519.SH', '贵州茅台', 'buy', '1', 50, '0', '0', null, 'key-v2']);
  const initial = {
    schema_version: 1,
    records: [yang, missing, blank, none, tooLong, corrupt, already],
    reviews: [review],
    requests: [
      { key: 'key-yang', recordId: 'rec_yang', fingerprint: yangV1 },
      { key: 'key-missing', recordId: 'rec_missing', fingerprint: missingV1 },
      { key: 'key-blank', recordId: 'rec_blank', fingerprint: legacyFingerprint(blank) },
      { key: 'key-null', recordId: 'rec_null', fingerprint: legacyFingerprint(none) },
      { key: 'key-long', recordId: 'rec_long', fingerprint: legacyFingerprint(tooLong) },
      { key: 'key-corrupt', recordId: 'rec_corrupt', fingerprint: 'not-json' },
      { key: 'key-v2', recordId: 'rec_v2', fingerprint: v2Fingerprint },
      { key: 'key-orphan', recordId: 'rec_gone', fingerprint: missingV1 },
    ],
  };
  const { request, store, filePath } = await harness(t, initial);
  const migrated = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(migrated.schema_version, 2);
  assert.deepEqual(store.state.reviews, [review]);
  const byId = Object.fromEntries(store.state.records.map((record) => [record.id, record]));
  assert.deepEqual(store.state.records.map((record) => record.id), initial.records.map((record) => record.id));
  assert.equal(byId.rec_yang.trader, '杨鹏');
  assert.equal(byId.rec_yang.version, 3);
  assert.equal(byId.rec_yang.price, '99');
  assert.equal(byId.rec_yang.updated_at, '2025-01-07T09:00:00+08:00');
  assert.equal(byId.rec_yang.created_at, '2025-01-06T09:00:00+08:00');
  for (const id of ['rec_missing', 'rec_blank', 'rec_null', 'rec_long']) assert.equal(byId[id].trader, '未指定');
  assert.equal(byId.rec_corrupt.trader, '示例');
  assert.equal(byId.rec_v2.trader, '杨鹏');
  assert.equal(byId.rec_v2.price, '20');
  const fingerprint = (key) => store.state.requests.find((item) => item.key === key).fingerprint;
  const yangParts = JSON.parse(fingerprint('key-yang'));
  assert.equal(yangParts.length, 13);
  assert.equal(yangParts[0], '杨鹏');
  assert.deepEqual(yangParts.slice(1), JSON.parse(yangV1));
  assert.equal(JSON.parse(fingerprint('key-missing'))[0], '未指定');
  assert.deepEqual(JSON.parse(fingerprint('key-missing')).slice(1), JSON.parse(missingV1));
  assert.equal(JSON.parse(fingerprint('key-blank'))[0], '未指定');
  assert.equal(JSON.parse(fingerprint('key-null'))[0], '未指定');
  assert.equal(JSON.parse(fingerprint('key-long'))[0], '未指定');
  assert.equal(fingerprint('key-corrupt'), 'not-json');
  assert.equal(fingerprint('key-v2'), v2Fingerprint);
  assert.equal(store.state.requests.some((item) => item.key === 'key-orphan'), false);
  const stable = readFileSync(filePath, 'utf8');
  assert.equal(new JournalStore(filePath).state.schema_version, 2);
  assert.equal(readFileSync(filePath, 'utf8'), stable);
  assert.deepEqual((await request('GET', '/api/traders')).body.data.traders, [
    { trader: '未指定', record_count: 4 },
    { trader: '杨鹏', record_count: 2 },
    { trader: '示例', record_count: 1 },
  ]);

  const replay = await request('POST', '/api/records', {
    trader: '杨鹏', trade_date: '2025-01-06', trade_time: null, code: '600519', name: '贵州茅台',
    side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0, note: null, client_request_id: 'key-yang',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.meta.duplicate, true);
  assert.equal(replay.body.data.id, 'rec_yang');
  assert.equal(replay.body.data.price, 99);
  assert.equal(replay.body.data.version, 3);
  assert.equal(replay.body.data.trader, '杨鹏');
  const wrongPrice = await request('POST', '/api/records', {
    trader: '杨鹏', trade_date: '2025-01-06', code: '600519', name: '贵州茅台',
    side: 'buy', price: 99, quantity: 100, fee: 0, client_request_id: 'key-yang',
  });
  assert.equal(wrongPrice.status, 409);
  assert.equal(wrongPrice.body.error.code, 'DUPLICATE_RECORD');
  const corruptReplay = await request('POST', '/api/records', trade({
    code: '000002', name: '万科A', price: 4, quantity: 10, fee: 0, client_request_id: 'key-corrupt',
  }));
  assert.equal(corruptReplay.status, 409);
  assert.equal(corruptReplay.body.error.code, 'DUPLICATE_RECORD');
  assert.equal((await request('GET', '/api/records/rec_corrupt')).body.data.price, 4);
  const released = await request('POST', '/api/records', trade({ client_request_id: 'key-orphan', fee: 0 }));
  assert.equal(released.status, 201);

  const patched = await request('PATCH', '/api/records/rec_yang', { expected_version: 3, price: 50 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.version, 4);
  assert.equal(JSON.parse(fingerprint('key-yang'))[7], '10');
  const replayAfterPatch = await request('POST', '/api/records', {
    trader: '杨鹏', trade_date: '2025-01-06', trade_time: null, code: '600519', name: '贵州茅台',
    side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0, note: null, client_request_id: 'key-yang',
  });
  assert.equal(replayAfterPatch.status, 200);
  assert.equal(replayAfterPatch.body.meta.duplicate, true);
  assert.equal(replayAfterPatch.body.data.price, 50);
  assert.equal(replayAfterPatch.body.data.version, 4);
});

test('trader list uses exact counts and UTF-16 order, and books do not cross traders', async (t) => {
  const { request } = await harness(t);
  assert.deepEqual((await request('GET', '/api/traders')).body, { data: { traders: [] } });
  assert.equal((await request('GET', '/api/traders?limit=1')).status, 422);
  const z1 = await request('POST', '/api/records', trade({ trader: 'Z', code: '002415', name: '海康威视', client_request_id: 'z-1' }));
  const z2 = await request('POST', '/api/records', trade({ trader: 'Z', code: '000001', name: '平安银行' }));
  const lower = await request('POST', '/api/records', trade({ trader: 'a', code: '000858', name: '五粮液' }));
  const unspecified = await request('POST', '/api/records', trade({ trader: '  未指定  ', code: '601318', name: '中国平安' }));
  assert.equal(z1.status, 201);
  assert.equal(unspecified.body.data.trader, '未指定');
  assert.deepEqual((await request('GET', '/api/traders')).body.data.traders, [
    { trader: 'Z', record_count: 2 },
    { trader: 'a', record_count: 1 },
    { trader: '未指定', record_count: 1 },
  ]);
  assert.equal((await request('DELETE', `/api/records/${lower.body.data.id}?expected_version=1`)).status, 204);
  assert.deepEqual((await request('GET', '/api/traders')).body.data.traders.map((item) => item.trader), ['Z', '未指定']);

  const jia = await request('POST', '/api/records', trade({ trader: '甲', price: 10, fee: 5, quantity: 100 }));
  const yi = await request('POST', '/api/records', trade({ trader: '乙', price: 20, fee: 0, quantity: 100 }));
  assert.equal(jia.status, 201);
  assert.equal(yi.status, 201);
  const cross = await request('POST', '/api/records', trade({
    trader: '乙', side: 'sell', quantity: 150, trade_date: '2025-01-08', price: 22, fee: 0,
  }));
  assert.equal(cross.status, 409);
  assert.equal(cross.body.error.code, 'INSUFFICIENT_POSITION');
  assert.equal((await request('GET', '/api/positions/current?as_of=2025-01-08&trader=甲')).body.data.positions[0].quantity, 100);
  const sold = await request('POST', '/api/records', trade({
    trader: '乙', side: 'sell', quantity: 40, trade_date: '2025-01-08', price: 22, fee: 0, tax: 0,
  }));
  assert.equal(sold.status, 201);
  const current = await request('GET', '/api/positions/current?as_of=2025-01-08&code=600519');
  assert.equal(current.body.data.pagination.total, 2);
  assert.deepEqual(current.body.data.positions.map((row) => [row.trader, row.quantity]), [['乙', 60], ['甲', 100]]);
  assert.equal(current.body.data.positions[0].position_key, '乙\u001f600519.SH');
  const jiaBook = await request('GET', '/api/positions/current?as_of=2025-01-08&trader=%20%E7%94%B2%20');
  assert.equal(jiaBook.body.data.pagination.total, 1);
  assert.equal(jiaBook.body.data.positions[0].trader, '甲');
  assert.equal(jiaBook.body.data.positions[0].quantity, 100);
  const history = await request('GET', '/api/positions/history?trader=乙');
  assert.equal(history.body.data.pagination.total, 1);
  assert.equal(history.body.data.history[0].trader, '乙');
  assert.equal(history.body.data.history[0].quantity, 40);
  assert.equal((await request('GET', '/api/positions/history?trader=甲')).body.data.pagination.total, 0);
  assert.equal((await request('GET', '/api/records?trader=乙')).body.data.pagination.total, 2);
  assert.equal((await request('GET', '/api/records?trader=%20%20%E4%B9%99')).body.data.pagination.total, 2);
  assert.equal((await request('GET', '/api/records?trader=没有')).body.data.pagination.total, 0);
  assert.equal((await request('GET', '/api/positions/current?trader=没有')).body.data.pagination.total, 0);
  assert.equal((await request('GET', '/api/records?trader=%20')).status, 422);
  assert.equal(z2.status, 201);
});

test('request keys keep the creation fingerprint through price edits, A→B→A, and null release', async (t) => {
  const { request } = await harness(t);
  const input = trade({ client_request_id: 'key-a', price: 10, fee: 0, tax: 0 });
  const created = await request('POST', '/api/records', input);
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const patched = await request('PATCH', `/api/records/${id}`, { expected_version: 1, price: 11 });
  assert.equal(patched.body.data.version, 2);
  const replay = await request('POST', '/api/records', input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.meta.duplicate, true);
  assert.equal(replay.body.data.id, id);
  assert.equal(replay.body.data.price, 11);
  assert.equal(replay.body.data.version, 2);
  assert.equal((await request('POST', '/api/records', { ...input, price: 11 })).status, 409);
  assert.equal((await request('POST', '/api/records', { ...input, trader: '乙' })).status, 409);

  const toB = await request('PATCH', `/api/records/${id}`, { expected_version: 2, client_request_id: 'key-b' });
  assert.equal(toB.status, 200);
  assert.equal(toB.body.data.client_request_id, 'key-b');
  assert.equal(toB.body.data.version, 3);
  const replayA = await request('POST', '/api/records', input);
  assert.equal(replayA.status, 200);
  assert.equal(replayA.body.data.price, 11);
  assert.equal(replayA.body.data.client_request_id, 'key-b');
  assert.equal(replayA.body.data.version, 3);
  const replayB = await request('POST', '/api/records', { ...input, price: 11, client_request_id: 'key-b' });
  assert.equal(replayB.status, 200);
  assert.equal(replayB.body.meta.duplicate, true);
  assert.equal(replayB.body.data.id, id);

  const back = await request('PATCH', `/api/records/${id}`, { expected_version: 3, client_request_id: 'key-a' });
  assert.equal(back.status, 200);
  assert.equal(back.body.data.version, 4);
  assert.equal((await request('POST', '/api/records', input)).body.data.version, 4);
  assert.equal((await request('POST', '/api/records', { ...input, price: 11, client_request_id: 'key-b' })).body.data.id, id);

  const foreign = await request('POST', '/api/records', trade({ trader: '乙', client_request_id: 'key-foreign', fee: 0 }));
  assert.equal(foreign.status, 201);
  const clash = await request('PATCH', `/api/records/${id}`, { expected_version: 4, client_request_id: 'key-foreign' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'DUPLICATE_RECORD');
  assert.equal((await request('GET', `/api/records/${id}`)).body.data.version, 4);
  assert.equal((await request('GET', `/api/records/${id}`)).body.data.client_request_id, 'key-a');

  const cleared = await request('PATCH', `/api/records/${id}`, { expected_version: 4, client_request_id: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.client_request_id, null);
  const reused = await request('POST', '/api/records', input);
  assert.equal(reused.status, 201);
  assert.notEqual(reused.body.data.id, id);
  const reusedB = await request('POST', '/api/records', {
    ...input, price: 11, client_request_id: 'key-b', code: '000001', name: '平安银行',
  });
  assert.equal(reusedB.status, 201);
});
