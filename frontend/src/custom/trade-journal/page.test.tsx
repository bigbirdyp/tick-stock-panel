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
  notifyManager.setNotifyFunction(callback => callback())
})

it('渲染持仓和按卖出记录聚合的历史收益，并可切换栏目', async () => {
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

  const historyTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === '历史收益')
  expect(historyTab).toBeDefined()
  const currentTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
  await act(async () => currentTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(historyTab?.getAttribute('aria-selected')).toBe('true')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  expect(container.textContent).toContain('平安银行')
  expect(container.textContent).toContain('450.00')

  const reviewTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === '每日复盘')
  await act(async () => reviewTab!.click())
  await vi.waitFor(() => expect(container.textContent).toContain('指数缩量震荡'))
  expect(container.textContent).toContain('指数缩量震荡')
})

it('截止日期晚于行情日时，持仓表标出过期并仍显示旧价', async () => {
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

it('交易者页签按全部、A、B 过滤记录和持仓，新建表单沿用当前标签', async () => {
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
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const clickColumn = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const bodyText = () => Array.from(container.querySelectorAll('tbody tr')).map(row => row.textContent ?? '').join('\n')

  await vi.waitFor(() => expect(traderButtons().map(traderName)).toEqual(['全部', 'AI选股:atr_pct', '杨鹏']))
  expect(traderButtons()[0]?.getAttribute('aria-selected')).toBe('true')
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
  const cancel = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '取消')
  await act(async () => cancel!.click())

  await clickColumn('交易记录')
  await vi.waitFor(() => expect(bodyText()).toContain('平安银行'))
  expect(bodyText()).not.toContain('贵州茅台')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3)

  await clickTrader('全部')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).toContain('平安银行')

  await clickTrader('AI选股:atr_pct')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)

  await clickColumn('当前持仓')
  await vi.waitFor(() => expect(bodyText()).toContain('贵州茅台'))
  expect(bodyText()).not.toContain('平安银行')
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1)

  await clickColumn('每日复盘')
  await vi.waitFor(() => expect(container.textContent).toContain('指数缩量震荡'))
  expect(traderList()).toBeNull()
})

it('删除当前交易者最后一条记录后，交易者页签回到全部', async () => {
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
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }
  const clickColumn = async (label: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
    expect(button, label).toBeDefined()
    await act(async () => button!.click())
  }

  await vi.waitFor(() => expect(traderButtons().map(traderName)).toEqual(['全部', 'AI选股:atr_pct', '杨鹏']))
  await clickTrader('AI选股:atr_pct')
  await clickColumn('交易记录')
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))

  const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="删除 贵州茅台 2026-10-12 交易记录"]')
  expect(deleteButton).not.toBeNull()
  await act(async () => deleteButton!.click())
  const confirmDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '删除')
  expect(confirmDelete).toBeDefined()
  await act(async () => confirmDelete!.click())

  await vi.waitFor(() => expect(traderButtons().map(traderName)).toEqual(['全部', '杨鹏']))
  expect(selectedTraderNames()).toEqual(['全部'])
})
