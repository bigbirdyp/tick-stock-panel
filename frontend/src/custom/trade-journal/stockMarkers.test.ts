import { expect, it, vi } from 'vitest'
import { QK } from '@/lib/queryKeys'
import { loadStockMarkerSet, stockMarkerQueryString, stockMarkerSetMatches, tradeRecordsToMarkers } from './stockMarkers'
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

it('查询键用 scope 区分全部和具体交易员，真名「全部」不撞全部键', () => {
  const named = stockMarkerQueryString('000001', '杨鹏')
  const everyone = stockMarkerQueryString('000001', undefined)
  const sameName = stockMarkerQueryString('000001', '全部')
  expect(named).toBe(JSON.stringify({ purpose: 'kline-markers', scope: 'trader', code: '000001', trader: '杨鹏' }))
  expect(everyone).toBe(JSON.stringify({ purpose: 'kline-markers', scope: 'all', code: '000001' }))
  expect(sameName).toBe(JSON.stringify({ purpose: 'kline-markers', scope: 'trader', code: '000001', trader: '全部' }))
  expect(everyone).not.toBe(sameName)
  expect(QK.tradeJournalRecords(named)).toEqual(['trade-journal', 'records', named])
  expect(QK.tradeJournalRecords(everyone)).not.toEqual(QK.tradeJournalRecords(sameName))
})

it('第二页不漏，同日多笔收成一组且逐笔还在', async () => {
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
  expect(loaded.scope).toBe('trader')
  expect(loaded.markers).toHaveLength(2)
  expect(loaded.markers[0]).toMatchObject({ date: '2026-01-02', kind: 'buy', label: '买' })
  expect(loaded.markers[0]?.trades).toHaveLength(200)
  expect(loaded.markers[0]?.trades?.every(trade => trade.side === 'buy' && trade.quantity === 1 && trade.price === 1 && trade.trader === '杨鹏')).toBe(true)
  expect(loaded.markers[1]).toEqual({
    date: '2026-02-03',
    kind: 'sell',
    label: '卖',
    trades: [{ date: '2026-02-03', side: 'sell', price: 2, quantity: 5, trader: '杨鹏' }],
  })
})

it('同日买卖合成一个标记，逐笔不合并数量，其它股票和交易员排除', () => {
  const markers = tradeRecordsToMarkers([
    record({ id: 'late', trader: '杨鹏', code: '000001', side: 'sell', price: 9, quantity: 1, trade_date: '2026-09-29' }),
    record({ id: '1', trader: '杨鹏', code: '000001', side: 'buy', price: 10.5, quantity: 100, trade_date: '2026-09-28' }),
    record({ id: '2', trader: '杨鹏', code: '000001', side: 'buy', price: 11.25, quantity: 250, trade_date: '2026-09-28T10:05:00' }),
    record({ id: '3', trader: '杨鹏', code: '000001', side: 'sell', price: 12, quantity: 50, trade_date: '2026-09-28' }),
    record({ id: '4', trader: '别人', code: '000001', symbol: '000001.SZ', side: 'buy', price: 99, quantity: 1, trade_date: '2026-09-28' }),
    record({ id: '5', trader: '杨鹏', code: '600519', symbol: '600519.SH', side: 'sell', price: 8, quantity: 1, trade_date: '2026-09-29' }),
  ], '000001', '杨鹏')
  expect(markers).toEqual([
    {
      date: '2026-09-28',
      kind: 'neutral',
      label: '买/卖',
      trades: [
        { date: '2026-09-28', side: 'buy', price: 10.5, quantity: 100, trader: '杨鹏' },
        { date: '2026-09-28', side: 'buy', price: 11.25, quantity: 250, trader: '杨鹏' },
        { date: '2026-09-28', side: 'sell', price: 12, quantity: 50, trader: '杨鹏' },
      ],
    },
    {
      date: '2026-09-29',
      kind: 'sell',
      label: '卖',
      trades: [{ date: '2026-09-29', side: 'sell', price: 9, quantity: 1, trader: '杨鹏' }],
    },
  ])
  expect(markers.every(marker => marker.above == null)).toBe(true)
  expect(markers[0]?.trades?.reduce((sum, trade) => sum + trade.quantity, 0)).toBe(400)
})

