import type { ChartMarker } from '@/components/EChartsCandlestick'
import { fmtPrice } from '@/lib/format'
import type { TradeJournalApi, TradeRecord } from './types'

/** 成交标记分页与记录列表接口上限一致，调用方不得再改小后静默丢掉后页。 */
export const STOCK_MARKER_PAGE_LIMIT = 200

type MarkerQuery = { purpose: 'kline-markers'; code: string; trader: string }
type PriceAgg = { lo: number; hi: number; quantity: number }

/**
 * 查询键要同时带上股票、交易员和用途。
 * 与交易记录表的筛选键分开，避免「全部」或别的分页结果被当成这张图的标记。
 */
export function stockMarkerQueryString(code: string, trader: string): string {
  return JSON.stringify({ purpose: 'kline-markers', code, trader } satisfies MarkerQuery)
}

export function parseStockMarkerQuery(query: string): MarkerQuery {
  const value: unknown = JSON.parse(query)
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('成交标记查询无效')
  const row = value as { purpose?: unknown; code?: unknown; trader?: unknown }
  if (row.purpose !== 'kline-markers' || typeof row.code !== 'string' || typeof row.trader !== 'string') {
    throw new Error('成交标记查询无效')
  }
  return { purpose: 'kline-markers', code: row.code, trader: row.trader }
}

function assertMarkerScope(code: string, trader: string): void {
  // 「全部」没有 trader。此时不能发请求，否则会把所有人的成交画到同一张图上。
  if (!/^[0-9]{6}$/.test(code) || trader.trim() === '') throw new Error('成交标记需要具体股票和交易员')
}

function ownsRecord(record: TradeRecord, code: string, trader: string): boolean {
  return record.trader === trader && record.code.slice(0, 6) === code && record.symbol.slice(0, 6) === code
}

function markerLabel(side: 'buy' | 'sell', agg: PriceAgg): string {
  const price = agg.lo === agg.hi ? fmtPrice(agg.lo) : `${fmtPrice(agg.lo)}~${fmtPrice(agg.hi)}`
  return `${side === 'buy' ? '买' : '卖'} ${price} ×${agg.quantity}`
}

/**
 * 同日同向合并成一个日期箭头：标签写买/卖、原始成交价区间和数量。
 * 不属于当前股票或交易员的记录不进入标签。不写 above，避免按未复权价去定价格线。
 */
export function tradeRecordsToMarkers(records: readonly TradeRecord[], code: string, trader: string): ChartMarker[] {
  const byDate = new Map<string, { buy?: PriceAgg; sell?: PriceAgg }>()
  for (const record of records) {
    if (!ownsRecord(record, code, trader)) continue
    if (!Number.isFinite(record.price) || (record.side !== 'buy' && record.side !== 'sell')) {
      throw new Error('成交记录缺少可用的价格或方向')
    }
    const date = record.trade_date.slice(0, 10)
    let group = byDate.get(date)
    if (!group) {
      group = {}
      byDate.set(date, group)
    }
    const current = group[record.side]
    if (current) {
      current.lo = Math.min(current.lo, record.price)
      current.hi = Math.max(current.hi, record.price)
      current.quantity += record.quantity
    } else {
      group[record.side] = { lo: record.price, hi: record.price, quantity: record.quantity }
    }
  }
  const markers: ChartMarker[] = []
  for (const [date, group] of byDate) {
    if (group.buy) markers.push({ date, kind: 'buy', label: markerLabel('buy', group.buy) })
    if (group.sell) markers.push({ date, kind: 'sell', label: markerLabel('sell', group.sell) })
  }
  markers.sort((left, right) => left.date.localeCompare(right.date) || (left.kind === right.kind ? 0 : left.kind === 'buy' ? -1 : 1))
  return markers
}

/**
 * 按 200 条一页读完该股票、该交易员的全部逐笔。只读，不改记录。
 * 页没前进、总数对不上、或记录不属于这次查询时直接失败，不把半截结果当成零成交。
 */
export async function loadStockMarkerSet(
  listRecords: TradeJournalApi['listRecords'],
  code: string,
  trader: string,
): Promise<{ code: string; trader: string; markers: ChartMarker[] }> {
  assertMarkerScope(code, trader)
  const records: TradeRecord[] = []
  let offset = 0
  for (;;) {
    if (offset > 1_000_000) throw new Error('成交标记分页没有结束')
    const response = await listRecords({
      trader,
      code,
      limit: STOCK_MARKER_PAGE_LIMIT,
      offset,
      sort: 'trade_date_asc',
    })
    const page = response.data.records
    const pagination = response.data.pagination
    if (pagination.offset !== offset || pagination.limit !== STOCK_MARKER_PAGE_LIMIT) {
      throw new Error('成交标记分页偏移不一致')
    }
    for (const record of page) {
      if (!ownsRecord(record, code, trader)) throw new Error('成交记录与当前股票或交易员不一致')
    }
    records.push(...page)
    if (!pagination.has_more) {
      if (records.length !== pagination.total) throw new Error('成交标记没有读全')
      return { code, trader, markers: tradeRecordsToMarkers(records, code, trader) }
    }
    if (page.length === 0 || records.length >= pagination.total) throw new Error('成交标记分页没有继续')
    const nextOffset = offset + page.length
    if (nextOffset <= offset) throw new Error('成交标记分页没有前进')
    offset = nextOffset
  }
}
