// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeJournalPage } from './page'

vi.mock('./client', async () => {
  const { createMockTradeJournal } = await import('./mockStore')
  return { journal: createMockTradeJournal(true) }
})

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
notifyManager.setNotifyFunction(callback => { act(callback) })

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.history.pushState(null, '', '/')
})

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

async function renderAt(url: string): Promise<HTMLElement> {
  window.history.pushState(null, '', url)
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
  return container
}

function traderButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelector('[aria-label="交易者"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
}

function traderName(button: HTMLButtonElement): string {
  return (button.textContent ?? '').replace(/\s+\d+$/, '').trim()
}

async function clickTrader(container: HTMLElement, label: string) {
  const button = traderButtons(container).find(item => traderName(item) === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

async function clickColumn(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

function setControl(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

it('点选交易者和栏目时写回地址栏，重复选择不新增历史', async () => {
  const padded = encodeURIComponent(' 杨鹏 ')
  const container = await renderAt(`/trade-journal?foo=1&tab=reviews&trader=${padded}#note`)
  const listen = vi.spyOn(window, 'addEventListener')
  expect(window.location.pathname).toBe('/trade-journal')
  expect(window.location.search).toBe(`?foo=1&tab=reviews&trader=${padded}`)
  expect(window.location.hash).toBe('#note')
  expect(listen.mock.calls.some(call => call[0] === 'popstate')).toBe(false)
  listen.mockRestore()

  await vi.waitFor(() => expect(traderButtons(container).map(traderName)).toContain('杨鹏'))
  const pushes: string[] = []
  const nativePush = History.prototype.pushState
  const push = vi.spyOn(window.history, 'pushState').mockImplementation(function (this: History, data, unused, url) {
    pushes.push(String(url))
    nativePush.call(this, data, unused, url)
  })

  await clickColumn(container, '交易记录')
  expect(params().get('foo')).toBe('1')
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe(' 杨鹏 ')
  expect(window.location.hash).toBe('#note')
  expect(window.location.pathname).toBe('/trade-journal')
  expect(pushes).toHaveLength(1)

  await clickColumn(container, '交易记录')
  expect(pushes).toHaveLength(1)

  await clickTrader(container, '全部')
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBeNull()
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(container.querySelector('[aria-label="交易日记栏目"] [aria-selected="true"]')?.id).toBe('journal-tab-records')
  expect(pushes).toHaveLength(2)

  await clickTrader(container, '全部')
  expect(pushes).toHaveLength(2)

  await clickTrader(container, '杨鹏')
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(pushes).toHaveLength(3)

  await clickTrader(container, '杨鹏')
  expect(pushes).toHaveLength(3)

  await clickColumn(container, '历史收益')
  expect(params().get('tab')).toBe('history')
  expect(params().get('trader')).toBe('杨鹏')
  expect(pushes).toHaveLength(4)

  await clickColumn(container, '历史收益')
  expect(pushes).toHaveLength(4)
  push.mockRestore()
})

it('没有栏目参数时选择全部删掉 trader 并写上当前栏目，保存后写入新栏目', async () => {
  const container = await renderAt('/trade-journal?trader=%E6%9D%A8%E9%B9%8F&foo=1#note')
  expect(window.location.search).toBe('?trader=%E6%9D%A8%E9%B9%8F&foo=1')
  await vi.waitFor(() => expect(traderButtons(container).some(button => traderName(button) === '杨鹏' && button.getAttribute('aria-selected') === 'true')).toBe(true))

  const pushes: string[] = []
  const nativePush = History.prototype.pushState
  vi.spyOn(window.history, 'pushState').mockImplementation(function (this: History, data, unused, url) {
    pushes.push(String(url))
    nativePush.call(this, data, unused, url)
  })

  await clickTrader(container, '全部')
  expect(params().get('trader')).toBeNull()
  expect(params().get('tab')).toBe('positions')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(container.querySelector('#journal-tab-positions')?.getAttribute('aria-selected')).toBe('true')

  await clickColumn(container, '历史收益')
  expect(params().get('tab')).toBe('history')
  expect(params().get('trader')).toBeNull()
  expect(params().get('foo')).toBe('1')

  await clickTrader(container, '杨鹏')
  expect(params().get('tab')).toBe('history')
  expect(params().get('trader')).toBe('杨鹏')

  const beforeSave = pushes.length
  const newTrade = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('记交易'))
  await act(async () => newTrade!.click())
  await act(async () => {
    setControl(container.querySelector<HTMLInputElement>('[aria-label="股票代码"]')!, '600519')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="股票名称"]')!, '贵州茅台')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="成交价"]')!, '10')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="数量"]')!, '100')
  })
  const saveRecord = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存记录')
  await act(async () => saveRecord!.click())
  await vi.waitFor(() => expect(container.querySelector('#journal-tab-records')?.getAttribute('aria-selected')).toBe('true'))
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(pushes.length).toBe(beforeSave + 1)

  const secondTrade = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('记交易'))
  await act(async () => secondTrade!.click())
  await act(async () => {
    setControl(container.querySelector<HTMLInputElement>('[aria-label="股票代码"]')!, '000001')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="股票名称"]')!, '平安银行')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="成交价"]')!, '11')
    setControl(container.querySelector<HTMLInputElement>('[aria-label="数量"]')!, '200')
  })
  const saveAgain = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存记录')
  await act(async () => saveAgain!.click())
  await vi.waitFor(() => expect(container.querySelector('[aria-label="新增交易记录"]')).toBeNull())
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe('杨鹏')
  expect(pushes.length).toBe(beforeSave + 1)

  const writeReview = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('写复盘'))
  await act(async () => writeReview!.click())
  await act(async () => {
    setControl(container.querySelector<HTMLInputElement>('[aria-label="复盘交易者"]')!, '杨鹏')
    setControl(container.querySelector<HTMLTextAreaElement>('[aria-label="复盘内容"]')!, '收盘复盘')
  })
  const saveReview = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存复盘')
  await act(async () => saveReview!.click())
  await vi.waitFor(() => expect(container.querySelector('#journal-tab-reviews')?.getAttribute('aria-selected')).toBe('true'))
  expect(params().get('tab')).toBe('reviews')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(pushes.length).toBe(beforeSave + 2)
  vi.mocked(window.history.pushState).mockRestore()
})

