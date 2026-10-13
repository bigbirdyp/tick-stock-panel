import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { JournalStore, todayShanghai } from '../src/store.js';
import { codeFromSymbol, loadFilePicks, main, normalizePrice, parseArgs, runSeed, selectCachedPicks } from '../scripts/seed-picks.js';

const samplePath = fileURLToPath(new URL('../scripts/picks.sample.json', import.meta.url));
const today = '2026-10-13';

function jsonResponse(status, body) {
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => JSON.stringify(body),
  };
}

function tspRow(overrides) {
  return { symbol: '600905.SH', name: '三峡能源', score: 1, raw_close: 3.54, close: 999, date: today, ...overrides };
}

test('normalizes prices to the records contract and reads six-digit codes', () => {
  assert.equal(normalizePrice(3.54), 3.54);
  assert.equal(normalizePrice('10.123456'), 10.1235);
  assert.equal(normalizePrice(10.123456), 10.1235);
  assert.equal(normalizePrice(0), null);
  assert.equal(normalizePrice(-1), null);
  assert.equal(normalizePrice(1_000_001), null);
  assert.deepEqual(codeFromSymbol('SH600519'), { code: '600519', symbol: '600519.SH' });
  assert.deepEqual(codeFromSymbol('000001'), { code: '000001', symbol: '000001.SZ' });
  assert.equal(codeFromSymbol('600519.SZ').error, 'symbol 交易所与代码不一致');
  assert.ok(codeFromSymbol('999999.SH').error);
});

test('selects the highest numeric scores from today raw closes', () => {
  const cached = {
    result: {
      as_of: today,
      total: 6,
      rows: [
        tspRow({ symbol: '600905.SH', score: 30, raw_close: 3.54 }),
        tspRow({ symbol: '000001.SZ', name: '平安银行', score: 20, raw_close: 11.2 }),
        tspRow({ symbol: '300750.SZ', name: '宁德时代', score: 10, raw_close: 188.88 }),
        tspRow({ symbol: '601988.SH', name: '中国银行', score: null, raw_close: 0 }),
        tspRow({ symbol: '600000.SH', name: '浦发银行', score: -1, date: '2026-10-12' }),
        tspRow({ symbol: '600905.SH', score: 1, raw_close: 9 }),
      ],
    },
  };
  const selected = selectCachedPicks(cached, 2, today);
  assert.deepEqual(selected.picks.map((pick) => [pick.symbol, pick.price, pick.reason]), [
    ['600905.SH', 3.54, '原始评分 30'],
    ['000001.SZ', 11.2, '原始评分 20'],
  ]);
  assert.equal(selected.picks[0].price === 999, false);
  assert.throws(() => selectCachedPicks({ result: { as_of: '2026-10-12', rows: [] } }, 1, today), /已拒绝导入/);
  assert.throws(() => selectCachedPicks({ result: { as_of: today, rows: [tspRow({ score: 100, raw_close: 0 }), tspRow({ score: 10 })] } }, 1, today), /raw_close/);
  assert.throws(() => selectCachedPicks({ result: { as_of: today, rows: [tspRow({ date: null })] } }, 1, today), /行日期/);
  assert.throws(() => selectCachedPicks({ result: { as_of: today, rows: [tspRow({ score: '9'.repeat(400) })] } }, 1, today), /不足 1 只/);
});

test('sample file is marked as sample data and builds file-import buys', () => {
  const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
  assert.equal(sample.sample, true);
  assert.equal(sample.picks.length, 3);
  assert.match(JSON.stringify(sample), /示例/);
  const loaded = loadFilePicks(sample);
  assert.equal(loaded.sample, true);
  assert.equal(loaded.picks.length, 3);
  const parsed = parseArgs(['--from-file', samplePath, '--dry-run']);
  assert.equal(parsed.journal, 'http://127.0.0.1:3022');
  assert.equal(parsed.tspBase, 'http://47.95.156.102:5000');
  assert.throws(() => parseArgs(['--journal', 'http://user:pass@127.0.0.1:3022', '--from-file', 'x']), /凭证/);
});

