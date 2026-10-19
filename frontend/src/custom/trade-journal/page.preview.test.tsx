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

vi.mock('@/components/StockPreviewDialog', () => ({
  StockPreviewDialog: ({ symbol, name, onClose }: { symbol: string | null; name?: string; onClose: () => void }) => (
    symbol
      ? <div role="dialog" aria-label="股票详情"><p>{name}</p><p>{symbol}</p><button type="button" onClick={onClose}>关闭详情</button></div>
      : null
  ),
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
notifyManager.setNotifyFunction(callback => { act(callback) })

let dispose: (() => Promise<void>) | undefined
beforeEach(() => {
  notifyManager.setNotifyFunction(callback => { act(callback) })
  window.history.replaceState(null, '', '/')
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.history.replaceState(null, '', '/')
  notifyManager.setNotifyFunction(callback => callback())
})

async function renderPage() {
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

function traderName(button: HTMLButtonElement) {
  return (button.textContent ?? '').replace(/\s+\d+$/, '').trim()
}

function selectedTrader(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="交易者"] [role="tab"][aria-selected="true"]')
  return button ? traderName(button) : ''
}

function selectedColumn(container: HTMLElement) {
  return container.querySelector('[aria-label="交易日记栏目"] [role="tab"][aria-selected="true"]')?.textContent ?? ''
}

async function clickTrader(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).find(item => traderName(item) === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

async function clickColumn(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易日记栏目"] [role="tab"]')).find(item => item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

function previewDialog(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[role="dialog"][aria-label="股票详情"]')
}

async function openPreview(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  expect(button, label).not.toBeNull()
  await act(async () => button!.click())
  await vi.waitFor(() => expect(previewDialog(container)).not.toBeNull())
  return previewDialog(container)!
}

async function closePreview(container: HTMLElement) {
  const close = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '关闭详情')
  expect(close).toBeDefined()
  await act(async () => close!.click())
  await vi.waitFor(() => expect(previewDialog(container)).toBeNull())
}

it('持仓名称和代码打开茅台详情，关闭后交易者和栏目不变', async () => {
  const container = await renderPage()
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))
  expect(selectedTrader(container)).toBe('全部')
  expect(selectedColumn(container)).toBe('当前持仓')

  const byName = await openPreview(container, '查看 贵州茅台 详情')
  expect(byName.textContent).toContain('600519.SH')
  expect(byName.textContent).toContain('贵州茅台')
  await closePreview(container)
  expect(selectedTrader(container)).toBe('全部')
  expect(selectedColumn(container)).toBe('当前持仓')
  expect(window.location.search).toBe('')

  const byCode = await openPreview(container, '查看 600519.SH 详情')
  expect(byCode.textContent).toContain('600519.SH')
  expect(byCode.textContent).toContain('贵州茅台')
  await closePreview(container)
  expect(selectedTrader(container)).toBe('全部')
  expect(selectedColumn(container)).toBe('当前持仓')
  expect(container.querySelector('[aria-label="持仓截止日期"]')).not.toBeNull()
})

it('筛选后的记录和历史收益打开对应股票，关闭后交易者、栏目和筛选保持', async () => {
  const listRecords = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()
  await vi.waitFor(() => {
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).map(traderName)
    expect(names).toEqual(['全部', '杨鹏', 'AI选股:atr_pct'])
  })
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '交易记录')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))

  const codeInput = container.querySelector<HTMLInputElement>('[aria-label="按股票代码筛选"]')
  expect(codeInput).not.toBeNull()
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    nativeSetter.call(codeInput, '000001')
    codeInput!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '筛选')
  await act(async () => submit!.click())
  await vi.waitFor(() => expect(container.querySelector('[aria-label="查看 000001.SZ 详情"]')).not.toBeNull())
  expect(listRecords.mock.calls.at(-1)?.[0]).toMatchObject({ trader: '杨鹏', code: '000001', offset: 0 })
  const filteredQuery = listRecords.mock.calls.at(-1)?.[0]
  const searchBefore = window.location.search

  const byCode = await openPreview(container, '查看 000001.SZ 详情')
  expect(byCode.textContent).toContain('000001.SZ')
  expect(byCode.textContent).toContain('平安银行')
  await closePreview(container)

  expect(selectedTrader(container)).toBe('杨鹏')
  expect(selectedColumn(container)).toBe('交易记录')
  expect(codeInput?.value).toBe('000001')
  const tableCalls = listRecords.mock.calls.map(call => call[0]).filter(query => query?.limit === filteredQuery?.limit && query?.sort === filteredQuery?.sort)
  expect(tableCalls.at(-1)).toEqual(filteredQuery)
  expect(window.location.search).toBe(searchBefore)
  expect(container.textContent).toContain('平安银行')
  expect(container.textContent).not.toContain('贵州茅台')

  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const byName = await openPreview(container, '查看 平安银行 详情')
  expect(byName.textContent).toContain('000001.SZ')
  expect(byName.textContent).toContain('平安银行')
  await closePreview(container)
  expect(selectedTrader(container)).toBe('杨鹏')
  expect(selectedColumn(container)).toBe('历史收益')
  expect(window.location.search).toBe(searchBefore.replace('tab=records', 'tab=history'))
})