async function stepHistory(direction: 'back' | 'forward') {
  await act(async () => {
    if (direction === 'back') window.history.back()
    else window.history.forward()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

it('刷新后按地址栏恢复点选过的交易者和栏目', async () => {
  const first = await renderAt('/trade-journal?foo=1#note')
  await vi.waitFor(() => expect(traderButtons(first).map(traderName)).toContain('杨鹏'))
  await clickTrader(first, '杨鹏')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('tab')).toBe('positions')
  await clickColumn(first, '每日复盘')
  expect(params().get('tab')).toBe('reviews')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')

  const kept = `${window.location.pathname}${window.location.search}${window.location.hash}`
  await dispose?.()
  dispose = undefined
  const second = await renderAt(kept)
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('tab')).toBe('reviews')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  await vi.waitFor(() => expect(traderButtons(second).some(button => traderName(button) === '杨鹏' && button.getAttribute('aria-selected') === 'true')).toBe(true))
  expect(second.querySelector('#journal-tab-reviews')?.getAttribute('aria-selected')).toBe('true')
})

it('后退和前进按地址栏恢复交易者与栏目', async () => {
  const container = await renderAt('/trade-journal?tab=reviews&trader=%E6%9D%A8%E9%B9%8F&foo=1#note')
  await vi.waitFor(() => expect(traderButtons(container).some(button => traderName(button) === '杨鹏' && button.getAttribute('aria-selected') === 'true')).toBe(true))
  expect(container.querySelector('#journal-tab-reviews')?.getAttribute('aria-selected')).toBe('true')

  await clickColumn(container, '交易记录')
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')

  await stepHistory('back')
  expect(params().get('tab')).toBe('reviews')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(container.querySelector('#journal-tab-reviews')?.getAttribute('aria-selected')).toBe('true')
  expect(traderButtons(container).some(button => traderName(button) === '杨鹏' && button.getAttribute('aria-selected') === 'true')).toBe(true)

  await stepHistory('forward')
  expect(params().get('tab')).toBe('records')
  expect(params().get('trader')).toBe('杨鹏')
  expect(params().get('foo')).toBe('1')
  expect(window.location.hash).toBe('#note')
  expect(container.querySelector('#journal-tab-records')?.getAttribute('aria-selected')).toBe('true')
  expect(traderButtons(container).some(button => traderName(button) === '杨鹏' && button.getAttribute('aria-selected') === 'true')).toBe(true)
})
