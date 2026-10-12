import { shanghaiNowIso, shanghaiToday } from './calendar'
import { TradeJournalError } from './errors'
import { decToNumber } from './money'
import { buildPortfolio, compareHistory, stripHistory, type QuoteMark } from './portfolio'
import type {
  ApiSuccess,
  DailyReview,
  HistoryList,
  HistoryQuery,
  PositionList,
  PositionQuery,
  RecordList,
  RecordListQuery,
  RecordPatch,
  RecordWrite,
  ReviewList,
  ReviewListQuery,
  ReviewPatch,
  ReviewWrite,
  TradeJournalApi,
  TradeRecord,
} from './types'
import {
  historySorts,
  normalizeRecordWrite,
  normalizeReviewWrite,
  patchTouchesRecord,
  patchTouchesReview,
  positionSorts,
  recordSorts,
  reviewSorts,
  validateCodeFilter,
  validateDateRange,
  validatePage,
  validateSort,
  type NormalizedRecord,
  type RecordIssue,
} from './validate'

interface Idempotency {
  fingerprint: string
  id: string
}

const QUOTES = new Map<string, QuoteMark>([
  ['600519.SH', {
    current_price: 1712.3,
    price_source: 'local_daily',
    price_as_of: '2026-10-12T15:00:00+08:00',
    price_status: 'fresh',
  }],
])

/**
 * 行情日历日晚于 as_of 时不用，避免用未来价格估算历史市值。
 * 早于 as_of 的可用价仍返回，但标为 stale。本 mock 只有一条行情，
 * 任何更晚的 as_of 都按过期处理，不推断交易日历。
 */
function quotesOnOrBefore(asOf: string): Map<string, QuoteMark> {
  const usable = new Map<string, QuoteMark>()
  for (const [symbol, quote] of QUOTES) {
    if (quote.price_as_of == null || quote.current_price == null || quote.price_status === 'unavailable') continue
    const parsed = new Date(quote.price_as_of)
    if (Number.isNaN(parsed.getTime())) continue
    const quoteDay = shanghaiToday(parsed)
    if (quoteDay > asOf) continue
    usable.set(symbol, quoteDay < asOf ? { ...quote, price_status: 'stale' } : quote)
  }
  return usable
}

function fail(issue: RecordIssue): never {
  throw new TradeJournalError(issue.status, issue.code, issue.message, issue.fields)
}

function ok<T>(data: T, status = 200, duplicate = false): ApiSuccess<T> {
  return { data, meta: { duplicate }, status }
}

function pageOf<T>(rows: T[], limit: number | undefined, offset: number | undefined) {
  const issue = validatePage(limit, offset)
  if (issue) fail(issue)
  const resolvedLimit = limit ?? 50
  const resolvedOffset = offset ?? 0
  return {
    rows: rows.slice(resolvedOffset, resolvedOffset + resolvedLimit),
    pagination: {
      limit: resolvedLimit,
      offset: resolvedOffset,
      total: rows.length,
      has_more: resolvedOffset + resolvedLimit < rows.length,
    },
  }
}

function cmpDirected(left: string | null, right: string | null, descending: boolean): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  if (left === right) return 0
  const asc = left < right ? -1 : 1
  return descending ? -asc : asc
}

function sortRecords(rows: TradeRecord[], sort: string): TradeRecord[] {
  const descending = sort !== 'trade_date_asc'
  const dir = descending ? -1 : 1
  return [...rows].sort((left, right) => {
    if (left.trade_date !== right.trade_date) return left.trade_date < right.trade_date ? -dir : dir
    const time = cmpDirected(left.trade_time, right.trade_time, descending)
    if (time !== 0) return time
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -dir : dir
    if (left.id === right.id) return 0
    return left.id < right.id ? -dir : dir
  })
}

