// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { journal } from './client'
import { createMockTradeJournal } from './mockStore'
import { TradeJournalPage } from './page'
import type { TradeJournalApi } from './types'

const state = vi.hoisted(() => ({ client: null as TradeJournalApi | null }))
vi.mock('./client', () => ({ get journal() { return state.client! } }))
vi.mock('@/lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, api: { ...original.api, marketSnapshot: async () => ({ rows: [] }) } }
})

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const storageKey = 'tf-trade-journal-trader'
let dispose: (() => Promise<void>) | undefined
beforeEach(() => {
  state.client = createMockTradeJournal(true)
  window.localStorage.clear()
  window.history.replaceState(null, '', '/trade-journal')
  notifyManager.setNotifyFunction(callback => { act(callback) })
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  notifyManager.setNotifyFunction(callback => callback())
})

async function renderAt(search = '') {
  window.history.replaceState(null, '', `/trade-journal${search}`)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  dispose = async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  }
  await act(async () => root.render(<QueryClientProvider client={client}><TradeJournalPage /></QueryClientProvider>))
  return container
}
function selected(container: HTMLElement) {
  return container.querySelector('[aria-label="交易者"] [aria-selected="true"]')?.textContent?.replace(/\s+\d+$/, '').trim()
}
async function expectSelected(container: HTMLElement, trader: string) {
  await vi.waitFor(() => {
    expect(selected(container)).toBe(trader)
    expect(new URLSearchParams(window.location.search).get('trader')).toBe(trader)
  })
}
async function click(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function clickTrader(container: HTMLElement, trader: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).find(item => item.textContent?.replace(/\s+\d+$/, '').trim() === trader)
  expect(button, trader).toBeDefined()
  await act(async () => button!.click())
}
function listSpies() {
  return [vi.spyOn(journal, 'currentPositions'), vi.spyOn(journal, 'history'), vi.spyOn(journal, 'listRecords'), vi.spyOn(journal, 'listReviews')]
}
function expectNoCalls(spies: ReturnType<typeof listSpies>) {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
}
async function input(container: HTMLElement, label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(field, label).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('缺省选择第一人，保存的选择在无 URL 和重新挂载时恢复', async () => {
  const first = await renderAt()
  await expectSelected(first, '杨鹏')
  expect(first.querySelector('[aria-label="交易者"]')?.textContent).not.toContain('全部')
  await clickTrader(first, 'AI选股:atr_pct')
  expect(window.localStorage.getItem(storageKey)).toBe('AI选股:atr_pct')
  await dispose!()
  dispose = undefined
  const second = await renderAt('?tab=history&foo=1#note')
  await expectSelected(second, 'AI选股:atr_pct')
  expect(second.querySelector('#journal-tab-history')?.getAttribute('aria-selected')).toBe('true')
  expect(new URLSearchParams(window.location.search).get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
})

it('URL、已保存值和首位三者不同时，以 URL 为准', async () => {
  await journal.createReview({ trader: '未指定', date: '2026-10-20', content: '仅有复盘的真实交易者' })
  window.localStorage.setItem(storageKey, 'AI选股:atr_pct')
  const container = await renderAt(`?trader=${encodeURIComponent('未指定')}&tab=reviews`)
  await expectSelected(container, '未指定')
  expect(window.localStorage.getItem(storageKey)).toBe('未指定')
  await vi.waitFor(() => expect(container.textContent).toContain('仅有复盘的真实交易者'))
  const names = Array.from(container.querySelectorAll('[aria-label="交易者"] [role="tab"]')).map(item => item.textContent?.replace(/\s+\d+$/, '').trim())
  expect(names).toEqual(['杨鹏', 'AI选股:atr_pct', '未指定'])
})

it.each(['?trader=', '?trader=%20%20', `?trader=${encodeURIComponent('已删除')}`])('显式非法 URL %s 不使用已保存交易者', async search => {
  window.localStorage.setItem(storageKey, 'AI选股:atr_pct')
  const container = await renderAt(search)
  await expectSelected(container, '杨鹏')
  expect(window.localStorage.getItem(storageKey)).toBe('杨鹏')
})

it('已保存交易者不存在时回退第一人', async () => {
  window.localStorage.setItem(storageKey, '已删除')
  const container = await renderAt()
  await expectSelected(container, '杨鹏')
})

it('名册未返回前没有列表请求，返回后每个子页签只请求当前交易者', async () => {
  const real = journal.listTraders.bind(journal)
  let release!: (value: Awaited<ReturnType<typeof real>>) => void
  vi.spyOn(journal, 'listTraders').mockImplementation(() => new Promise(resolve => { release = resolve }))
  const spies = listSpies()
  const container = await renderAt()
  expectNoCalls(spies)
  expect(container.querySelector('#journal-panel')).toBeNull()
  await act(async () => release(await real()))
  await expectSelected(container, '杨鹏')
  for (const section of ['历史收益', '交易记录', '每日复盘']) {
    await click(container, section)
  }
  await vi.waitFor(() => { for (const spy of spies) expect(spy).toHaveBeenCalled() })
  for (const spy of spies) for (const [query] of spy.mock.calls) expect(query?.trader).toBe('杨鹏')
})

it('名册读取失败时没有列表请求，重试成功恢复工作区', async () => {
  const real = journal.listTraders.bind(journal)
  vi.spyOn(journal, 'listTraders').mockRejectedValueOnce(new Error('名册网络故障')).mockImplementation(real)
  // mockImplementation sets the default; the first once-rejection remains queued.
  const spies = listSpies()
  const container = await renderAt()
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('名册网络故障'))
  expectNoCalls(spies)
  expect(container.querySelector('#journal-panel')).toBeNull()
  await click(container, '重试')
  await expectSelected(container, '杨鹏')
  await vi.waitFor(() => expect(spies[0]).toHaveBeenCalledWith(expect.objectContaining({ trader: '杨鹏' })))
})

it('空名册显示唯一记交易入口，可填新名称并在保存后选中新交易者', async () => {
  state.client = createMockTradeJournal(false)
  const spies = listSpies()
  const container = await renderAt()
  await vi.waitFor(() => expect(container.textContent).toContain('暂无交易员，点击记交易创建'))
  expectNoCalls(spies)
  expect(container.querySelector('#journal-panel')).toBeNull()
  expect(Array.from(container.querySelectorAll('button')).filter(button => button.textContent?.trim() === '记交易')).toHaveLength(1)
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('写复盘'))).toBe(false)
  await click(container, '记交易')
  const trader = container.querySelector<HTMLInputElement>('input[aria-label="交易者"]')!
  expect(trader.readOnly).toBe(false)
  await input(container, '交易者', '新交易员乙')
  await input(container, '股票代码', '000001')
  await input(container, '股票名称', '平安银行')
  await input(container, '成交价', '10')
  await input(container, '数量', '100')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await expectSelected(container, '新交易员乙')
  await vi.waitFor(() => expect(container.querySelector('tbody')?.textContent).toContain('平安银行'))
  expect(container.querySelector('#journal-tab-records')?.getAttribute('aria-selected')).toBe('true')
  for (const spy of spies) for (const [query] of spy.mock.calls) expect(query?.trader).toBe('新交易员乙')
})

it.each(['getItem', 'setItem'] as const)('localStorage.%s 抛错仍能选择交易者并同步 URL', async method => {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('存储不可用') })
  const container = await renderAt()
  await expectSelected(container, '杨鹏')
  await clickTrader(container, 'AI选股:atr_pct')
  await expectSelected(container, 'AI选股:atr_pct')
})

it('切换交易者关闭旧草稿并保留子页签，新表单锁定新交易者', async () => {
  const container = await renderAt('?tab=history')
  await expectSelected(container, '杨鹏')
  await click(container, '记交易')
  await input(container, '股票名称', '未提交旧草稿')
  await clickTrader(container, 'AI选股:atr_pct')
  await expectSelected(container, 'AI选股:atr_pct')
  expect(container.querySelector('[aria-label="新增交易记录"]')).toBeNull()
  expect(container.querySelector('#journal-tab-history')?.getAttribute('aria-selected')).toBe('true')
  await click(container, '记交易')
  const trader = container.querySelector<HTMLInputElement>('input[aria-label="交易者"]')!
  expect(trader.value).toBe('AI选股:atr_pct')
  expect(trader.readOnly).toBe(true)
  expect(container.querySelector<HTMLInputElement>('[aria-label="股票名称"]')?.value).toBe('')
})
