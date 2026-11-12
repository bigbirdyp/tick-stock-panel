import { isRealDate } from './calendar'
import { decFromNumber, decToNumber } from './money'
import { resolveSymbol } from './symbol'
import type { FieldError, RecordPatch, RecordWrite, ReviewPatch, ReviewWrite, Side } from './types'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const TIME_MINUTE_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 浏览器 time 控件经常只给出 HH:mm。契约要求 HH:mm:ss，秒未知时补 :00。
 * 空值表示未知成交时间。无法识别的字符串原样返回，交给服务端报 422。
 */
export function normalizeTradeTime(value: string | null | undefined): string | null {
  if (value == null) return null
  const text = value.trim()
  if (text === '') return null
  if (TIME_MINUTE_RE.test(text)) return `${text}:00`
  return text
}
const RECORD_SORTS = new Set(['trade_date_desc', 'trade_date_asc'])
const REVIEW_SORTS = new Set(['date_desc', 'date_asc'])
const POSITION_SORTS = new Set(['symbol_asc', 'market_value_desc', 'return_rate_desc'])
const HISTORY_SORTS = new Set(['close_date_desc', 'close_date_asc'])

export interface NormalizedRecord {
  trader: string
  trade_date: string
  trade_time: string | null
  code: string
  symbol: string
  name: string
  side: Side
  priceMicro: bigint
  quantity: number
  feeMicro: bigint
  taxMicro: bigint
  note: string | null
  client_request_id: string | null
  fingerprint: string
}

export interface RecordIssue {
  status: number
  code: string
  message: string
  fields: FieldError[]
}

const TRADER_MAX = 64

/**
 * 写入和查询共用 §2.8：trim 后 1–64 个 UTF-16 code unit。
 * 缺省不会变成「未指定」，那个字面量只属于迁移回填。
 */
export function normalizeTrader(value: unknown): { ok: true; value: string } | { ok: false; issue: RecordIssue } {
  if (typeof value !== 'string') {
    return {
      ok: false,
      issue: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'trader 为必填',
        fields: [{ path: 'trader', message: '必须是字符串' }],
      },
    }
  }
  const text = value.trim()
  if (text.length === 0) {
    return {
      ok: false,
      issue: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'trader 为必填',
        fields: [{ path: 'trader', message: '不能为空' }],
      },
    }
  }
  if (text.length > TRADER_MAX) {
    return {
      ok: false,
      issue: {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: '请求字段校验失败',
        fields: [{ path: 'trader', message: '长度必须是 1 到 64 个字符' }],
      },
    }
  }
  return { ok: true, value: text }
}

/** 查询参数缺省表示全部交易者；出现时必须通过与写入相同的 trim / 长度规则。 */
export function validateTraderFilter(value: string | undefined): { trader?: undefined; issue: RecordIssue } | { trader: string | undefined; issue?: undefined } {
  if (value == null) return { trader: undefined }
  const parsed = normalizeTrader(value)
  if (!parsed.ok) return { issue: parsed.issue }
  return { trader: parsed.value }
}

function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null
  const text = value.trim()
  return text === '' ? null : text
}

function pushDate(fields: FieldError[], path: string, value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fields.push({ path, message: '必须是 YYYY-MM-DD 格式' })
    return
  }
  if (!isRealDate(value)) fields.push({ path, message: '必须是真实日历日期' })
}

export function validatePage(limit: number | undefined, offset: number | undefined): RecordIssue | null {
  const fields: FieldError[] = []
  const resolvedLimit = limit ?? 50
  const resolvedOffset = offset ?? 0
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 200) {
    fields.push({ path: 'limit', message: '必须是 1 到 200 的整数' })
  }
  if (!Number.isInteger(resolvedOffset) || resolvedOffset < 0) {
    fields.push({ path: 'offset', message: '必须是大于等于 0 的整数' })
  }
  if (fields.length === 0) return null
  return { status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields }
}

