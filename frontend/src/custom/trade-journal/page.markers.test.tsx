// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from '@/components/Toast'
import { journal } from './client'
import { TradeJournalPage } from './page'

vi.mock('./client', async () => {
  const { createMockTradeJournal } = await import('./mockStore')
  return { journal: createMockTradeJournal(true) }
})

vi.mock('@/components/Toast', () => ({ toast: vi.fn() }))

vi.mock('@/components/StockPreviewDialog', () => ({
  StockPreviewDialog: ({ symbol, name, markers, onClose }: { symbol: string | null; name?: string; markers?: unknown; onClose: () => void }) => (
    symbol
      ? <div role="dialog" aria-label="股票详情" data-markers={markers === undefined ? '' : JSON.stringify(markers)}><p>{name}</p><p>{symbol}</p><button type="button" onClick={onClose}>关闭详情</button></div>
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
  vi.mocked(toast).mockClear()
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.history.replaceState(null, '', '/')
  notifyManager.setNotifyFunction(callback => callback())
  vi.restoreAllMocks()
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

it('全部交易员打开详情不读取成交，详情也收不到标记', async () => {
  const listRecords = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))
  const dialog = await openPreview(container, '查看 贵州茅台 详情')
  expect(dialog.getAttribute('data-markers')).toBe('')
  expect(listRecords).not.toHaveBeenCalled()
})

it('选定交易员后把该股成交标记交给详情，换股票或交易员不沿用上一套', async () => {
  const listRecords = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()
  await vi.waitFor(() => {
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).map(traderName)
    expect(names).toEqual(['全部', '杨鹏', 'AI选股:atr_pct'])
  })
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const pingan = await openPreview(container, '查看 平安银行 详情')
  await vi.waitFor(() => expect(pingan.getAttribute('data-markers')).toContain('买 10.80 ×1000'))
  expect(pingan.getAttribute('data-markers')).toContain('卖 11.26 ×1000')
  expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({
    trader: '杨鹏', code: '000001', limit: 200, offset: 0, sort: 'trade_date_asc',
  }))

  await clickTrader(container, 'AI选股:atr_pct')
  await vi.waitFor(() => {
    const raw = previewDialog(container)?.getAttribute('data-markers') ?? ''
    expect(raw).not.toContain('10.80')
  })
  await vi.waitFor(() => expect(previewDialog(container)?.getAttribute('data-markers')).toBe('[]'))

  await clickColumn(container, '当前持仓')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="查看 贵州茅台 详情"]')).not.toBeNull())
  const maotai = await openPreview(container, '查看 贵州茅台 详情')
  await vi.waitFor(() => expect(maotai.getAttribute('data-markers')).toContain('买 1688.50 ×100'))
  expect(maotai.getAttribute('data-markers')).not.toContain('10.80')
  expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({
    trader: 'AI选股:atr_pct', code: '600519', limit: 200, offset: 0, sort: 'trade_date_asc',
  }))
  for (const [query] of listRecords.mock.calls) {
    expect(query?.trader).toBeTruthy()
    expect(query?.code).toMatch(/^[0-9]{6}$/)
  }
})

it('成交标记读取失败时详情仍在，且不把标记说成没有成交', async () => {
  vi.spyOn(journal, 'listRecords').mockRejectedValue(new Error('network'))
  const container = await renderPage()
  await vi.waitFor(() => {
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).map(traderName)
    expect(names).toEqual(['全部', '杨鹏', 'AI选股:atr_pct'])
  })
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const dialog = await openPreview(container, '查看 平安银行 详情')
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('成交标记加载失败'))
  expect(dialog.getAttribute('data-markers')).toBe('')
  expect(dialog.textContent).toContain('000001.SZ')
})
