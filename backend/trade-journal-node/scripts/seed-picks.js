// 把选股结果写成今天的买入记录。只读 TSP 策略列表和缓存结果，再 POST /api/records。
// 价格只用 raw_close（未复权收盘价）。client_request_id 按交易人哈希生成：
// 内容相同的重复提交记为 duplicate，同一键但价格或备注变了记为 conflict，避免静默覆盖。
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { todayShanghai } from '../src/store.js';
import { dateField, stockCode } from '../src/validation.js';

const JOURNAL_ORIGIN = 'http://127.0.0.1:3018';
const TSP_ORIGIN = 'http://47.95.156.102:5000';
const SHARES = 100;
const FILE_LABEL = '文件导入';
const NOTE_LIMIT = 1000;
const REQUEST_LIMIT = 80;
const HELP = `用法:
  node scripts/seed-picks.js --from-tsp --strategy <名称或ID> --count <N> [--dry-run]
  node scripts/seed-picks.js --from-file <picks.json> [--dry-run]

默认 POST ${JOURNAL_ORIGIN}/api/records。--journal 可改地址。
--tsp-base 默认 ${TSP_ORIGIN}，只 GET /api/strategies 和 /api/screener/cached-result/{id}。
--trader 可显式指定交易人标签；默认 TSP 模式为「AI选股:<策略展示名>」，文件模式为「AI选股:文件导入」。
文件需包含 picks 数组；每条 pick 需有 symbol、name、price、reason。
每只股票买入 ${SHARES} 股，交易日为 Asia/Shanghai 今天。备注为「AI选股：<策略或文件导入> + <理由>」。
client_request_id 为「seed2:日期:规范 symbol:交易人哈希」。完全相同的重复提交不新写记录；内容不一致会失败。`;

function originOnly(raw, label) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error(`${label} 不是有效地址`); }
  if (url.username || url.password) throw new Error(`${label} 不能包含凭证`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} 只支持 http 或 https`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${label} 只能是服务源地址`);
  return url.origin;
}

function take(argv, index, token) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`缺少 ${token} 的参数`);
  return value;
}

export function normalizeTrader(value) {
  if (typeof value !== 'string') throw new Error('trader 必须是字符串');
  const trader = value.trim();
  if (trader.length < 1) throw new Error('trader 不能为空');
  if (trader.length > 64) throw new Error('trader 长度必须为 1 到 64 个 UTF-16 字符');
  return trader;
}

export function parseArgs(argv) {
  const args = {
    help: false,
    dryRun: false,
    journal: JOURNAL_ORIGIN,
    tspBase: TSP_ORIGIN,
    mode: null,
    strategy: null,
    count: null,
    file: null,
    trader: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--from-tsp') {
      if (args.mode) throw new Error('不能同时使用 --from-tsp 和 --from-file');
      args.mode = 'tsp';
    } else if (token === '--from-file') {
      if (args.mode) throw new Error('不能同时使用 --from-tsp 和 --from-file');
      args.mode = 'file';
      args.file = take(argv, index += 1, token);
    } else if (token === '--strategy') {
      if (args.strategy) throw new Error('--strategy 只能指定一次');
      args.strategy = take(argv, index += 1, token);
    } else if (token === '--count') {
      if (args.count !== null) throw new Error('--count 只能指定一次');
      const raw = take(argv, index += 1, token);
      if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 100) throw new Error('--count 必须是 1 到 100 的整数');
      args.count = Number(raw);
    } else if (token === '--trader') {
      if (args.trader !== null) throw new Error('--trader 只能指定一次');
      args.trader = normalizeTrader(take(argv, index += 1, token));
    } else if (token === '--journal') args.journal = take(argv, index += 1, token);
    else if (token === '--tsp-base') args.tspBase = take(argv, index += 1, token);
    else throw new Error(`未知参数：${token}`);
  }
  if (args.help) return args;
  if (args.mode === 'tsp') {
    if (!args.strategy?.trim()) throw new Error('TSP 模式需要 --strategy');
    if (args.count === null) throw new Error('TSP 模式需要 --count');
  } else if (args.mode === 'file') {
    if (args.strategy) throw new Error('文件模式不使用 --strategy');
    if (args.count !== null) throw new Error('文件模式不使用 --count');
  } else throw new Error('请指定 --from-tsp 或 --from-file');
  args.journal = originOnly(args.journal, '--journal');
  args.tspBase = originOnly(args.tspBase, '--tsp-base');
  args.strategy = args.strategy?.trim() ?? null;
  return args;
}

