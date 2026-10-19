// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
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

const reviewSearch = `?tab=reviews&trader=${encodeURIComponent('杨鹏')}`

beforeAll(async () => {
  await journal.createReview({ trader: '杨鹏', date: '2026-10-18', content: '今天关注贵州茅台' })
  await journal.createReview({ trader: '杨鹏', date: '2026-10-17', content: '今天关注贵州茅台，代码600519' })
})

let dispose: (() => Promise<void>) | undefined
beforeEach(() => {
  notifyManager.setNotifyFunction(callback => { act(callback) })
  window.history.replaceState(null, '', `/trade-journal${reviewSearch}`)
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
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

it('直接进入每日复盘时，快照里的名称可点，关闭后地址、交易者和栏目不变', async () => {
  const snapshot = vi.spyOn(api, 'marketSnapshot').mockResolvedValue({
    as_of: '2026-10-19',
    rows: [{ symbol: '600519.SH', name: '贵州茅台' }],
  })
  const positions = vi.spyOn(journal, 'currentPositions')
  const history = vi.spyOn(journal, 'history')
  const records = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()

  await vi.waitFor(() => expect(container.querySelector('[aria-label="查看 贵州茅台 详情"]')).not.toBeNull())
  expect(snapshot).toHaveBeenCalledTimes(1)
  expect(positions).not.toHaveBeenCalled()
  expect(history).not.toHaveBeenCalled()
  expect(records).not.toHaveBeenCalled()
  expect(selectedTrader(container)).toBe('杨鹏')
  expect(selectedColumn(container)).toBe('每日复盘')

  const dialog = await openPreview(container, '查看 贵州茅台 详情')
  expect(dialog.textContent).toContain('600519.SH')
  expect(dialog.textContent).toContain('贵州茅台')
  await closePreview(container)

  expect(window.location.search).toBe(reviewSearch)
  expect(selectedTrader(container)).toBe('杨鹏')
  expect(selectedColumn(container)).toBe('每日复盘')
  expect(container.textContent).toContain('今天关注贵州茅台')
})

it('行情目录失败时，复盘里的明确代码仍可点，纯名称保持原文', async () => {
  vi.spyOn(api, 'marketSnapshot').mockRejectedValue(new Error('snapshot failed'))
  const container = await renderPage()

  await vi.waitFor(() => expect(container.textContent).toContain('代码600519'))
  expect(container.querySelector('[aria-label="查看 贵州茅台 详情"]')).toBeNull()
  const dialog = await openPreview(container, '查看 600519.SH 详情')
  expect(dialog.textContent).toContain('600519.SH')
  await closePreview(container)

  expect(window.location.search).toBe(reviewSearch)
  expect(selectedTrader(container)).toBe('杨鹏')
  expect(selectedColumn(container)).toBe('每日复盘')
  expect(container.textContent).toContain('今天关注贵州茅台，代码600519')
})