it('全部保留不同交易员的逐笔，请求不带 trader，其它股票不能混入', async () => {
  const calls: RecordListQuery[] = []
  const listRecords = vi.fn(async (query: RecordListQuery) => {
    calls.push(query)
    return ok([
      record({ id: '1', trader: '杨鹏', code: '000001', side: 'buy', price: 10, quantity: 1, trade_date: '2026-09-28' }),
      record({ id: '2', trader: '全部', code: '000001', side: 'sell', price: 11, quantity: 2, trade_date: '2026-09-28' }),
    ], 0, 2, false)
  })
  const loaded = await loadStockMarkerSet(listRecords, '000001', undefined)
  expect(calls).toEqual([{ code: '000001', limit: 200, offset: 0, sort: 'trade_date_asc' }])
  expect(calls[0]).not.toHaveProperty('trader')
  expect(loaded).toEqual({
    code: '000001',
    scope: 'all',
    markers: [{
      date: '2026-09-28',
      kind: 'neutral',
      label: '买/卖',
      trades: [
        { date: '2026-09-28', side: 'buy', price: 10, quantity: 1, trader: '杨鹏' },
        { date: '2026-09-28', side: 'sell', price: 11, quantity: 2, trader: '全部' },
      ],
    }],
  })
  const wrongStock = vi.fn(async () => ok([
    record({ id: 'x', trader: '杨鹏', code: '600519', symbol: '600519.SH', side: 'buy', price: 1, quantity: 1, trade_date: '2026-01-02' }),
  ], 0, 1, false))
  await expect(loadStockMarkerSet(wrongStock, '000001', undefined)).rejects.toThrow('成交记录与当前股票或交易员不一致')
})

it('真名「全部」只匹配本人，对不上的缓存不能显示', async () => {
  const listRecords = vi.fn(async (query: RecordListQuery) => {
    expect(query.trader).toBe('全部')
    return ok([
      record({ id: '1', trader: '全部', code: '000001', side: 'buy', price: 3, quantity: 4, trade_date: '2026-04-01' }),
    ], 0, 1, false)
  })
  const loaded = await loadStockMarkerSet(listRecords, '000001', '全部')
  expect(loaded).toEqual({
    code: '000001',
    scope: 'trader',
    trader: '全部',
    markers: [{
      date: '2026-04-01',
      kind: 'buy',
      label: '买',
      trades: [{ date: '2026-04-01', side: 'buy', price: 3, quantity: 4, trader: '全部' }],
    }],
  })
  const mixed = vi.fn(async () => ok([
    record({ id: '2', trader: '杨鹏', code: '000001', side: 'buy', price: 9, quantity: 1, trade_date: '2026-04-01' }),
  ], 0, 1, false))
  await expect(loadStockMarkerSet(mixed, '000001', '全部')).rejects.toThrow('成交记录与当前股票或交易员不一致')
  expect(stockMarkerSetMatches(loaded, '000001', undefined)).toBe(false)
  expect(stockMarkerSetMatches(loaded, '000001', '全部')).toBe(true)
  expect(stockMarkerSetMatches({ code: '000001', scope: 'all', markers: [] }, '000001', '全部')).toBe(false)
  expect(stockMarkerSetMatches({ code: '600519', scope: 'all', markers: [] }, '000001', undefined)).toBe(false)
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

it('总数对不上时失败，不把少掉的一页当成读完', async () => {
  const listRecords = vi.fn(async () => ok([
    record({ id: 'only', trader: '杨鹏', code: '000001', side: 'sell', price: 3, quantity: 1, trade_date: '2026-03-01' }),
  ], 0, 2, false))
  await expect(loadStockMarkerSet(listRecords, '000001', '杨鹏')).rejects.toThrow('成交标记没有读全')
})

it('记录不属于当前股票或交易员时失败，空白交易员不读取', async () => {
  const listRecords = vi.fn(async () => ok([
    record({ id: 'x', trader: '别人', code: '000001', side: 'buy', price: 1, quantity: 1, trade_date: '2026-01-02' }),
  ], 0, 1, false))
  await expect(loadStockMarkerSet(listRecords, '000001', '杨鹏')).rejects.toThrow('成交记录与当前股票或交易员不一致')
  expect(listRecords).toHaveBeenCalledTimes(1)
  await expect(loadStockMarkerSet(listRecords, '000001', '')).rejects.toThrow('成交标记需要具体股票和交易员')
  await expect(loadStockMarkerSet(listRecords, '000001', '   ')).rejects.toThrow('成交标记需要具体股票和交易员')
  await expect(loadStockMarkerSet(listRecords, '12', undefined)).rejects.toThrow('成交标记需要具体股票和交易员')
  expect(listRecords).toHaveBeenCalledTimes(1)
})