function roundDecimal(text) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  if (frac.length <= 4) {
    const number = Number(text);
    return number > 0 && number <= 1_000_000 ? number : null;
  }
  const width = whole.length + 4;
  let digits = `${whole}${frac.slice(0, 4)}`;
  if (frac[4] >= '5') digits = String(BigInt(digits) + 1n).padStart(digits.length, '0');
  const padded = digits.padStart(width, '0');
  const wholeOut = padded.slice(0, -4).replace(/^0+(?=\d)/, '') || '0';
  const fracOut = padded.slice(-4).replace(/0+$/, '');
  const out = fracOut ? `${wholeOut}.${fracOut}` : wholeOut;
  const number = Number(out);
  return number > 0 && number <= 1_000_000 ? number : null;
}

export function normalizePrice(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
    const plain = String(value);
    if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(plain)) return roundDecimal(plain);
    return roundDecimal(value.toFixed(8));
  }
  if (typeof value === 'string') return roundDecimal(value.trim());
  return null;
}

export function codeFromSymbol(symbol) {
  if (typeof symbol !== 'string') return { error: 'symbol 无效' };
  const trimmed = symbol.trim();
  const upper = trimmed.toUpperCase();
  const dotted = /^(\d{6})\.(SH|SZ|BJ)$/.exec(upper);
  const prefixed = /^(SH|SZ|BJ)(\d{6})$/.exec(upper);
  const bare = /^(\d{6})$/.exec(upper);
  const code = dotted?.[1] ?? prefixed?.[2] ?? bare?.[1];
  const hinted = dotted?.[2] ?? prefixed?.[1] ?? null;
  if (!code) return { error: '无法从 symbol 得到唯一六位代码' };
  let parsed;
  try { parsed = stockCode(code); }
  catch (error) { return { error: error instanceof Error ? error.message : '股票代码无效' }; }
  if (hinted && hinted !== parsed.symbol.slice(-2)) return { error: 'symbol 交易所与代码不一致' };
  return { code: parsed.code, symbol: parsed.symbol };
}

function formatScore(score) {
  const text = String(score);
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : score.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function numericScore(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    const score = Number(value.trim());
    if (Number.isFinite(score)) return score;
  }
  return null;
}

function buildNote(label, reason) {
  const note = `AI选股：${label} + ${reason}`;
  if (note.length > NOTE_LIMIT) throw new Error('备注超过 1000 个字符');
  return note;
}

export function defaultTrader(mode, label) {
  return normalizeTrader(mode === 'tsp' ? `AI选股:${label}` : `AI选股:${FILE_LABEL}`);
}

export function buildClientRequestId(tradeDate, symbol, trader) {
  const traderHash = createHash('sha256').update(trader, 'utf8').digest('hex').slice(0, 32);
  const clientRequestId = `seed2:${tradeDate}:${symbol}:${traderHash}`;
  if (clientRequestId.length > REQUEST_LIMIT) throw new Error('client_request_id 超过 80 个字符');
  return clientRequestId;
}

export function buildBuyRecord(pick, tradeDate, label, trader) {
  return {
    trader,
    trade_date: tradeDate,
    code: pick.code,
    name: pick.name,
    side: 'buy',
    price: pick.price,
    quantity: SHARES,
    note: buildNote(label, pick.reason),
    client_request_id: buildClientRequestId(tradeDate, pick.symbol, trader),
  };
}

function displayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 64 ? name : null;
}

function strategyDisplayName(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return fallback;
}

function qualifyTspRow(row, asOf) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: '行不是对象' };
  if (row.date !== asOf) return { error: '行日期不是缓存 as_of' };
  const score = numericScore(row.score);
  if (score === null) return { error: 'score 不是数字' };
  const price = normalizePrice(row.raw_close);
  if (price === null) return { error: 'raw_close 不是有效价格' };
  const identity = codeFromSymbol(row.symbol);
  if (identity.error) return { error: identity.error };
  const name = displayName(row.name);
  if (!name) return { error: '名称长度必须为 1 到 64' };
  return { pick: { ...identity, name, price, score, reason: `原始评分 ${formatScore(score)}` } };
}

