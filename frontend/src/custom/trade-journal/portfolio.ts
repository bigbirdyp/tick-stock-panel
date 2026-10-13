import { holdingDays } from './calendar'
import { decFromNumber, decToNumber, divHalfAway, mulQty, ratio } from './money'
import type { HistoryRow, Position, PriceStatus, TradeRecord } from './types'

export interface QuoteMark {
  current_price: number | null
  price_source: string | null
  price_as_of: string | null
  price_status: PriceStatus
}

interface OpenLot {
  buyId: string
  openDate: string
  remainingQty: number
  remainingCost: bigint
}

export interface BuiltHistory extends HistoryRow {
  sell_trade_time: string | null
  sell_created_at: string
}

export interface Portfolio {
  ok: true
  positions: Position[]
  history: BuiltHistory[]
}

function cmpNullsLast(left: string | null, right: string | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareTradeOrder(left: TradeRecord, right: TradeRecord): number {
  if (left.trade_date !== right.trade_date) return left.trade_date < right.trade_date ? -1 : 1
  const time = cmpNullsLast(left.trade_time, right.trade_time)
  if (time !== 0) return time
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function unavailable(): QuoteMark {
  return { current_price: null, price_source: null, price_as_of: null, price_status: 'unavailable' }
}

function bookKey(trader: string, symbol: string): string {
  return `${trader}\u001f${symbol}`
}

/**
 * 按 docs/api.md §6 做 FIFO。账本键是 (trader, symbol)，不同交易者的同名股票不互相消耗。
 * 卖出超过未平仓数量时整笔失败，不产生部分持仓。
 * 对外历史行按卖出记录聚合，history_id 等于卖出记录 id。
 */
export function buildPortfolio(records: TradeRecord[], quotes: ReadonlyMap<string, QuoteMark>): Portfolio | { ok: false } {
  const ordered = [...records].sort(compareTradeOrder)
  const lots = new Map<string, { trader: string; symbol: string; book: OpenLot[] }>()
  const history: BuiltHistory[] = []

  for (const record of ordered) {
    const key = bookKey(record.trader, record.symbol)
    const entry = lots.get(key) ?? { trader: record.trader, symbol: record.symbol, book: [] }
    const book = entry.book
    if (record.side === 'buy') {
      const price = decFromNumber(record.price, 4)
      const fee = decFromNumber(record.fee, 2)
      const tax = decFromNumber(record.tax, 2)
      if (price == null || fee == null || tax == null) return { ok: false }
      book.push({
        buyId: record.id,
        openDate: record.trade_date,
        remainingQty: record.quantity,
        remainingCost: mulQty(price, record.quantity) + fee + tax,
      })
      lots.set(key, entry)
      continue
    }

    let need = record.quantity
    const openQty = book.reduce((sum, lot) => sum + lot.remainingQty, 0)
    if (need > openQty) return { ok: false }
    const price = decFromNumber(record.price, 4)
    const fee = decFromNumber(record.fee, 2)
    const tax = decFromNumber(record.tax, 2)
    if (price == null || fee == null || tax == null) return { ok: false }
    let consumed = 0n
    const buyIds: string[] = []
    let openDate = record.trade_date
    const next: OpenLot[] = []
    for (const lot of book) {
      if (need === 0) {
        next.push(lot)
        continue
      }
      const matched = Math.min(lot.remainingQty, need)
      const taken = matched === lot.remainingQty
        ? lot.remainingCost
        : divHalfAway(lot.remainingCost * BigInt(matched), BigInt(lot.remainingQty))
      consumed += taken
      if (!buyIds.includes(lot.buyId)) buyIds.push(lot.buyId)
      if (lot.openDate < openDate) openDate = lot.openDate
      const leftQty = lot.remainingQty - matched
      if (leftQty > 0) {
        next.push({ ...lot, remainingQty: leftQty, remainingCost: lot.remainingCost - taken })
      }
      need -= matched
    }
    lots.set(key, { ...entry, book: next })
    const exitAmount = mulQty(price, record.quantity) - fee - tax
    const pnl = exitAmount - consumed
    history.push({
      history_id: record.id,
      sell_record_id: record.id,
      buy_record_ids: buyIds,
      trader: record.trader,
      code: record.code,
      symbol: record.symbol,
      name: record.name,
      open_date: openDate,
      close_date: record.trade_date,
      quantity: record.quantity,
      cost: decToNumber(divHalfAway(consumed, BigInt(record.quantity)), 4),
      exit_price: record.price,
      cost_amount: decToNumber(consumed, 2),
      exit_amount: decToNumber(exitAmount, 2),
      realized_pnl: decToNumber(pnl, 2),
      return_rate: ratio(pnl, consumed, 6),
      holding_days: holdingDays(openDate, record.trade_date),
      sell_trade_time: record.trade_time,
      sell_created_at: record.created_at,
    })
  }

  const positions: Position[] = []
  for (const [key, entry] of lots) {
    const { trader, symbol, book } = entry
    const open = book.filter(lot => lot.remainingQty > 0)
    if (open.length === 0) continue
    const quantity = open.reduce((sum, lot) => sum + lot.remainingQty, 0)
    const costAmount = open.reduce((sum, lot) => sum + lot.remainingCost, 0n)
    const related = ordered.filter(record => record.trader === trader && record.symbol === symbol)
    const latest = related[related.length - 1]
    const quote = quotes.get(symbol) ?? unavailable()
    const priceMicro = quote.current_price == null ? null : decFromNumber(quote.current_price, 4)
    const priced = quote.price_status !== 'unavailable' && priceMicro != null
    const market = priced ? mulQty(priceMicro, quantity) : null
    const unrealized = market == null ? null : market - costAmount
    positions.push({
      position_key: key,
      trader,
      code: latest?.code ?? symbol.slice(0, 6),
      symbol,
      name: latest?.name ?? symbol,
      open_date: open.reduce((min, lot) => (lot.openDate < min ? lot.openDate : min), open[0].openDate),
      quantity,
      cost: decToNumber(divHalfAway(costAmount, BigInt(quantity)), 4),
      cost_amount: decToNumber(costAmount, 2),
      current_price: priced ? quote.current_price : null,
      price_source: priced ? quote.price_source : null,
      price_as_of: priced ? quote.price_as_of : null,
      price_status: priced ? quote.price_status : 'unavailable',
      market_value: market == null ? null : decToNumber(market, 2),
      unrealized_pnl: unrealized == null ? null : decToNumber(unrealized, 2),
      return_rate: unrealized == null ? null : ratio(unrealized, costAmount, 6),
    })
  }

  return { ok: true, positions, history }
}

export function stripHistory(rows: BuiltHistory[]): HistoryRow[] {
  return rows.map(row => ({
    history_id: row.history_id,
    sell_record_id: row.sell_record_id,
    buy_record_ids: row.buy_record_ids,
    trader: row.trader,
    code: row.code,
    symbol: row.symbol,
    name: row.name,
    open_date: row.open_date,
    close_date: row.close_date,
    quantity: row.quantity,
    cost: row.cost,
    exit_price: row.exit_price,
    cost_amount: row.cost_amount,
    exit_amount: row.exit_amount,
    realized_pnl: row.realized_pnl,
    return_rate: row.return_rate,
    holding_days: row.holding_days,
  }))
}

/** 升降序都把空时间放在最后，避免降序把 null 翻到最前。 */
function cmpDirectedNullsLast(left: string | null, right: string | null, descending: boolean): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  if (left === right) return 0
  const asc = left < right ? -1 : 1
  return descending ? -asc : asc
}

export function compareHistory(left: BuiltHistory, right: BuiltHistory, descending: boolean): number {
  const dir = descending ? -1 : 1
  if (left.close_date !== right.close_date) return left.close_date < right.close_date ? -dir : dir
  const time = cmpDirectedNullsLast(left.sell_trade_time, right.sell_trade_time, descending)
  if (time !== 0) return time
  if (left.sell_created_at !== right.sell_created_at) {
    return left.sell_created_at < right.sell_created_at ? -dir : dir
  }
  if (left.sell_record_id === right.sell_record_id) return 0
  return left.sell_record_id < right.sell_record_id ? -dir : dir
}
