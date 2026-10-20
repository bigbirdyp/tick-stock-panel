import type { ChartMarker, ChartTradeDetail } from '@/components/EChartsCandlestick'
import type { TradeJournalApi, TradeRecord } from './types'

/** 成交标记分页与记录列表接口上限一致，调用方不得再改小后静默丢掉后页。 */
export const STOCK_MARKER_PAGE_LIMIT = 200

type MarkerQuery =
  | { purpose: 'kline-markers'; scope: 'all'; code: string }
  | { purpose: 'kline-markers'; scope: 'trader'; code: string; trader: string }

export type StockMarkerSet =
  | { code: string; scope: 'all'; markers: ChartMarker[] }
  | { code: string; scope: 'trader'; trader: string; markers: ChartMarker[] }

/**
 * 查询键同时带上股票、范围和用途。
 * scope=all 表示全部交易员，不把「全部」写进 trader，避免和真名撞车。
 * 与交易记录表的筛选键分开，避免别的分页结果被当成这张图的标记。
 */
export function stockMarkerQueryString(code: string, trader: string | undefined): string {
  const query: MarkerQuery = trader == null
    ? { purpose: 'kline-markers', scope: 'all', code }
    : { purpose: 'kline-markers', scope: 'trader', code, trader }
  return JSON.stringify(query)
}

export function parseStockMarkerQuery(query: string): MarkerQuery {
  const value: unknown = JSON.parse(query)
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('成交标记查询无效')
  const row = value as { purpose?: unknown; scope?: unknown; code?: unknown; trader?: unknown }
  if (row.purpose !== 'kline-markers' || typeof row.code !== 'string') throw new Error('成交标记查询无效')
  if (row.scope === 'all') {
    if (Object.prototype.hasOwnProperty.call(row, 'trader')) throw new Error('成交标记查询无效')
    return { purpose: 'kline-markers', scope: 'all', code: row.code }
  }
  if (row.scope === 'trader' && typeof row.trader === 'string' && row.trader.trim() !== '') {
    return { purpose: 'kline-markers', scope: 'trader', code: row.code, trader: row.trader }
  }
  throw new Error('成交标记查询无效')
}

function assertMarkerScope(code: string, trader: string | undefined): void {
  // 空白名字不是「全部」。全部只认缺省 trader；具体名字哪怕就叫「全部」也要原样过滤。
  if (!/^[0-9]{6}$/.test(code) || (trader != null && trader.trim() === '')) {
    throw new Error('成交标记需要具体股票和交易员')
  }
}

function matchesStock(record: TradeRecord, code: string): boolean {
  return record.code.slice(0, 6) === code && record.symbol.slice(0, 6) === code
}

function matchesScope(record: TradeRecord, code: string, trader: string | undefined): boolean {
  return matchesStock(record, code) && (trader == null || record.trader === trader)
}

function markerKind(trades: readonly ChartTradeDetail[]): { kind: ChartMarker['kind']; label: string } {
  const hasBuy = trades.some(trade => trade.side === 'buy')
  const hasSell = trades.some(trade => trade.side === 'sell')
  if (hasBuy && hasSell) return { kind: 'neutral', label: '买/卖' }
  if (hasBuy) return { kind: 'buy', label: '买' }
  return { kind: 'sell', label: '卖' }
}

/**
 * 同一天合成一个标记，逐笔原样留下，不把价格收成区间，也不把数量加总。
 * 只买、只卖、买卖都有，分别标成买、卖、买/卖。不属于当前股票的记录不进入标记；
 * 指定交易员时，其它交易员也不进入。不写 above，避免按未复权价去定价格线。
 */
export function tradeRecordsToMarkers(records: readonly TradeRecord[], code: string, trader: string | undefined): ChartMarker[] {
  const byDate = new Map<string, ChartTradeDetail[]>()
  for (const record of records) {
    if (!matchesScope(record, code, trader)) continue
    if (!Number.isFinite(record.price) || (record.side !== 'buy' && record.side !== 'sell')) {
      throw new Error('成交记录缺少可用的价格或方向')
    }
    const date = record.trade_date.slice(0, 10)
    const trade: ChartTradeDetail = {
      date,
      side: record.side,
      price: record.price,
      quantity: record.quantity,
      trader: record.trader,
    }
    const group = byDate.get(date)
    if (group) group.push(trade)
    else byDate.set(date, [trade])
  }
  const markers: ChartMarker[] = []
  for (const [date, trades] of byDate) {
    const { kind, label } = markerKind(trades)
    markers.push({ date, kind, label, trades })
  }
  markers.sort((left, right) => left.date.localeCompare(right.date))
  return markers
}

/** 换股或换人后，只有 code 和 scope 都对得上当前选择才可以显示，避免旧缓存闪一下。 */
export function stockMarkerSetMatches(data: StockMarkerSet | undefined, code: string, trader: string | undefined): data is StockMarkerSet {
  if (data == null || data.code !== code) return false
  if (trader == null) return data.scope === 'all'
  return data.scope === 'trader' && data.trader === trader
}

/**
 * 按 200 条一页读完该股票的逐笔。trader 缺省时不传 trader，读全部交易员；传入时只读本人。
 * 只读，不改记录。页没前进、总数对不上、或股票对不上时直接失败，不把半截结果当成零成交。
 * 全部只放宽交易员，股票仍然必须是当前代码，并且每笔自己的 trader 留在标记里。
 */
export async function loadStockMarkerSet(
  listRecords: TradeJournalApi['listRecords'],
  code: string,
  trader: string | undefined,
): Promise<StockMarkerSet> {
  assertMarkerScope(code, trader)
  const records: TradeRecord[] = []
  let offset = 0
  for (;;) {
    if (offset > 1_000_000) throw new Error('成交标记分页没有结束')
    const response = await listRecords({
      code,
      limit: STOCK_MARKER_PAGE_LIMIT,
      offset,
      sort: 'trade_date_asc',
      ...(trader == null ? {} : { trader }),
    })
    const page = response.data.records
    const pagination = response.data.pagination
    if (pagination.offset !== offset || pagination.limit !== STOCK_MARKER_PAGE_LIMIT) {
      throw new Error('成交标记分页偏移不一致')
    }
    for (const record of page) {
      if (!matchesScope(record, code, trader)) throw new Error('成交记录与当前股票或交易员不一致')
    }
    records.push(...page)
    if (!pagination.has_more) {
      if (records.length !== pagination.total) throw new Error('成交标记没有读全')
      const markers = tradeRecordsToMarkers(records, code, trader)
      return trader == null ? { code, scope: 'all', markers } : { code, scope: 'trader', trader, markers }
    }
    if (page.length === 0 || records.length >= pagination.total) throw new Error('成交标记分页没有继续')
    const nextOffset = offset + page.length
    if (nextOffset <= offset) throw new Error('成交标记分页没有前进')
    offset = nextOffset
  }
}