test('dry-run reads only the two TSP GET endpoints and does not post', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ href: String(url), method: init.method });
    if (String(url).endsWith('/api/strategies')) {
      return jsonResponse(200, { strategies: [{ id: 'mined_factor_7f646e18ab05afc918e3', name: '因子组合 · atr_pct', descending: true }] });
    }
    return jsonResponse(200, { result: { as_of: today, rows: [tspRow({ score: 99.5, raw_close: 3.54 }), tspRow({ symbol: '000001.SZ', name: '平安银行', score: 1 })], total: 2 } });
  };
  const report = await runSeed(['--from-tsp', '--strategy', '因子组合 · atr_pct', '--count', '1', '--dry-run'], { fetch: fetchImpl, today });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.match(calls[0].href, /\/api\/strategies$/);
  assert.match(calls[1].href, /\/api\/screener\/cached-result\/mined_factor_7f646e18ab05afc918e3$/);
  assert.equal(report.dry_run, true);
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].quantity, 100);
  assert.equal(report.records[0].side, 'buy');
  assert.equal(report.records[0].price, 3.54);
  assert.equal(report.records[0].note, 'AI选股：因子组合 · atr_pct + 原始评分 99.5');
  assert.equal(report.records[0].client_request_id, '2026-10-13600905.SH');
  assert.equal(report.score_order, 'desc');
});

test('file dry-run uses Shanghai today and never calls fetch', async () => {
  const report = await runSeed(['--from-file', samplePath, '--dry-run', '--journal', 'http://127.0.0.1:9'], {
    fetch: () => { throw new Error('dry-run 不应访问网络'); },
  });
  assert.equal(report.trade_date, todayShanghai());
  assert.equal(report.label, '文件导入');
  assert.equal(report.sample, true);
  assert.equal(report.records.length, 3);
  assert.match(report.records[0].note, /^AI选股：文件导入 \+ 示例：/);
});

test('identical replay is duplicate and a changed price is a 409 conflict', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-picks-'));
  const store = new JournalStore(join(directory, 'journal.json'));
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'picks.json');
  const journal = `http://127.0.0.1:${server.address().port}`;
  const writePick = (price) => writeFileSync(file, JSON.stringify({ picks: [{ symbol: '600519.SH', name: '贵州茅台', price, reason: '测试导入' }] }));
  writePick(10.123456);
  const argv = ['--from-file', file, '--journal', journal];
  const created = await runSeed(argv, { today });
  assert.equal(created.results[0].status, 'created');
  assert.equal(created.results[0].http_status, 201);
  assert.equal(created.results[0].price, 10.1235);
  assert.equal(store.getRecord(created.results[0].id).price, 10.1235);
  assert.equal(store.getRecord(created.results[0].id).quantity, 100);
  const replay = await runSeed(argv, { today });
  assert.equal(replay.results[0].status, 'duplicate');
  assert.equal(replay.results[0].http_status, 200);
  assert.equal(replay.results[0].id, created.results[0].id);
  assert.equal(store.state.records.length, 1);
  writePick(10.5);
  let errors = '';
  const code = await main(argv, { today, stdout() {}, stderr: (text) => { errors += text; } });
  assert.equal(code, 1);
  assert.equal(errors, '');
  const drifted = await runSeed(argv, { today });
  assert.equal(drifted.counts.conflict, 1);
  assert.equal(drifted.results[0].status, 'conflict');
  assert.equal(drifted.results[0].http_status, 409);
  assert.equal(drifted.results[0].error_code, 'DUPLICATE_RECORD');
  assert.match(drifted.results[0].message, /不一致/);
  assert.equal(store.state.records.length, 1);
});

test('a non-JSON records response is an error and does not look like success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-picks-html-'));
  const file = join(directory, 'picks.json');
  writeFileSync(file, JSON.stringify({ picks: [{ symbol: '600519.SH', name: '贵州茅台', price: 10, reason: '测试' }] }));
  const report = await runSeed(['--from-file', file, '--journal', 'http://127.0.0.1:3022'], {
    today,
    fetch: async () => ({ status: 502, headers: { get: () => 'text/html' }, text: async () => '<html>' }),
  });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(report.results[0].status, 'error');
  assert.equal(report.results[0].message, '响应不是 JSON');
  assert.equal(report.counts.error, 1);
});
