/** docs/api.md 交易日记契约类型。字段名与可空性按该文档，不另起一套。 */

export type Side = 'buy' | 'sell'
export type PriceStatus = 'fresh' | 'stale' | 'unavailable'
export type RecordSort = 'trade_date_desc' | 'trade_date_asc'
export type ReviewSort = 'date_desc' | 'date_asc'
export type PositionSort = 'symbol_asc' | 'market_value_desc' | 'return_rate_desc'
export type HistorySort = 'close_date_desc' | 'close_date_asc'

/** §8 只把缺失或非法的旧记录回填成这个字面量。新建记录不得把它当缺省值。 */
export const LEGACY_TRADER_LABEL = '未指定'

export interface Pagination {
  limit: number
  offset: number
  total: number
  has_more: boolean
}

export interface FieldError {
  path: string
  message: string
}

export interface TradeRecord {
  id: string
  version: number
  trader: string
  trade_date: string
  trade_time: string | null
  code: string
  symbol: string
  name: string
  side: Side
  price: number
  quantity: number
  fee: number
  tax: number
  note: string | null
  client_request_id: string | null
  created_at: string
  updated_at: string
}

export interface RecordWrite {
  trader: string
  trade_date: string
  trade_time?: string | null
  code: string
  symbol?: string
  name: string
  side: Side
  price: number
  quantity: number
  fee?: number
  tax?: number
  note?: string | null
  client_request_id?: string | null
}

export interface RecordPatch {
  expected_version: number
  trader?: string
  trade_date?: string
  trade_time?: string | null
  code?: string
  symbol?: string
  name?: string
  side?: Side
  price?: number
  quantity?: number
  fee?: number
  tax?: number
  note?: string | null
  client_request_id?: string | null
}

export interface RecordListQuery {
  trader?: string
  date?: string
  from?: string
  to?: string
  code?: string
  side?: Side
  limit?: number
  offset?: number
  sort?: RecordSort
}

export interface RecordList {
  records: TradeRecord[]
  pagination: Pagination
}

export interface TraderSummary {
  trader: string
  record_count: number
}

export interface TraderList {
  traders: TraderSummary[]
}

export interface DailyReview {
  id: string
  version: number
  date: string
  content: string
  tags: string[]
  created_at: string
  updated_at: string
}

export interface ReviewWrite {
  date: string
  content: string
  tags?: string[]
}

export interface ReviewPatch {
  expected_version: number
  date?: string
  content?: string
  tags?: string[]
}

export interface ReviewListQuery {
  date?: string
  from?: string
  to?: string
  tag?: string
  limit?: number
  offset?: number
  sort?: ReviewSort
}

export interface ReviewList {
  reviews: DailyReview[]
  pagination: Pagination
}

export interface Position {
  position_key: string
  trader: string
  code: string
  symbol: string
  name: string
  open_date: string
  quantity: number
  cost: number
  cost_amount: number
  current_price: number | null
  price_source: string | null
  price_as_of: string | null
  price_status: PriceStatus
  market_value: number | null
  unrealized_pnl: number | null
  return_rate: number | null
}

export interface PositionList {
  as_of: string
  positions: Position[]
  pagination: Pagination
}

export interface PositionQuery {
  as_of?: string
  trader?: string
  code?: string
  limit?: number
  offset?: number
  sort?: PositionSort
}

export interface HistoryRow {
  history_id: string
  sell_record_id: string
  buy_record_ids: string[]
  trader: string
  code: string
  symbol: string
  name: string
  open_date: string
  close_date: string
  quantity: number
  cost: number
  exit_price: number
  cost_amount: number
  exit_amount: number
  realized_pnl: number
  return_rate: number | null
  holding_days: number
}

export interface HistoryList {
  history: HistoryRow[]
  pagination: Pagination
}

export interface HistoryQuery {
  from?: string
  to?: string
  trader?: string
  code?: string
  limit?: number
  offset?: number
  sort?: HistorySort
}

export interface ApiSuccess<T> {
  data: T
  meta: { duplicate: boolean }
  status: number
}

export interface TradeJournalApi {
  readonly mode: 'mock' | 'api'
  listRecords(query: RecordListQuery): Promise<ApiSuccess<RecordList>>
  listTraders(): Promise<ApiSuccess<TraderList>>
  createRecord(body: RecordWrite): Promise<ApiSuccess<TradeRecord>>
  patchRecord(id: string, body: RecordPatch): Promise<ApiSuccess<TradeRecord>>
  deleteRecord(id: string, expectedVersion: number | undefined): Promise<void>
  listReviews(query: ReviewListQuery): Promise<ApiSuccess<ReviewList>>
  createReview(body: ReviewWrite): Promise<ApiSuccess<DailyReview>>
  patchReview(id: string, body: ReviewPatch): Promise<ApiSuccess<DailyReview>>
  deleteReview(id: string, expectedVersion: number | undefined): Promise<void>
  currentPositions(query: PositionQuery): Promise<ApiSuccess<PositionList>>
  history(query: HistoryQuery): Promise<ApiSuccess<HistoryList>>
}
