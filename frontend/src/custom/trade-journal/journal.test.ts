import { describe, expect, it } from 'vitest'
import type { UserConfig } from 'vite'
import viteConfig from '../../../vite.config'
import { createHttpTradeJournal } from './httpClient'
import { createMockTradeJournal } from './mockStore'
import type { RecordPatch, RecordWrite, ReviewWrite } from './types'
import { normalizeRecordWrite, normalizeTradeTime } from './validate'

const buy: RecordWrite = {
  trader: '杨鹏',
  trade_date: '2026-10-12',
  trade_time: '09:30:00',
  code: '600519',
  name: '贵州茅台',
  side: 'buy',
  price: 10,
  quantity: 100,
  fee: 1,
  tax: 0,
  client_request_id: 'test-buy-1',
}

describe('成交时间', () => {
  it('把浏览器的 HH:mm 补成契约要求的 HH:mm:ss', () => {
    expect(normalizeTradeTime('10:35')).toBe('10:35:00')
    expect(normalizeTradeTime('10:35:12')).toBe('10:35:12')
    expect(normalizeTradeTime('  ')).toBeNull()
    expect(normalizeTradeTime('25:00')).toBe('25:00')
  })
})

describe('交易记录写入归一化', () => {
  it('生成 docs/api.md 要求的 v2 client_request_id 指纹', () => {
    const normalized = normalizeRecordWrite({ ...buy, trader: ' 杨鹏 ', trade_time: undefined, note: undefined })
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    expect(normalized.value.fingerprint).toBe(JSON.stringify([
      '杨鹏',
      '2026-10-12',
      null,
      '600519',
      '600519.SH',
      '贵州茅台',
      'buy',
      10,
      100,
      1,
      0,
      null,
      'test-buy-1',
    ]))
  })
})

