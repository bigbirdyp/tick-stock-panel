export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const invalid = (path, message) => new ApiError(422, 'VALIDATION_ERROR', '请求字段校验失败', { fields: [{ path, message }] });
const own = (object, key) => Object.hasOwn(object, key);

function objectBody(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('$', '必须是 JSON 对象');
  return value;
}

function allowedKeys(value, keys) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(key, '不支持此字段');
}

function textField(value, path, min, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length < min || value.length > max) throw invalid(path, `长度必须为 ${min} 到 ${max} 个字符`);
  return value;
}

export function dateField(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw invalid(path, '必须是真实的 YYYY-MM-DD 日期');
  }
  return value;
}

function timeField(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) throw invalid('trade_time', '必须是 HH:mm:ss 格式');
  return value;
}

function integerField(value, path, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(path, `必须是 ${min} 到 ${max} 的整数`);
  return value;
}

function decimalField(value, path, max, places, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > max || (positive ? value <= 0 : value < 0)) {
    throw invalid(path, `必须是${positive ? '大于 0' : '非负'}且不超过 ${max} 的数字`);
  }
  const normalized = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) || (normalized.split('.')[1]?.length ?? 0) > places) {
    throw invalid(path, `最多 ${places} 位小数`);
  }
  return normalized;
}

export function stockCode(value, path = 'code') {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw invalid(path, '必须是六位 A 股代码');
  let exchange;
  if (/^(600|601|603|605|688|689)/.test(value)) exchange = 'SH';
  else if (/^(000|001|002|003|300|301)/.test(value)) exchange = 'SZ';
  else if (value.startsWith('920')) exchange = 'BJ';
  else throw new ApiError(422, 'INVALID_STOCK_CODE', '股票代码无法规范化为唯一标的');
  return { code: value, symbol: `${value}.${exchange}` };
}

const recordFields = ['trade_date', 'trade_time', 'code', 'symbol', 'name', 'side', 'price', 'quantity', 'fee', 'tax', 'note', 'client_request_id'];

export function recordInput(value, patch = false) {
  const body = objectBody(value);
  allowedKeys(body, patch ? [...recordFields.filter((key) => key !== 'symbol'), 'expected_version'] : recordFields);
  if (patch && !own(body, 'expected_version')) throw new ApiError(428, 'PRECONDITION_REQUIRED', '缺少 expected_version');
  if (patch && Object.keys(body).length < 2) throw invalid('$', '至少提交一个可写字段');
  if (!patch) for (const key of ['trade_date', 'code', 'name', 'side', 'price', 'quantity']) if (!own(body, key)) throw invalid(key, '必填');
  const result = {};
  if (patch) result.expected_version = integerField(body.expected_version, 'expected_version', 1);
  if (own(body, 'trade_date')) result.trade_date = dateField(body.trade_date, 'trade_date');
  if (own(body, 'trade_time')) result.trade_time = timeField(body.trade_time);
  if (own(body, 'code')) Object.assign(result, stockCode(body.code));
  if (own(body, 'symbol') && (!result.symbol || body.symbol !== result.symbol)) throw invalid('symbol', '必须与 code 对应的 symbol 一致');
  if (own(body, 'name')) result.name = textField(body.name, 'name', 1, 64);
  if (own(body, 'side')) {
    if (body.side !== 'buy' && body.side !== 'sell') throw invalid('side', '必须是 buy 或 sell');
    result.side = body.side;
  }
  if (own(body, 'price')) result.price = decimalField(body.price, 'price', 1_000_000, 4, true);
  if (own(body, 'quantity')) result.quantity = integerField(body.quantity, 'quantity', 1, 1_000_000_000);
  if (own(body, 'fee')) result.fee = decimalField(body.fee, 'fee', 100_000_000, 2);
  if (own(body, 'tax')) result.tax = decimalField(body.tax, 'tax', 100_000_000, 2);
  if (own(body, 'note')) result.note = textField(body.note, 'note', 0, 1000, true) || null;
  if (own(body, 'client_request_id')) result.client_request_id = textField(body.client_request_id, 'client_request_id', 1, 80, true);
  if (!patch) {
    result.trade_time ??= null;
    result.fee ??= '0';
    result.tax ??= '0';
    result.note ??= null;
    result.client_request_id ??= null;
  }
  return result;
}