function toRecord(id: string, version: number, normalized: NormalizedRecord, createdAt: string, updatedAt: string): TradeRecord {
  return {
    id,
    version,
    trade_date: normalized.trade_date,
    trade_time: normalized.trade_time,
    code: normalized.code,
    symbol: normalized.symbol,
    name: normalized.name,
    side: normalized.side,
    price: decToNumber(normalized.priceMicro, 4),
    quantity: normalized.quantity,
    fee: decToNumber(normalized.feeMicro, 2),
    tax: decToNumber(normalized.taxMicro, 2),
    note: normalized.note,
    client_request_id: normalized.client_request_id,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function assertBook(records: TradeRecord[]) {
  const built = buildPortfolio(records, QUOTES)
  if (!built.ok) {
    throw new TradeJournalError(409, 'INSUFFICIENT_POSITION', '卖出、修改或删除会导致持仓为负')
  }
}

let idSeq = 0
function nextId(prefix: 'rec' | 'rev'): string {
  idSeq += 1
  return `${prefix}_${idSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function createMockTradeJournal(seeded = false): TradeJournalApi {
  const records = new Map<string, TradeRecord>()
  const reviews = new Map<string, DailyReview>()
  const idempotency = new Map<string, Idempotency>()

  const api: TradeJournalApi = {
    mode: 'mock',

    async listRecords(query: RecordListQuery) {
      const pageIssue = validatePage(query.limit, query.offset)
      if (pageIssue) fail(pageIssue)
      const range = validateDateRange(query.from, query.to)
      if (range) fail(range)
      const sortIssue = validateSort(query.sort, recordSorts())
      if (sortIssue) fail(sortIssue)
      const codeIssue = validateCodeFilter(query.code)
      if (codeIssue) fail(codeIssue)
      if (query.date != null) {
        const dateIssue = validateDateRange(query.date, query.date)
        if (dateIssue) fail({ ...dateIssue, fields: dateIssue.fields.map(field => ({ ...field, path: 'date' })) })
      }
      if (query.side != null && query.side !== 'buy' && query.side !== 'sell') {
        fail({ status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields: [{ path: 'side', message: '只能是 buy 或 sell' }] })
      }
      const filtered = [...records.values()].filter(record => {
        if (query.date != null && record.trade_date !== query.date) return false
        if (query.from != null && record.trade_date < query.from) return false
        if (query.to != null && record.trade_date > query.to) return false
        if (query.code != null && query.code !== '' && record.code !== query.code) return false
        if (query.side != null && record.side !== query.side) return false
        return true
      })
      const sorted = sortRecords(filtered, query.sort ?? 'trade_date_desc')
      const page = pageOf(sorted, query.limit, query.offset)
      const data: RecordList = { records: page.rows, pagination: page.pagination }
      return ok(data)
    },

    async createRecord(body: RecordWrite) {
      const normalized = normalizeRecordWrite(body)
      if (!normalized.ok) fail(normalized.issue)
      const value = normalized.value
      if (value.client_request_id) {
        const prior = idempotency.get(value.client_request_id)
        if (prior) {
          if (prior.fingerprint !== value.fingerprint) {
            throw new TradeJournalError(409, 'DUPLICATE_RECORD', 'client_request_id 已用于不同的交易记录')
          }
          const existing = records.get(prior.id)
          if (!existing) throw new TradeJournalError(404, 'NOT_FOUND', '记录不存在')
          return ok(existing, 200, true)
        }
      }
      const createdAt = shanghaiNowIso()
      const record = toRecord(nextId('rec'), 1, value, createdAt, createdAt)
      const next = [...records.values(), record]
      assertBook(next)
      records.set(record.id, record)
      if (value.client_request_id) {
        idempotency.set(value.client_request_id, { fingerprint: value.fingerprint, id: record.id })
      }
      return ok(record, 201, false)
    },

    async patchRecord(id: string, body: RecordPatch) {
      if (typeof body.expected_version !== 'number' || !Number.isInteger(body.expected_version)) {
        throw new TradeJournalError(428, 'PRECONDITION_REQUIRED', '修改必须提供 expected_version')
      }
      const current = records.get(id)
      if (!current) throw new TradeJournalError(404, 'NOT_FOUND', '记录不存在')
      if (current.version !== body.expected_version) {
        throw new TradeJournalError(409, 'VERSION_CONFLICT', '记录版本已变化，请重新加载后再提交')
      }
      if (!patchTouchesRecord(body)) {
        fail({ status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields: [{ path: 'expected_version', message: '至少修改一个字段' }] })
      }
      const merged: RecordWrite = {
        trade_date: body.trade_date ?? current.trade_date,
        trade_time: Object.prototype.hasOwnProperty.call(body, 'trade_time') ? body.trade_time : current.trade_time,
        code: body.code ?? current.code,
        symbol: body.symbol,
        name: body.name ?? current.name,
        side: body.side ?? current.side,
        price: body.price ?? current.price,
        quantity: body.quantity ?? current.quantity,
        fee: body.fee ?? current.fee,
        tax: body.tax ?? current.tax,
        note: Object.prototype.hasOwnProperty.call(body, 'note') ? body.note : current.note,
        client_request_id: Object.prototype.hasOwnProperty.call(body, 'client_request_id') ? body.client_request_id : current.client_request_id,
      }
      const normalized = normalizeRecordWrite(merged)
      if (!normalized.ok) fail(normalized.issue)
      const value = normalized.value
      if (value.client_request_id) {
        const prior = idempotency.get(value.client_request_id)
        if (prior && prior.id !== id) {
          throw new TradeJournalError(409, 'DUPLICATE_RECORD', 'client_request_id 已用于不同的交易记录')
        }
      }
      const updated = toRecord(id, current.version + 1, value, current.created_at, shanghaiNowIso())
      const next = [...records.values()].map(record => (record.id === id ? updated : record))
      assertBook(next)
      if (current.client_request_id && current.client_request_id !== value.client_request_id) {
        idempotency.delete(current.client_request_id)
      }
      if (value.client_request_id) {
        idempotency.set(value.client_request_id, { fingerprint: value.fingerprint, id })
      }
      records.set(id, updated)
      return ok(updated)
    },

    async deleteRecord(id: string, expectedVersion: number | undefined) {
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
        throw new TradeJournalError(428, 'PRECONDITION_REQUIRED', '删除必须提供 expected_version')
      }
      const current = records.get(id)
      if (!current) throw new TradeJournalError(404, 'NOT_FOUND', '记录不存在')
      if (current.version !== expectedVersion) {
        throw new TradeJournalError(409, 'VERSION_CONFLICT', '记录版本已变化，请重新加载后再提交')
      }
      const next = [...records.values()].filter(record => record.id !== id)
      assertBook(next)
      records.delete(id)
      if (current.client_request_id) idempotency.delete(current.client_request_id)
    },

    async listReviews(query: ReviewListQuery) {
      const range = validateDateRange(query.from, query.to)
      if (range) fail(range)
      const sortIssue = validateSort(query.sort, reviewSorts())
      if (sortIssue) fail(sortIssue)
      if (query.date != null) {
        const dateIssue = validateDateRange(query.date, query.date)
        if (dateIssue) fail({ ...dateIssue, code: 'VALIDATION_ERROR', fields: [{ path: 'date', message: '必须是 YYYY-MM-DD 格式' }] })
      }
      const filtered = [...reviews.values()].filter(review => {
        if (query.date != null && review.date !== query.date) return false
        if (query.from != null && review.date < query.from) return false
        if (query.to != null && review.date > query.to) return false
        if (query.tag != null && query.tag !== '' && !review.tags.includes(query.tag)) return false
        return true
      })
      const descending = (query.sort ?? 'date_desc') !== 'date_asc'
      const dir = descending ? -1 : 1
      const sorted = [...filtered].sort((left, right) => {
        if (left.date !== right.date) return left.date < right.date ? -dir : dir
        if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -dir : dir
        if (left.id === right.id) return 0
        return left.id < right.id ? -dir : dir
      })
      const page = pageOf(sorted, query.limit, query.offset)
      const data: ReviewList = { reviews: page.rows, pagination: page.pagination }
      return ok(data)
    },

    async createReview(body: ReviewWrite) {
      const normalized = normalizeReviewWrite(body)
      if (!normalized.ok) fail(normalized.issue)
      if ([...reviews.values()].some(review => review.date === normalized.value.date)) {
        throw new TradeJournalError(409, 'DUPLICATE_REVIEW', '这一天已经有复盘')
      }
      const createdAt = shanghaiNowIso()
      const review: DailyReview = {
        id: nextId('rev'),
        version: 1,
        date: normalized.value.date,
        content: normalized.value.content,
        tags: normalized.value.tags,
        created_at: createdAt,
        updated_at: createdAt,
      }
      reviews.set(review.id, review)
      return ok(review, 201, false)
    },

    async patchReview(id: string, body: ReviewPatch) {
      if (typeof body.expected_version !== 'number' || !Number.isInteger(body.expected_version)) {
        throw new TradeJournalError(428, 'PRECONDITION_REQUIRED', '修改必须提供 expected_version')
      }
      const current = reviews.get(id)
      if (!current) throw new TradeJournalError(404, 'NOT_FOUND', '复盘不存在')
      if (current.version !== body.expected_version) {
        throw new TradeJournalError(409, 'VERSION_CONFLICT', '复盘版本已变化，请重新加载后再提交')
      }
      if (!patchTouchesReview(body)) {
        fail({ status: 422, code: 'VALIDATION_ERROR', message: '请求字段校验失败', fields: [{ path: 'expected_version', message: '至少修改一个字段' }] })
      }
      const merged: ReviewWrite = {
        date: body.date ?? current.date,
        content: body.content ?? current.content,
        tags: body.tags ?? current.tags,
      }
      const normalized = normalizeReviewWrite(merged)
      if (!normalized.ok) fail(normalized.issue)
      if ([...reviews.values()].some(review => review.id !== id && review.date === normalized.value.date)) {
        throw new TradeJournalError(409, 'DUPLICATE_REVIEW', '这一天已经有复盘')
      }
      const updated: DailyReview = {
        ...current,
        ...normalized.value,
        version: current.version + 1,
        updated_at: shanghaiNowIso(),
      }
      reviews.set(id, updated)
      return ok(updated)
    },

    async deleteReview(id: string, expectedVersion: number | undefined) {
      if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
        throw new TradeJournalError(428, 'PRECONDITION_REQUIRED', '删除必须提供 expected_version')
      }
      const current = reviews.get(id)
      if (!current) throw new TradeJournalError(404, 'NOT_FOUND', '复盘不存在')
      if (current.version !== expectedVersion) {
        throw new TradeJournalError(409, 'VERSION_CONFLICT', '复盘版本已变化，请重新加载后再提交')
      }
      reviews.delete(id)
    },

    async currentPositions(query: PositionQuery) {
      const range = query.as_of == null ? null : validateDateRange(query.as_of, query.as_of)
      if (range) fail({ ...range, fields: [{ path: 'as_of', message: range.fields[0]?.message ?? '日期无效' }] })
      const sortIssue = validateSort(query.sort, positionSorts())
      if (sortIssue) fail(sortIssue)
      const codeIssue = validateCodeFilter(query.code)
      if (codeIssue) fail(codeIssue)
      const asOf = query.as_of ?? shanghaiToday()
      const included = [...records.values()].filter(record => record.trade_date <= asOf)
      const built = buildPortfolio(included, quotesOnOrBefore(asOf))
      if (!built.ok) throw new TradeJournalError(500, 'INTERNAL_ERROR', '持仓计算失败')
      let positions = built.positions
      if (query.code) positions = positions.filter(position => position.code === query.code)
      const sort = query.sort ?? 'symbol_asc'
      positions = [...positions].sort((left, right) => {
        const tie = left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : left.position_key < right.position_key ? -1 : 1
        if (sort === 'symbol_asc') return tie
        const value = sort === 'market_value_desc' ? 'market_value' : 'return_rate'
        const lv = left[value]
        const rv = right[value]
        if (lv == null && rv == null) return tie
        if (lv == null) return 1
        if (rv == null) return -1
        if (lv !== rv) return rv - lv
        return tie
      })
      const page = pageOf(positions, query.limit, query.offset)
      const data: PositionList = { as_of: asOf, positions: page.rows, pagination: page.pagination }
      return ok(data)
    },

    async history(query: HistoryQuery) {
      const range = validateDateRange(query.from, query.to)
      if (range) fail(range)
      const sortIssue = validateSort(query.sort, historySorts())
      if (sortIssue) fail(sortIssue)
      const codeIssue = validateCodeFilter(query.code)
      if (codeIssue) fail(codeIssue)
      const built = buildPortfolio([...records.values()], QUOTES)
      if (!built.ok) throw new TradeJournalError(500, 'INTERNAL_ERROR', '收益计算失败')
      let rows = built.history
      if (query.from) rows = rows.filter(row => row.close_date >= query.from!)
      if (query.to) rows = rows.filter(row => row.close_date <= query.to!)
      if (query.code) rows = rows.filter(row => row.code === query.code)
      const descending = (query.sort ?? 'close_date_desc') !== 'close_date_asc'
      rows = [...rows].sort((left, right) => compareHistory(left, right, descending))
      const page = pageOf(rows, query.limit, query.offset)
      const data: HistoryList = { history: stripHistory(page.rows), pagination: page.pagination }
      return ok(data)
    },
  }

  if (seeded) {
    putRecord({
      id: 'rec_01HZ8VCY6N4Q6Y7Z4R0ME2P1XA',
      created_at: '2026-09-28T09:31:08+08:00',
      body: {
        trade_date: '2026-09-28',
        trade_time: '09:31:00',
        code: '000001',
        name: '平安银行',
        side: 'buy',
        price: 10.8,
        quantity: 600,
        fee: 3,
        tax: 0,
        client_request_id: 'seed-pingan-buy-1',
      },
    })
    putRecord({
      id: 'rec_01HZA9Z4D7Q8R2B1K6V0MN5P3C',
      created_at: '2026-09-28T10:05:08+08:00',
      body: {
        trade_date: '2026-09-28',
        trade_time: '10:05:00',
        code: '000001',
        name: '平安银行',
        side: 'buy',
        price: 10.8,
        quantity: 400,
        fee: 2,
        tax: 0,
        client_request_id: 'seed-pingan-buy-2',
      },
    })
    putRecord({
      id: 'rec_01HZZ1H7S4J9T7R5P0A2BV6F9K',
      created_at: '2026-10-12T14:50:08+08:00',
      body: {
        trade_date: '2026-10-12',
        trade_time: '14:50:00',
        code: '000001',
        name: '平安银行',
        side: 'sell',
        price: 11.26,
        quantity: 1000,
        fee: 5,
        tax: 0,
        client_request_id: 'seed-pingan-sell',
      },
    })
    putRecord({
      id: 'rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C',
      created_at: '2026-10-12T10:35:30+08:00',
      body: {
        trade_date: '2026-10-12',
        trade_time: '10:35:12',
        code: '600519',
        name: '贵州茅台',
        side: 'buy',
        price: 1688.5,
        quantity: 100,
        fee: 5,
        tax: 0,
        note: '突破前高后小仓位试单',
        client_request_id: 'web-20261012-0001',
      },
    })
    reviews.set('rev_01HZY9QX6M5X7ER2DK2H9K6B8V', {
      id: 'rev_01HZY9QX6M5X7ER2DK2H9K6B8V',
      version: 1,
      date: '2026-10-12',
      content: '指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。',
      tags: ['缩量', '题材分歧', '等待确认'],
      created_at: '2026-10-12T20:20:00+08:00',
      updated_at: '2026-10-12T20:20:00+08:00',
    })
  }

  return api

  function putRecord(input: { id: string; created_at: string; body: RecordWrite }) {
    const normalized = normalizeRecordWrite(input.body)
    if (!normalized.ok) throw new Error(normalized.issue.message)
    const record = toRecord(input.id, 1, normalized.value, input.created_at, input.created_at)
    records.set(record.id, record)
    if (normalized.value.client_request_id) {
      idempotency.set(normalized.value.client_request_id, {
        fingerprint: normalized.value.fingerprint,
        id: record.id,
      })
    }
  }
}