export function validateDateRange(from: string | undefined, to: string | undefined): RecordIssue | null {
  const fields: FieldError[] = []
  if (from != null) pushDate(fields, 'from', from)
  if (to != null) pushDate(fields, 'to', to)
  if (fields.length > 0) return { status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields }
  if (from != null && to != null && from > to) {
    return {
      status: 422,
      code: 'INVALID_DATE',
      message: '起始日期不能晚于结束日期',
      fields: [{ path: 'from', message: '不能晚于 to' }],
    }
  }
  return null
}

export function validateSort(sort: string | undefined, allowed: Set<string>, path = 'sort'): RecordIssue | null {
  if (sort == null || allowed.has(sort)) return null
  return {
    status: 422,
    code: 'VALIDATION_ERROR',
    message: '请求字段校验失败',
    fields: [{ path, message: '排序方式不在允许列表中' }],
  }
}

export function recordSorts(): Set<string> {
  return RECORD_SORTS
}
export function reviewSorts(): Set<string> {
  return REVIEW_SORTS
}
export function positionSorts(): Set<string> {
  return POSITION_SORTS
}
export function historySorts(): Set<string> {
  return HISTORY_SORTS
}

function moneyField(fields: FieldError[], path: string, value: number, maxPlaces: number, min: number, max: number, allowZero: boolean): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fields.push({ path, message: '必须是数字' })
    return null
  }
  if (value < min || (value === 0 && !allowZero) || value > max) {
    fields.push({ path, message: allowZero ? `必须在 ${min} 到 ${max} 之间` : `必须大于 0 且不超过 ${max}` })
    return null
  }
  const micro = decFromNumber(value, maxPlaces)
  if (micro == null) {
    fields.push({ path, message: `最多 ${maxPlaces} 位小数` })
    return null
  }
  return micro
}

export function normalizeRecordWrite(body: RecordWrite): { ok: true; value: NormalizedRecord } | { ok: false; issue: RecordIssue } {
  const fields: FieldError[] = []
  const traderResult = normalizeTrader(body.trader)
  const trader = traderResult.ok ? traderResult.value : ''
  if (!traderResult.ok) fields.push(...traderResult.issue.fields)
  pushDate(fields, 'trade_date', body.trade_date ?? '')
  const tradeTime = blankToNull(body.trade_time)
  if (tradeTime != null && !TIME_RE.test(tradeTime)) {
    fields.push({ path: 'trade_time', message: '必须是 HH:mm:ss' })
  }
  const code = (body.code ?? '').trim()
  const symbol = resolveSymbol(code)
  if (!/^[0-9]{6}$/.test(code)) fields.push({ path: 'code', message: '必须是六位数字代码' })
  else if (symbol == null) fields.push({ path: 'code', message: '无法识别交易所' })
  if (body.symbol != null && body.symbol !== '' && symbol != null && body.symbol !== symbol) {
    fields.push({ path: 'symbol', message: '与代码解析结果不一致' })
  }
  const name = (body.name ?? '').trim()
  if (name.length < 1 || name.length > 64) fields.push({ path: 'name', message: '长度必须是 1 到 64 个字符' })
  if (body.side !== 'buy' && body.side !== 'sell') fields.push({ path: 'side', message: '只能是 buy 或 sell' })
  const priceMicro = moneyField(fields, 'price', body.price, 4, 0, 1_000_000, false)
  if (typeof body.quantity !== 'number' || !Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 1_000_000_000) {
    fields.push({ path: 'quantity', message: '必须是 1 到 1000000000 的整数股' })
  }
  const feeMicro = moneyField(fields, 'fee', body.fee ?? 0, 2, 0, 100_000_000, true)
  const taxMicro = moneyField(fields, 'tax', body.tax ?? 0, 2, 0, 100_000_000, true)
  const note = blankToNull(body.note)
  if (note != null && note.length > 1000) fields.push({ path: 'note', message: '最长 1000 个字符' })
  const requestId = blankToNull(body.client_request_id)
  if (requestId != null && requestId.length > 80) fields.push({ path: 'client_request_id', message: '最长 80 个字符' })

  if (fields.length > 0 || priceMicro == null || feeMicro == null || taxMicro == null || symbol == null) {
    const onlyBadCode = fields.length === 1 && fields[0]?.path === 'code' && fields[0].message === '无法识别交易所'
    const traderRequired = fields.length > 0 && fields.every(field => field.path === 'trader' && (field.message === '不能为空' || field.message === '必须是字符串'))
    return {
      ok: false,
      issue: {
        status: 422,
        code: onlyBadCode ? 'INVALID_STOCK_CODE' : 'VALIDATION_ERROR',
        message: onlyBadCode ? '股票代码无法规范化' : traderRequired ? 'trader 为必填' : '请求字段校验失败',
        fields,
      },
    }
  }

  const normalized: NormalizedRecord = {
    trader,
    trade_date: body.trade_date,
    trade_time: tradeTime,
    code,
    symbol,
    name,
    side: body.side,
    priceMicro,
    quantity: body.quantity,
    feeMicro,
    taxMicro,
    note,
    client_request_id: requestId,
    fingerprint: '',
  }
  normalized.fingerprint = JSON.stringify([
    normalized.trader,
    normalized.trade_date,
    normalized.trade_time,
    normalized.code,
    normalized.symbol,
    normalized.name,
    normalized.side,
    decToNumber(normalized.priceMicro, 4),
    normalized.quantity,
    decToNumber(normalized.feeMicro, 2),
    decToNumber(normalized.taxMicro, 2),
    normalized.note,
    normalized.client_request_id,
  ])
  return { ok: true, value: normalized }
}

