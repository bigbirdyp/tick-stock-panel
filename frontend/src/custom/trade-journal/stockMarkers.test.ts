import { expect, it, vi } from 'vitest'
import { QK } from '@/lib/queryKeys'
import { loadStockMarkerSet, stockMarkerQueryString, tradeRecordsToMarkers } from './stockMarkers'
import type { ApiSuccess, RecordList, RecordListQuery, TradeRecord } from './types'

function record(over: Partial<TradeRecord> & Pick<TradeRecord, 'id' | 'trader' | 'code' | 'side' | 'price' | 'quantity' | 'trade_date'>): TradeRecord {
  return {
    version: 1,
    trade_time: null,
    symbol: `${over.code}.SZ`,
    name: '测试',
    fee: 0,
    tax: 0,
    note: null,
    client_request_id: null,
    created_at: '2026-01-01T00:00:00+08:00',
    updated_at: '2026-01-01T00:00:00+08:00',
    ...over,
  }
}

function ok(records: TradeRecord[], offset: number, total: number, hasMore: boolean): ApiSuccess<RecordList> {
  return {
    data: { records, pagination: { limit: 200, offset, total, has_more: hasMore } },
    meta: { duplicate: false },
    status: 200,
  }
}

it('查询键带上股票、交易员和成交标记用途', () => {
  const query = stockMarkerQueryString('000001', '杨鹏')
  expect(query).toBe(JSON.stringify({ purpose: 'kline-markers', code: '000001', trader: '杨鹏' }))
  expect(QK.tradeJournalRecords(query)).toEqual(['trade-journal', 'records', query])
})

it('第二页不漏，并且每页都带 trader 与 code', async () => {
  const calls: RecordListQuery[] = []
  const first = Array.from({ length: 200 }, (_, index) => record({
    id: `a${index}`,
    trader: '杨鹏',
    code: '000001',
    side: 'buy',
    price: 1,
    quantity: 1,
    trade_date: '2026-01-02',
  }))
  const second = record({
    id: 'tail',
    trader: '杨鹏',
    code: '000001',
    side: 'sell',
    price: 2,
    quantity: 5,
    trade_date: '2026-02-03',
  })
  const listRecords = vi.fn(async (query: RecordListQuery) => {
    calls.push(query)
    return query.offset === 0 ? ok(first, 0, 201, true) : ok([second], 200, 201, false)
  })
  const loaded = await loadStockMarkerSet(listRecords, '000001', '杨鹏')
  expect(calls).toEqual([
    { trader: '杨鹏', code: '000001', limit: 200, offset: 0, sort: 'trade_date_asc' },
    { trader: '杨鹏', code: '000001', limit: 200, offset: 200, sort: 'trade_date_asc' },
  ])
  expect(loaded.markers).toEqual([
    { date: '2026-01-02', kind: 'buy', label: '买 1.00 ×200' },
    { date: '2026-02-03', kind: 'sell', label: '卖 2.00 ×5' },
  ])
})

it('同日同向合并价格区间和数量，日期只用 trade_date', () => {
  const markers = tradeRecordsToMarkers([
    record({ id: '1', trader: '杨鹏', code: '000001', side: 'buy', price: 10.5, quantity: 100, trade_date: '2026-09-28' }),
    record({ id: '2', trader: '杨鹏', code: '000001', side: 'buy', price: 11.25, quantity: 250, trade_date: '2026-09-28T10:05:00' }),
    record({ id: '3', trader: '杨鹏', code: '000001', side: 'sell', price: 12, quantity: 50, trade_date: '2026-09-28' }),
    record({ id: '4', trader: '别人', code: '000001', symbol: '000001.SZ', side: 'buy', price: 99, quantity: 1, trade_date: '2026-09-28' }),
    record({ id: '5', trader: '杨鹏', code: '600519', symbol: '600519.SH', side: 'sell', price: 8, quantity: 1, trade_date: '2026-09-29' }),
  ], '000001', '杨鹏')
  expect(markers).toEqual([
    { date: '2026-09-28', kind: 'buy', label: '买 10.50~11.25 ×350' },
    { date: '2026-09-28', kind: 'sell', label: '卖 12.00 ×50' },
  ])
  expect(markers.every(marker => marker.above == null)).toBe(true)
})

it('下一页没继续时失败，不把半截当成全部成交', async () => {
  const listRecords = vi.fn(async (query: RecordListQuery) => {
    const offset = query.offset ?? 0
    if (offset === 0) {
      return ok([record({ id: 'only', trader: '杨鹏', code: '000001', side: 'buy', price: 3, quantity: 1, trade_date: '2026-03-01' })], offset, 2, true)
    }
    return ok([], offset, 2, true)
  })
  await expect(loadStockMarkerSet(listRecords, '000001', '杨鹏')).rejects.toThrow('成交标记分页没有继续')
})

it('记录不属于当前股票或交易员时失败，未指定交易员不读取', async () => {
  const listRecords = vi.fn(async () => ok([
    record({ id: 'x', trader: '别人', code: '000001', side: 'buy', price: 1, quantity: 1, trade_date: '2026-01-02' }),
  ], 0, 1, false))
  await expect(loadStockMarkerSet(listRecords, '000001', '杨鹏')).rejects.toThrow('成交记录与当前股票或交易员不一致')
  expect(listRecords).toHaveBeenCalledTimes(1)
  await expect(loadStockMarkerSet(listRecords, '000001', '')).rejects.toThrow('成交标记需要具体股票和交易员')
  await expect(loadStockMarkerSet(listRecords, '000001', '   ')).rejects.toThrow('成交标记需要具体股票和交易员')
  expect(listRecords).toHaveBeenCalledTimes(1)
})
