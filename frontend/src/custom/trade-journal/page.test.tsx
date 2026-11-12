// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { journal } from './client'
import { TradeJournalPage } from './page'

vi.mock('./client', async () => {
  const { createMockTradeJournal } = await import('./mockStore')
  return { journal: createMockTradeJournal(true) }
})

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
notifyManager.setNotifyFunction(callback => { act(callback) })

let dispose: (() => Promise<void>) | undefined
beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  notifyManager.setNotifyFunction(callback => callback())
})

it('渲染持仓和按卖出记录聚合的历史收益，并可切换栏目', async () => {
  window.localStorage.setItem('tf-trade-journal-trader', 'AI选股:atr_pct')
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
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))
  expect(container.textContent).toContain('100')

  const historyTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(button => button.textContent === '历史收益')
  expect(historyTab).toBeDefined()
  const currentTab = container.querySelector<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"][aria-selected="true"]')
  expect(currentTab?.textContent).toBe('当前持仓')
  await act(async () => currentTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(historyTab?.getAttribute('aria-selected')).toBe('true')
  const yang = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).find(button => button.textContent?.includes('杨鹏'))
  await act(async () => yang!.click())
  expect(container.querySelector('[aria-label="交易者"] [role="tab"][aria-selected="true"]')?.textContent).toContain('杨鹏')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  expect(container.textContent).toContain('平安银行')
  expect(container.textContent).toContain('450.00')

  const reviewTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === '每日复盘')
  await act(async () => reviewTab!.click())
  await vi.waitFor(() => expect(container.textContent).toContain('指数缩量震荡'))
  expect(container.textContent).toContain('指数缩量震荡')
})

it('截止日期晚于行情日时，持仓表标出过期并仍显示旧价', async () => {
  window.localStorage.setItem('tf-trade-journal-trader', 'AI选股:atr_pct')
  notifyManager.setNotifyFunction(callback => { act(callback) })
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
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))

  const dateInput = container.querySelector<HTMLInputElement>('[aria-label="持仓截止日期"]')
  expect(dateInput).not.toBeNull()
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    nativeSetter.call(dateInput, '2026-10-13')
    dateInput!.dispatchEvent(new Event('input', { bubbles: true }))
    dateInput!.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const maotaiRow = () => Array.from(container.querySelectorAll('tr')).find(row => row.textContent?.includes('贵州茅台'))
  await vi.waitFor(() => expect(maotaiRow()?.textContent).toContain('过期'))
  expect(maotaiRow()?.textContent).toContain('1,712.3000')
  expect(maotaiRow()?.textContent).not.toContain('不可用')
})