const PATCH_KEYS = ['trader', 'trade_date', 'trade_time', 'code', 'name', 'side', 'price', 'quantity', 'fee', 'tax', 'note', 'client_request_id'] as const

export function patchTouchesRecord(body: RecordPatch): boolean {
  return PATCH_KEYS.some(key => Object.prototype.hasOwnProperty.call(body, key))
}

export interface NormalizedReview {
  trader: string
  date: string
  content: string
  tags: string[]
}

export function normalizeReviewWrite(body: ReviewWrite): { ok: true; value: NormalizedReview } | { ok: false; issue: RecordIssue } {
  const fields: FieldError[] = []
  pushDate(fields, 'date', body.date ?? '')
  const content = body.content ?? ''
  if (content.length < 1 || content.length > 20_000) fields.push({ path: 'content', message: '长度必须是 1 到 20000 个字符' })
  const tags = body.tags ?? []
  if (!Array.isArray(tags) || tags.length > 20) fields.push({ path: 'tags', message: '最多 20 个标签' })
  else {
    tags.forEach((tag, index) => {
      if (typeof tag !== 'string' || tag.length < 1 || tag.length > 30) {
        fields.push({ path: `tags[${index}]`, message: '每个标签长度必须是 1 到 30 个字符' })
      }
    })
  }
  let trader = ''
  if (!Object.prototype.hasOwnProperty.call(body, 'trader') || body.trader === undefined) {
    fields.push({ path: 'trader', message: '必填' })
  } else {
    const traderResult = normalizeTrader(body.trader)
    if (!traderResult.ok) fields.push(...traderResult.issue.fields)
    else trader = traderResult.value
  }
  if (fields.length > 0) {
    return { ok: false, issue: { status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields } }
  }
  return { ok: true, value: { trader, date: body.date, content, tags } }
}

export function patchTouchesReview(body: ReviewPatch): boolean {
  return (['trader', 'date', 'content', 'tags'] as const).some(key => Object.prototype.hasOwnProperty.call(body, key))
}

export function validateCodeFilter(code: string | undefined): RecordIssue | null {
  if (code == null || code === '') return null
  if (!/^[0-9]{6}$/.test(code)) {
    return {
      status: 422,
      code: 'VALIDATION_ERROR',
      message: '请求字段校验失败',
      fields: [{ path: 'code', message: '必须是六位数字代码' }],
    }
  }
  if (resolveSymbol(code) == null) {
    return {
      status: 422,
      code: 'INVALID_STOCK_CODE',
      message: '股票代码无法规范化',
      fields: [{ path: 'code', message: '无法识别交易所' }],
    }
  }
  return null
}
