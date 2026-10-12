import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { journalPort } from '../src/config.js';
import { createApp } from '../src/server.js';
import { JournalStore } from '../src/store.js';
import { recordInput } from '../src/validation.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trade-journal-test-'));
  const filePath = join(directory, 'journal.json');
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
    return { status: response.status, body: raw ? JSON.parse(raw) : null, raw };
  }
  return { request, store, filePath, directory };
}

const trade = (overrides = {}) => ({
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
  const dates = await request('GET', '/api/reviews?from=2025-02-01&to=2025-01-01');
  assert.equal(dates.body.error.code, 'INVALID_DATE');
});

test('idempotent creates, lifecycle, version conflict, and persistence survive restart', async (t) => {
  const { request, filePath } = await harness(t);
  const input = trade({ client_request_id: '__proto__' });
  const created = await request('POST', '/api/records', input);
  assert.equal(created.status, 201);
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
  assert.equal(reloaded.createRecord(recordInput(input)).duplicate, true);
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
  assert.equal(destination.position_key, '000001.SZ');
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
      assert.equal(row.price_status, 'unavailable');
      assert.equal(row.current_price, null);
      assert.equal(row.price_source, null);
      assert.equal(row.price_as_of, null);
      assert.equal(row.market_value, null);
      assert.equal(row.unrealized_pnl, null);
      assert.equal(row.return_rate, null);
    }
  }
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
    assert.equal(store.current({ as_of: '2025-01-08', limit: 50, offset: 0, sort: 'symbol_asc' }).positions[0].quantity, 50);
    assert.equal(store.history({ limit: 50, offset: 0, sort: 'close_date_desc' }).history.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