it('真实交易者页签过滤记录和持仓，新建表单沿用当前标签', async () => {
  notifyManager.setNotifyFunction(callback => { act(callback) })
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

  const traderList = () => container.querySelector('[aria-label="交易者"]')
  const traderButtons = () => Array.from(traderList()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  const traderName = (button: HTMLButtonElement) => (button.textContent ?? '').replace(/\s+\d+$/, '').trim()
  const clickTrader = async (label: string) => {
    const button = traderButtons().find(item => traderName(item) === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const clickColumn = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const bodyText = () => Array.from(container.querySelectorAll('tbody tr')).map(row => row.textContent ?? '').join('\n')

  await vi.waitFor(() => expect(traderButtons().map(traderName)).toEqual(['杨鹏', 'AI选股:atr_pct']))
  expect(traderButtons().map(button => (button.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual(['杨鹏 3', 'AI选股:atr_pct 1'])
  expect(traderButtons()[0]?.getAttribute('aria-selected')).toBe('true')
  await vi.waitFor(() => expect(container.textContent).toContain('暂无记录'))
  await clickTrader('AI选股:atr_pct')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')

  await clickTrader('杨鹏')
  await vi.waitFor(() => expect(container.textContent).toContain('暂无记录'))
  expect(bodyText()).not.toContain('贵州茅台')
  expect(traderButtons().find(button => traderName(button) === '杨鹏')?.getAttribute('aria-selected')).toBe('true')

  const newTrade = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('记交易'))
  await act(async () => newTrade!.click())
  const traderField = () => container.querySelector<HTMLInputElement>('input[aria-label="交易者"]')
  await vi.waitFor(() => expect(traderField()?.value).toBe('杨鹏'))
  expect(traderField()?.value).not.toBe('未指定')
  expect(traderField()?.readOnly).toBe(true)
  const cancel = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '取消')
  await act(async () => cancel!.click())

  await clickColumn('交易记录')
  await vi.waitFor(() => expect(bodyText()).toContain('平安银行'))
  expect(bodyText()).not.toContain('贵州茅台')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3)

  await clickTrader('AI选股:atr_pct')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')

  await clickTrader('AI选股:atr_pct')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)

  await clickColumn('当前持仓')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)

  await clickColumn('每日复盘')
  await vi.waitFor(() => expect(container.textContent).toContain('暂无记录'))
  expect(container.querySelector('[aria-label="交易日记栏目"] [aria-selected="true"]')?.textContent).toBe('每日复盘')
  expect(traderList()).not.toBeNull()
  expect(traderButtons().find(button => traderName(button) === 'AI选股:atr_pct')?.getAttribute('aria-selected')).toBe('true')
  expect(container.textContent).not.toContain('指数缩量震荡')
})

it('切换交易者时保持当前栏目，选中交易者过滤复盘查询，每次查询都带真实 trader', async () => {
  notifyManager.setNotifyFunction(callback => { act(callback) })
  const listReviews = vi.spyOn(journal, 'listReviews')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  dispose = async () => {
    listReviews.mockRestore()
    await act(async () => root.unmount())
    client.clear()
    container.remove()
  }

  const traderButtons = () => Array.from(container.querySelector('[aria-label="交易者"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  const traderName = (button: HTMLButtonElement) => (button.textContent ?? '').replace(/\s+\d+$/, '').trim()
  const clickTrader = async (label: string) => {
    const button = traderButtons().find(item => traderName(item) === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const clickColumn = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const selectedColumn = () => container.querySelector('[aria-label="交易日记栏目"] [role="tab"][aria-selected="true"]')
  const latestReviewQuery = () => listReviews.mock.calls.at(-1)?.[0]

  await act(async () => {
    root.render(<QueryClientProvider client={client}><TradeJournalPage /></QueryClientProvider>)
  })

  await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
  await clickColumn('每日复盘')
  await vi.waitFor(() => expect(latestReviewQuery()).toMatchObject({ limit: 20, offset: 0, sort: 'date_desc' }))
  expect(latestReviewQuery()).toHaveProperty('trader', '杨鹏')
  expect(selectedColumn()?.textContent).toBe('每日复盘')

  await clickTrader('杨鹏')
  expect(selectedColumn()?.textContent).toBe('每日复盘')
  await vi.waitFor(() => expect(latestReviewQuery()).toMatchObject({ trader: '杨鹏', offset: 0, sort: 'date_desc' }))
  await vi.waitFor(() => expect(container.textContent).toContain('指数缩量震荡'))

  await clickTrader('AI选股:atr_pct')
  expect(selectedColumn()?.textContent).toBe('每日复盘')
  await vi.waitFor(() => expect(latestReviewQuery()).toMatchObject({ trader: 'AI选股:atr_pct', limit: 20, offset: 0, sort: 'date_desc' }))
  await vi.waitFor(() => expect(container.textContent).toContain('暂无记录'))
  expect(container.textContent).not.toContain('指数缩量震荡')
})

it('删除当前交易者最后一条记录后，交易者页签回到首位真实交易者', async () => {
  notifyManager.setNotifyFunction(callback => { act(callback) })
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

  const traderList = () => container.querySelector('[aria-label="交易者"]')
  const traderButtons = () => Array.from(traderList()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  const traderName = (button: HTMLButtonElement) => (button.textContent ?? '').replace(/\s+\d+$/, '').trim()
  const selectedTraderNames = () => traderButtons()
    .filter(button => button.getAttribute('aria-selected') === 'true')
    .map(traderName)
  const clickTrader = async (label: string) => {
    const button = traderButtons().find(item => traderName(item) === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const clickColumn = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
    await vi.waitFor(() => expect(container.querySelector("#journal-panel")).not.toBeNull())
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }

  await vi.waitFor(() => expect(traderButtons().map(traderName)).toEqual(['杨鹏', 'AI选股:atr_pct']))
  expect(traderButtons().map(button => (button.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual(['杨鹏 3', 'AI选股:atr_pct 1'])
  await clickTrader('AI选股:atr_pct')
  await clickColumn('交易记录')
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))

  const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="删除 贵州茅台 2026-10-12 交易记录"]')
  expect(deleteButton).not.toBeNull()
  await act(async () => deleteButton!.click())
  const confirmDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '删除')
  expect(confirmDelete).toBeDefined()
  await act(async () => confirmDelete!.click())

  await vi.waitFor(() => expect(traderButtons().map(button => (button.textContent ?? '').replace(/\s+/g, ' ').trim())).toEqual(['杨鹏 3']))
  expect(selectedTraderNames()).toEqual(['杨鹏'])
  expect(new URLSearchParams(window.location.search).get('trader')).toBe('杨鹏')
  expect(window.localStorage.getItem('tf-trade-journal-trader')).toBe('杨鹏')
})
