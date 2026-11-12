// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TradeJournalPage } from './page'

type Calls = { positions: unknown[]; history: unknown[]; records: unknown[]; reviews: unknown[] }

vi.mock('./client', async () => {
  const { createMockTradeJournal } = await import('./mockStore')
  const journal = createMockTradeJournal(true)
  const calls: Calls = { positions: [], history: [], records: [], reviews: [] }
  ;(globalThis as typeof globalThis & { __tradeJournalUrlCalls?: Calls }).__tradeJournalUrlCalls = calls
  const wrap = <T extends (query: never) => unknown>(bucket: unknown[], fn: T): T => ((query: never) => {
    bucket.push(query)
    return fn(query)
  }) as T
  journal.currentPositions = wrap(calls.positions, journal.currentPositions.bind(journal))
  journal.history = wrap(calls.history, journal.history.bind(journal))
  journal.listRecords = wrap(calls.records, journal.listRecords.bind(journal))
  journal.listReviews = wrap(calls.reviews, journal.listReviews.bind(journal))
  return { journal }
})

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean; __tradeJournalUrlCalls?: Calls }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
notifyManager.setNotifyFunction(callback => { act(callback) })

function calls(): Calls {
  const value = actEnvironment.__tradeJournalUrlCalls
  if (!value) throw new Error('missing call capture')
  return value
}

let dispose: (() => Promise<void>) | undefined
beforeEach(() => { window.localStorage.clear() })
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.localStorage.clear()
  window.history.pushState(null, '', '/')
  for (const bucket of Object.values(calls())) bucket.length = 0
})

async function renderAt(search: string) {
  window.history.pushState(null, '', `/trade-journal${search}`)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  dispose = async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  }
  await act(async () => {
    root.render(<QueryClientProvider client={client}><TradeJournalPage /></QueryClientProvider>)
  })
  await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
  return container
}

function selectedTab(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"] [aria-selected="true"]`)
}

it('缺省和非法地址打开首位真实交易者持仓', async () => {
  const blank = await renderAt('')
  expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
  expect(selectedTab(blank, '交易日记栏目')?.textContent).toContain('当前持仓')
  expect(selectedTab(blank, '交易者')?.textContent).toContain('杨鹏')
  expect(calls().positions.at(-1)).toMatchObject({ limit: 20, offset: 0, sort: 'symbol_asc' })
  expect(calls().positions.at(-1)).toHaveProperty('trader', '杨鹏')
  await dispose?.()
  dispose = undefined

  const invalid = await renderAt('?tab=nope&trader=%20%20')
  expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
  expect(selectedTab(invalid, '交易日记栏目')?.textContent).toContain('当前持仓')
  expect(selectedTab(invalid, '交易者')?.textContent).toContain('杨鹏')
  expect(calls().positions.at(-1)).toHaveProperty('trader', '杨鹏')
})

it('用地址栏初始化栏目、交易者和三条查询，复盘查询带上交易者', async () => {
  const container = await renderAt(`?tab=reviews&trader=${encodeURIComponent(' 杨鹏 ')}`)
  expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
  expect(selectedTab(container, '交易日记栏目')?.id).toBe('journal-tab-reviews')
  await vi.waitFor(() => expect(selectedTab(container, '交易者')?.textContent).toContain('杨鹏'))
  expect(calls().reviews.at(-1)).toMatchObject({ trader: '杨鹏', offset: 0 })
  expect(calls().positions).toEqual([])
  expect(calls().records).toEqual([])

  const recordsTab = container.querySelector<HTMLButtonElement>('#journal-tab-records')
  await act(async () => recordsTab?.click())
  const recordsParams = new URLSearchParams(window.location.search)
  expect(recordsParams.get('tab')).toBe('records')
  expect(recordsParams.get('trader')).toBe('杨鹏')
  expect(selectedTab(container, '交易日记栏目')?.id).toBe('journal-tab-records')
  expect(calls().records.at(-1)).toMatchObject({ trader: '杨鹏', offset: 0 })

  const historyTab = container.querySelector<HTMLButtonElement>('#journal-tab-history')
  await act(async () => historyTab?.click())
  const historyParams = new URLSearchParams(window.location.search)
  expect(historyParams.get('tab')).toBe('history')
  expect(historyParams.get('trader')).toBe('杨鹏')
  expect(calls().history.at(-1)).toMatchObject({ trader: '杨鹏', offset: 0 })
})

it('刷新后仍按地址栏恢复栏目和交易者', async () => {
  const search = `?tab=reviews&trader=${encodeURIComponent('杨鹏')}&foo=1#note`
  const first = await renderAt(search)
  await vi.waitFor(() => expect(selectedTab(first, '交易者')?.textContent).toContain('杨鹏'))
  expect(selectedTab(first, '交易日记栏目')?.id).toBe('journal-tab-reviews')
  expect(calls().reviews.at(-1)).toMatchObject({ trader: '杨鹏', offset: 0 })

  await dispose?.()
  dispose = undefined
  for (const bucket of Object.values(calls())) bucket.length = 0

  const second = await renderAt(search)
  expect(window.location.pathname).toBe('/trade-journal')
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('reviews')
  expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
  expect(new URLSearchParams(window.location.search).get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(selectedTab(second, '交易日记栏目')?.id).toBe('journal-tab-reviews')
  await vi.waitFor(() => expect(selectedTab(second, '交易者')?.textContent).toContain('杨鹏'))
  expect(calls().reviews.at(-1)).toMatchObject({ trader: '杨鹏', offset: 0 })
  expect(calls().positions).toEqual([])
})

it('名册里没有的交易者回退首位真实交易者，栏目和其它参数保留', async () => {
  const before = window.history.length
  const container = await renderAt(`?tab=reviews&trader=${encodeURIComponent('已离开')}&foo=1#note`)
  expect(selectedTab(container, '交易日记栏目')?.id).toBe('journal-tab-reviews')
  await vi.waitFor(() => {
    expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
    expect(calls().reviews.at(-1)).toHaveProperty('trader', '杨鹏')
    expect(selectedTab(container, '交易者')?.textContent).toContain('杨鹏')
  })
  const cleaned = new URLSearchParams(window.location.search)
  expect(cleaned.get('tab')).toBe('reviews')
  expect(cleaned.get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(window.location.pathname).toBe('/trade-journal')
  expect(window.history.length).toBe(before + 1)
  expect(selectedTab(container, '交易日记栏目')?.id).toBe('journal-tab-reviews')
  expect(calls().positions).toEqual([])
})