export function selectCachedPicks(body, count, today) {
  const result = body?.result;
  if (!result || !Array.isArray(result.rows)) throw new Error('TSP 缓存响应缺少 result.rows');
  if (result.as_of !== today) throw new Error(`TSP 缓存 as_of=${result.as_of ?? '缺失'}，不是今天 ${today}，已拒绝导入`);
  const ranked = [];
  const skipped = [];
  result.rows.forEach((row, index) => {
    const score = numericScore(row?.score);
    if (score === null) skipped.push({ symbol: typeof row?.symbol === 'string' ? row.symbol.slice(0, 32) : null, reason: 'score 不是数字' });
    else ranked.push({ row, score, index });
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen = [];
  const seen = new Set();
  for (const rankedRow of ranked) {
    const identity = codeFromSymbol(rankedRow.row?.symbol);
    if (!identity.error && seen.has(identity.symbol)) {
      skipped.push({ symbol: identity.symbol, reason: '同一标的保留评分更高的一行' });
      continue;
    }
    const outcome = qualifyTspRow(rankedRow.row, result.as_of);
    if (outcome.error) throw new Error(`评分前 ${count} 的标的 ${rankedRow.row?.symbol ?? '未知'} 无法导入：${outcome.error}`);
    const pick = outcome.pick;
    seen.add(pick.symbol);
    chosen.push({ code: pick.code, symbol: pick.symbol, name: pick.name, price: pick.price, reason: pick.reason });
    if (chosen.length === count) break;
  }
  if (chosen.length < count) throw new Error(`有效标的只有 ${chosen.length} 只，不足 ${count} 只（跳过 ${skipped.length} 行）`);
  return { picks: chosen, skipped: skipped.slice(0, 20), skippedCount: skipped.length };
}

export function findStrategy(body, query) {
  const list = Array.isArray(body) ? body : body?.strategies;
  if (!Array.isArray(list)) throw new Error('TSP /api/strategies 响应缺少 strategies 数组');
  const needle = query.trim();
  const matches = list.filter((item) => item && (item.id === needle || item.name === needle));
  if (matches.length === 0) throw new Error(`未找到策略：${needle}`);
  if (matches.length > 1) throw new Error(`策略名称或 ID 不唯一：${needle}`);
  const strategy = matches[0];
  if (typeof strategy.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(strategy.id)) throw new Error('策略 id 无效');
  return { id: strategy.id, name: strategyDisplayName(strategy.name, strategy.id) };
}

function filePick(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`第 ${index + 1} 条不是对象`);
  const identity = codeFromSymbol(row.symbol);
  if (identity.error) throw new Error(`第 ${index + 1} 条${identity.error}`);
  const name = displayName(row.name);
  if (!name) throw new Error(`第 ${index + 1} 条名称长度必须为 1 到 64`);
  const price = normalizePrice(row.price);
  if (price === null) throw new Error(`第 ${index + 1} 条价格无效`);
  if (typeof row.reason !== 'string' || row.reason.trim() === '') throw new Error(`第 ${index + 1} 条缺少 reason`);
  return { ...identity, name, price, reason: row.reason.trim() };
}

export function loadFilePicks(body) {
  const sample = Boolean(body && typeof body === 'object' && !Array.isArray(body) && body.sample === true);
  const rows = Array.isArray(body) ? body : body?.picks ?? body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('选股文件需要非空的 picks 数组');
  const picks = rows.map(filePick);
  const seen = new Set();
  for (const pick of picks) {
    if (seen.has(pick.symbol)) throw new Error(`文件中 symbol 重复：${pick.symbol}`);
    seen.add(pick.symbol);
  }
  return { sample, picks, skipped: [], skippedCount: 0 };
}

function readPickFile(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new Error('无法读取选股文件'); }
  try { return JSON.parse(text); }
  catch { throw new Error('选股文件不是 JSON'); }
}

function tspUrl(origin, pathname) {
  if (pathname !== '/api/strategies' && !/^\/api\/screener\/cached-result\/[A-Za-z0-9_-]+$/.test(pathname)) {
    throw new Error('拒绝访问该 TSP 路径');
  }
  const url = new URL(pathname, `${origin}/`);
  if (url.origin !== origin || url.pathname !== pathname || url.search) throw new Error('TSP 地址无效');
  return url;
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!type.toLowerCase().startsWith('application/json')) throw new Error(`TSP ${url.pathname} 响应不是 JSON`);
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`TSP ${url.pathname} 响应不是 JSON`); }
  if (response.status !== 200) throw new Error(`TSP ${url.pathname} 返回 HTTP ${response.status}`);
  return body;
}