describe('契约形状的开发 mock', () => {
  it('按卖出记录聚合 FIFO 收益，并保留部分持仓', async () => {
    const api = createMockTradeJournal()
    const created = await api.createRecord(buy)
    expect(created.status).toBe(201)
    expect(created.data.symbol).toBe('600519.SH')

    const sold = await api.createRecord({
      ...buy,
      trade_time: '10:30:00',
      side: 'sell',
      price: 12,
      quantity: 40,
      fee: 1,
      client_request_id: 'test-sell-1',
    })
    const history = (await api.history({})).data
    expect(history.pagination.total).toBe(1)
    expect(history.history[0]).toMatchObject({
      history_id: sold.data.id,
      sell_record_id: sold.data.id,
      buy_record_ids: [created.data.id],
      quantity: 40,
      cost_amount: 400.4,
      exit_amount: 479,
      realized_pnl: 78.6,
    })
    const positions = (await api.currentPositions({ as_of: '2026-10-12' })).data
    expect(positions.positions[0]).toMatchObject({
      symbol: '600519.SH',
      quantity: 60,
      cost_amount: 600.6,
    })
  })

  it('重复请求不新建，过期版本不能覆盖；超卖不能写入', async () => {
    const api = createMockTradeJournal()
    const first = await api.createRecord(buy)
    const retry = await api.createRecord(buy)
    expect(retry.status).toBe(200)
    expect(retry.meta.duplicate).toBe(true)
    expect(retry.data.id).toBe(first.data.id)
    expect((await api.listRecords({})).data.pagination.total).toBe(1)

    const changed = await api.patchRecord(first.data.id, { expected_version: 1, note: '更正' })
    expect(changed.data.version).toBe(2)
    await expect(api.patchRecord(first.data.id, { expected_version: 1, note: '旧版本' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 })
    await expect(api.createRecord({ ...buy, side: 'sell', quantity: 101, client_request_id: 'oversell' })).rejects.toMatchObject({ code: 'INSUFFICIENT_POSITION', status: 409 })
  })

  it('PATCH 显式传入 trader null 时按契约返回 422，不沿用原交易者', async () => {
    const api = createMockTradeJournal()
    const first = await api.createRecord(buy)

    await expect(api.patchRecord(first.data.id, { expected_version: 1, trader: null } as unknown as RecordPatch)).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: [{ path: 'trader', message: '必须是字符串' }],
    })
    const records = (await api.listRecords({})).data.records
    expect(records).toMatchObject([{ id: first.data.id, version: 1, trader: '杨鹏' }])
  })

  it('PATCH 后重放原始 POST 仍命中创建指纹，并返回当前记录', async () => {
    const api = createMockTradeJournal()
    const first = await api.createRecord(buy)
    const patched = await api.patchRecord(first.data.id, { expected_version: 1, price: 11, trader: '改标签' })
    expect(patched.data).toMatchObject({ version: 2, price: 11, trader: '改标签', client_request_id: buy.client_request_id })

    const replay = await api.createRecord(buy)
    expect(replay.status).toBe(200)
    expect(replay.meta.duplicate).toBe(true)
    expect(replay.data).toMatchObject({ id: first.data.id, version: 2, price: 11, trader: '改标签' })
    expect((await api.listRecords({})).data.pagination.total).toBe(1)
    await expect(api.createRecord({ ...buy, price: 11, trader: '改标签' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_RECORD' })

    const sameKey = await api.patchRecord(first.data.id, {
      expected_version: 2,
      client_request_id: buy.client_request_id,
      note: '仍是原键',
    })
    expect((await api.createRecord(buy)).data).toMatchObject({ id: first.data.id, note: '仍是原键', price: 11 })

    const moved = await api.patchRecord(first.data.id, { expected_version: sameKey.data.version, client_request_id: 'test-buy-2', price: 12 })
    expect(moved.data).toMatchObject({ client_request_id: 'test-buy-2', price: 12, note: '仍是原键', trader: '改标签' })
    expect((await api.createRecord(buy)).data).toMatchObject({ id: first.data.id, price: 12, client_request_id: 'test-buy-2' })
    const newKeyReplay = await api.createRecord({
      ...buy,
      trader: '改标签',
      price: 12,
      note: '仍是原键',
      client_request_id: 'test-buy-2',
    })
    expect(newKeyReplay.status).toBe(200)
    expect(newKeyReplay.meta.duplicate).toBe(true)
    expect(newKeyReplay.data.id).toBe(first.data.id)
    await expect(api.createRecord({ ...buy, trader: '改标签', price: 99, note: '仍是原键', client_request_id: 'test-buy-2' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_RECORD' })
  })

  it('交易者 A、B 和全部各自过滤记录与持仓，同名股票不跨账本', async () => {
    const api = createMockTradeJournal()
    await api.createRecord({ ...buy, trader: 'A', quantity: 100, client_request_id: 'a-buy' })
    await api.createRecord({ ...buy, trader: 'B', quantity: 40, trade_time: '10:00:00', client_request_id: 'b-buy' })

    const allRecords = (await api.listRecords({})).data
    expect(allRecords.pagination.total).toBe(2)
    expect(allRecords.records.map(row => row.trader).sort()).toEqual(['A', 'B'])
    expect((await api.listRecords({ trader: 'A' })).data.records).toMatchObject([{ trader: 'A', quantity: 100 }])
    expect((await api.listRecords({ trader: 'B' })).data.records).toMatchObject([{ trader: 'B', quantity: 40 }])
    expect((await api.listRecords({ trader: '没有的人' })).data.pagination.total).toBe(0)

    const allPositions = (await api.currentPositions({})).data.positions
    expect(allPositions.map(row => row.trader).sort()).toEqual(['A', 'B'])
    expect(allPositions.map(row => row.position_key).sort()).toEqual(['A\u001f600519.SH', 'B\u001f600519.SH'])
    expect(allPositions.find(row => row.trader === 'A')).toMatchObject({ quantity: 100, symbol: '600519.SH' })
    expect(allPositions.find(row => row.trader === 'B')).toMatchObject({ quantity: 40, symbol: '600519.SH' })
    expect((await api.currentPositions({ trader: 'A' })).data.positions).toMatchObject([{ trader: 'A', quantity: 100 }])
    expect((await api.currentPositions({ trader: 'B' })).data.positions).toMatchObject([{ trader: 'B', quantity: 40 }])
    expect((await api.currentPositions({ trader: '没有的人' })).data.positions).toEqual([])

    await expect(api.createRecord({
      ...buy,
      trader: 'B',
      side: 'sell',
      quantity: 50,
      trade_time: '11:00:00',
      client_request_id: 'b-oversell',
    })).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_POSITION' })
    expect((await api.currentPositions({ trader: 'A' })).data.positions[0]?.quantity).toBe(100)
  })

  it('历史收益按交易者过滤，不跨交易者合并卖出收益', async () => {
    const api = createMockTradeJournal()
    await api.createRecord({ ...buy, trader: 'A', quantity: 100, client_request_id: 'history-a-buy' })
    await api.createRecord({ ...buy, trader: 'B', quantity: 100, trade_time: '09:31:00', client_request_id: 'history-b-buy' })
    await api.createRecord({ ...buy, trader: 'A', side: 'sell', quantity: 40, price: 12, trade_time: '10:00:00', client_request_id: 'history-a-sell' })

    expect((await api.history({})).data.history.map(row => row.trader)).toEqual(['A'])
    expect((await api.history({ trader: 'A' })).data.history).toMatchObject([{ trader: 'A', quantity: 40 }])
    expect((await api.history({ trader: 'B' })).data.history).toEqual([])
  })

  it('同一交易者同一日期不能重复复盘，删除要求当前版本', async () => {
    const api = createMockTradeJournal()
    const review = await api.createReview({ trader: '杨鹏', date: '2026-10-12', content: '成交缩量', tags: ['缩量'] })
    await expect(api.createReview({ trader: '杨鹏', date: '2026-10-12', content: '重复' })).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_REVIEW' })
    const edited = await api.patchReview(review.data.id, { expected_version: 1, content: '等待放量' })
    expect(edited.data.version).toBe(2)
    await expect(api.deleteReview(review.data.id, 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await api.deleteReview(review.data.id, 2)
    expect((await api.listReviews({})).data.pagination.total).toBe(0)
  })

  it('复盘写入必须带交易者；同日不同交易者可并存，并按交易者过滤和计数', async () => {
    const api = createMockTradeJournal()
    await expect(api.createReview({ date: '2026-10-12', content: '缺交易者' } as ReviewWrite)).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: [{ path: 'trader', message: '必填' }],
    })
    await expect(api.createReview({ trader: '   ', date: '2026-10-12', content: '空白交易者' })).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: [{ path: 'trader', message: '不能为空' }],
    })

    const alpha = await api.createReview({ trader: 'A', date: '2026-10-12', content: 'A 的复盘' })
    const beta = await api.createReview({ trader: 'B', date: '2026-10-12', content: 'B 的复盘' })
    expect(alpha.status).toBe(201)
    expect(beta.status).toBe(201)
    expect((await api.listReviews({})).data.pagination.total).toBe(2)
    expect((await api.listReviews({ trader: 'A' })).data.reviews).toMatchObject([{ id: alpha.data.id, trader: 'A' }])
    expect((await api.listReviews({ trader: 'B' })).data.reviews).toMatchObject([{ id: beta.data.id, trader: 'B' }])
    expect((await api.listReviews({ trader: '没有的人' })).data.pagination.total).toBe(0)

    await api.createRecord({ ...buy, trader: 'A', client_request_id: 'review-count-a' })
    await api.createReview({ trader: '只复盘', date: '2026-10-13', content: '没有成交记录' })
    expect((await api.listTraders()).data.traders).toEqual([
      { trader: 'A', record_count: 1, review_count: 1 },
      { trader: 'B', record_count: 0, review_count: 1 },
      { trader: '只复盘', record_count: 0, review_count: 1 },
    ])
  })

  it('拒绝 900901，且 as_of 早于行情日时不使用该行情', async () => {
    const api = createMockTradeJournal()
    await expect(api.createRecord({ ...buy, code: '900901', name: 'B股', client_request_id: 'bshare-900901' })).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_STOCK_CODE',
    })
    await api.createRecord({ ...buy, trade_date: '2026-10-01', client_request_id: 'early-maotai' })
    const historical = (await api.currentPositions({ as_of: '2026-10-01' })).data
    expect(historical.positions).toHaveLength(1)
    expect(historical.positions[0]).toMatchObject({
      symbol: '600519.SH',
      quantity: 100,
      current_price: null,
      price_source: null,
      price_as_of: null,
      price_status: 'unavailable',
      market_value: null,
      unrealized_pnl: null,
      return_rate: null,
    })
    const sameDay = (await api.currentPositions({ as_of: '2026-10-12' })).data
    expect(sameDay.positions[0]).toMatchObject({
      current_price: 1712.3,
      price_as_of: '2026-10-12T15:00:00+08:00',
      price_status: 'fresh',
    })
  })

  it('as_of 晚于唯一行情日时仍返回该价，并标为 stale', async () => {
    const api = createMockTradeJournal()
    await api.createRecord(buy)
    const later = (await api.currentPositions({ as_of: '2026-10-13' })).data
    expect(later.as_of).toBe('2026-10-13')
    expect(later.positions).toHaveLength(1)
    expect(later.positions[0]).toMatchObject({
      symbol: '600519.SH',
      current_price: 1712.3,
      price_source: 'local_daily',
      price_as_of: '2026-10-12T15:00:00+08:00',
      price_status: 'stale',
    })
    expect(later.positions[0].market_value).not.toBeNull()
  })
})

describe('同源 HTTP 客户端', () => {
  it('读取顶层 meta.duplicate，缺失 meta 时按 false 处理', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`)
      return new Response(JSON.stringify({ data: { ...buy, id: 'rec_1', version: 1 }, meta: { duplicate: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const api = createHttpTradeJournal(fetchImpl)
    const result = await api.createRecord(buy)
    expect(result.meta.duplicate).toBe(true)
    expect(calls).toEqual(['POST /api/records'])

    const listApi = createHttpTradeJournal(async () => new Response(JSON.stringify({ data: { records: [], pagination: { limit: 50, offset: 0, total: 0, has_more: false } } }), { status: 200 }))
    expect((await listApi.listRecords({})).meta.duplicate).toBe(false)
  })

  it('保留错误码和字段错误，并在 DELETE 传递 expected_version', async () => {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      paths.push(String(input))
      if (paths.length === 1) return new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '版本已变化', details: { fields: [{ path: 'expected_version', message: '过期' }] } } }), { status: 409 })
      return new Response(null, { status: 204 })
    }
    const api = createHttpTradeJournal(fetchImpl)
    await expect(api.patchRecord('rec_1', { expected_version: 1, note: 'test' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, fields: [{ path: 'expected_version', message: '过期' }] })
    await api.deleteRecord('rec_1', 2)
    expect(paths[1]).toBe('/api/records/rec_1?expected_version=2')
  })

  it('记录、持仓和复盘查询带上 trader，交易者列表走 /api/traders', async () => {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      paths.push(String(input))
      return new Response(JSON.stringify({
        data: {
          records: [],
          reviews: [],
          traders: [],
          positions: [],
          history: [],
          as_of: '2026-10-13',
          pagination: { limit: 50, offset: 0, total: 0, has_more: false },
        },
      }), { status: 200 })
    }
    const api = createHttpTradeJournal(fetchImpl)
    await api.listRecords({ trader: 'A' })
    await api.currentPositions({ trader: 'B' })
    await api.history({ trader: 'C' })
    await api.listReviews({ trader: 'D' })
    await api.listTraders()
    expect(paths).toEqual([
      '/api/records?trader=A',
      '/api/positions/current?trader=B',
      '/api/positions/history?trader=C',
      '/api/reviews?trader=D',
      '/api/traders',
    ])
  })
})

it('开发代理仅把交易日记契约路径发往 Node', () => {
  const proxy = (viteConfig as UserConfig).server?.proxy
  expect(proxy).toBeDefined()
  const targetFor = (url: string) => {
    const match = Object.entries(proxy ?? {}).find(([path]) => path.startsWith('^') ? new RegExp(path).test(url) : url.startsWith(path))
    const route = match?.[1]
    return typeof route === 'string' ? route : route?.target
  }
  for (const path of ['/api/records', '/api/records?limit=20', '/api/records/rec_1', '/api/traders', '/api/traders?x=1', '/api/reviews', '/api/reviews/rev_1', '/api/positions/current', '/api/positions/history?limit=20']) {
    expect(targetFor(path), path).toBe('http://127.0.0.1:3022')
  }
  for (const path of ['/api/settings', '/api/positions/other', '/api/records-extra', '/api/reviews-extra', '/api/traders/extra']) {
    expect(targetFor(path), path).not.toBe('http://127.0.0.1:3022')
  }
})