export function reviewInput(value, patch = false) {
  const body = objectBody(value);
  allowedKeys(body, patch ? ['date', 'content', 'tags', 'expected_version'] : ['date', 'content', 'tags']);
  if (patch && !own(body, 'expected_version')) throw new ApiError(428, 'PRECONDITION_REQUIRED', '缺少 expected_version');
  if (patch && Object.keys(body).length < 2) throw invalid('$', '至少提交一个可写字段');
  if (!patch) for (const key of ['date', 'content']) if (!own(body, key)) throw invalid(key, '必填');
  const result = {};
  if (patch) result.expected_version = integerField(body.expected_version, 'expected_version', 1);
  if (own(body, 'date')) result.date = dateField(body.date, 'date');
  if (own(body, 'content')) result.content = textField(body.content, 'content', 1, 20_000);
  if (own(body, 'tags')) {
    if (!Array.isArray(body.tags) || body.tags.length > 20) throw invalid('tags', '必须是最多 20 项的数组');
    result.tags = body.tags.map((tag, index) => textField(tag, `tags[${index}]`, 1, 30));
  }
  if (!patch) result.tags ??= [];
  return result;
}

export function versionQuery(params) {
  const raw = params.get('expected_version');
  if (raw === null) throw new ApiError(428, 'PRECONDITION_REQUIRED', '缺少 expected_version');
  if (!/^[1-9]\d*$/.test(raw)) throw invalid('expected_version', '必须是正整数');
  return integerField(Number(raw), 'expected_version', 1);
}

export function listQuery(params, kind) {
  const choices = {
    records: { fields: ['date', 'from', 'to', 'code', 'side'], sorts: ['trade_date_desc', 'trade_date_asc'] },
    reviews: { fields: ['date', 'from', 'to', 'tag'], sorts: ['date_desc', 'date_asc'] },
    current: { fields: ['as_of', 'code'], sorts: ['symbol_asc', 'market_value_desc', 'return_rate_desc'] },
    history: { fields: ['from', 'to', 'code'], sorts: ['close_date_desc', 'close_date_asc'] },
  }[kind];
  for (const key of params.keys()) {
    if (![...choices.fields, 'limit', 'offset', 'sort'].includes(key)) throw invalid(key, '不支持此查询参数');
    if (params.getAll(key).length > 1) throw invalid(key, '不能重复');
  }
  const result = { limit: 50, offset: 0, sort: choices.sorts[0] };
  for (const key of choices.fields) if (params.has(key)) result[key] = params.get(key);
  for (const key of ['date', 'from', 'to', 'as_of']) if (own(result, key)) result[key] = dateField(result[key], key);
  if (result.from && result.to && result.from > result.to) throw new ApiError(422, 'INVALID_DATE', '起始日期不能晚于结束日期');
  if (own(result, 'code')) stockCode(result.code);
  if (own(result, 'side') && !['buy', 'sell'].includes(result.side)) throw invalid('side', '必须是 buy 或 sell');
  if (own(result, 'tag')) result.tag = textField(result.tag, 'tag', 1, 30);
  for (const key of ['limit', 'offset']) if (params.has(key)) {
    const raw = params.get(key);
    if (!/^(0|[1-9]\d*)$/.test(raw)) throw invalid(key, '必须是非负整数');
    result[key] = integerField(Number(raw), key, key === 'limit' ? 1 : 0, key === 'limit' ? 200 : Number.MAX_SAFE_INTEGER);
  }
  if (params.has('sort')) {
    result.sort = params.get('sort');
    if (!choices.sorts.includes(result.sort)) throw invalid('sort', '不支持此排序');
  }
  return result;
}
