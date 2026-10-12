import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
