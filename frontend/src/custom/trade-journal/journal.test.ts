import { describe, expect, it } from 'vitest'
import type { UserConfig } from 'vite'
import viteConfig from '../../../vite.config'
import { createHttpTradeJournal } from './httpClient'
import { createMockTradeJournal } from './mockStore'
import type { RecordWrite } from './types'
import { normalizeTradeTime } from './validate'

const buy: RecordWrite = {
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

  it('每日复盘唯一日期且删除要求当前版本', async () => {
    const api = createMockTradeJournal()
    const review = await api.createReview({ date: '2026-10-12', content: '成交缩量', tags: ['缩量'] })
    await expect(api.createReview({ date: '2026-10-12', content: '重复' })).rejects.toMatchObject({ code: 'DUPLICATE_REVIEW' })
    const edited = await api.patchReview(review.data.id, { expected_version: 1, content: '等待放量' })
    expect(edited.data.version).toBe(2)
    await expect(api.deleteReview(review.data.id, 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await api.deleteReview(review.data.id, 2)
    expect((await api.listReviews({})).data.pagination.total).toBe(0)
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
})

it('开发代理仅把交易日记契约路径发往 Node', () => {
  const proxy = (viteConfig as UserConfig).server?.proxy
  expect(proxy).toBeDefined()
  const targetFor = (url: string) => {
    const match = Object.entries(proxy ?? {}).find(([path]) => path.startsWith('^') ? new RegExp(path).test(url) : url.startsWith(path))
    const route = match?.[1]
    return typeof route === 'string' ? route : route?.target
  }
  for (const path of ['/api/records', '/api/records?limit=20', '/api/records/rec_1', '/api/reviews', '/api/reviews/rev_1', '/api/positions/current', '/api/positions/history?limit=20']) {
    expect(targetFor(path), path).toBe('http://127.0.0.1:3022')
  }
  for (const path of ['/api/settings', '/api/positions/other', '/api/records-extra', '/api/reviews-extra']) {
    expect(targetFor(path), path).not.toBe('http://127.0.0.1:3022')
  }
})