async function postRecord(fetchImpl, origin, record) {
  const response = await fetchImpl(new URL('/api/records', `${origin}/`), {
    method: 'POST',
    redirect: 'error',
    headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(20_000),
  });
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!type.toLowerCase().startsWith('application/json') || text === '') return { status: response.status, json: false, body: null };
  try { return { status: response.status, json: true, body: JSON.parse(text) }; }
  catch { return { status: response.status, json: false, body: null }; }
}

function classify(record, symbol, response) {
  const item = {
    symbol,
    code: record.code,
    name: record.name,
    trader: record.trader,
    price: record.price,
    quantity: record.quantity,
    client_request_id: record.client_request_id,
    http_status: response.status,
    id: null,
    error_code: null,
    message: null,
  };
  if (!response.json) return { ...item, status: 'error', message: '响应不是 JSON' };
  const { body } = response;
  if (response.status === 201 && body?.data?.id && body?.meta?.duplicate !== true) {
    return { ...item, status: 'created', id: body.data.id };
  }
  if (response.status === 200 && body?.meta?.duplicate === true && body?.data?.id) {
    return { ...item, status: 'duplicate', id: body.data.id, message: '相同 client_request_id 与相同内容，未重复写入' };
  }
  if (response.status === 409 && body?.error?.code === 'DUPLICATE_RECORD') {
    return {
      ...item,
      status: 'conflict',
      error_code: 'DUPLICATE_RECORD',
      message: '相同 client_request_id 已存在，但本次价格、名称、备注或交易人与已写入记录不一致',
    };
  }
  return { ...item, status: 'error', error_code: body?.error?.code ?? null, message: body?.error?.message ?? `HTTP ${response.status}` };
}

function counts(results) {
  const tally = { created: 0, duplicate: 0, conflict: 0, error: 0 };
  for (const item of results) tally[item.status] += 1;
  return tally;
}

function tradeDay(value) {
  try { return dateField(value, 'trade_date'); }
  catch { throw new Error('交易日期无效'); }
}

export async function runSeed(argv, deps = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: HELP };
  const today = tradeDay(deps.today ?? todayShanghai());
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  let loaded;
  if (options.mode === 'file') {
    loaded = { label: FILE_LABEL, ...loadFilePicks(readPickFile(options.file)) };
  } else {
    const strategy = findStrategy(await readJson(fetchImpl, tspUrl(options.tspBase, '/api/strategies')), options.strategy);
    const cached = await readJson(fetchImpl, tspUrl(options.tspBase, `/api/screener/cached-result/${strategy.id}`));
    loaded = { label: strategy.name, sample: false, ...selectCachedPicks(cached, options.count, today) };
  }
  const trader = options.trader ?? defaultTrader(options.mode, loaded.label);
  const postables = loaded.picks.map((pick) => ({ symbol: pick.symbol, record: buildBuyRecord(pick, today, loaded.label, trader) }));
  const records = postables.map(({ record }) => record);
  const header = {
    trade_date: today,
    source: options.mode,
    label: loaded.label,
    trader,
    sample: loaded.sample,
    score_order: options.mode === 'tsp' ? 'desc' : null,
    skipped_count: loaded.skippedCount,
    skipped: loaded.skipped,
  };
  if (options.dryRun) return { ...header, dry_run: true, records };
  const results = [];
  for (const { record, symbol } of postables) results.push(classify(record, symbol, await postRecord(fetchImpl, options.journal, record)));
  return { ...header, dry_run: false, counts: counts(results), results };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.stdout ?? ((text) => console.log(text));
  const writeErr = deps.stderr ?? ((text) => console.error(text));
  try {
    const report = await runSeed(argv, deps);
    if (report.help) {
      writeOut(report.help);
      return 0;
    }
    writeOut(JSON.stringify(report, null, 2));
    return report.dry_run || (report.counts.conflict === 0 && report.counts.error === 0) ? 0 : 1;
  } catch (error) {
    writeErr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code; });
}
