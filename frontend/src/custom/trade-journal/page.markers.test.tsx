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
  window.localStorage.clear()
  notifyManager.setNotifyFunction(callback => { act(callback) })
  window.history.replaceState(null, '', '/')
  vi.mocked(toast).mockClear()
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  window.localStorage.clear()
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

it('当前交易员打开详情只读取该交易员成交，关闭后不再请求', async () => {
  window.localStorage.setItem('tf-trade-journal-trader', 'AI选股:atr_pct')
  const listRecords = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()
  await vi.waitFor(() => expect(container.textContent).toContain('贵州茅台'))
  const dialog = await openPreview(container, '查看 贵州茅台 详情')
  await vi.waitFor(() => expect(dialog.getAttribute('data-markers')).toContain('"trader":"AI选股:atr_pct"'))
  const markers = JSON.parse(dialog.getAttribute('data-markers') ?? 'null') as { kind: string; label: string; trades: { price: number; quantity: number; trader: string }[] }[]
  expect(markers).toEqual([{
    date: '2026-10-12',
    kind: 'buy',
    label: '买',
    trades: [{ date: '2026-10-12', side: 'buy', price: 1688.5, quantity: 100, trader: 'AI选股:atr_pct' }],
  }])
  expect(listRecords).toHaveBeenCalledWith({ trader: 'AI选股:atr_pct', code: '600519', limit: 200, offset: 0, sort: 'trade_date_asc' })
  expect(listRecords.mock.calls.every(([query]) => query?.trader === 'AI选股:atr_pct')).toBe(true)
  const calls = listRecords.mock.calls.length
  await act(async () => dialog.querySelector('button')?.click())
  expect(previewDialog(container)).toBeNull()
  await act(async () => { await Promise.resolve() })
  expect(listRecords.mock.calls.length).toBe(calls)
})

it('选定交易员后把该股逐笔标记交给详情，换股票或交易员不沿用上一套', async () => {
  const listRecords = vi.spyOn(journal, 'listRecords')
  const container = await renderPage()
  await vi.waitFor(() => {
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).map(traderName)
    expect(names).toEqual(['杨鹏', 'AI选股:atr_pct'])
  })
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const pingan = await openPreview(container, '查看 平安银行 详情')
  await vi.waitFor(() => expect(pingan.getAttribute('data-markers')).toContain('"price":10.8'))
  const pinganMarkers = JSON.parse(pingan.getAttribute('data-markers') ?? 'null') as { label: string; trades: { quantity: number; side: string }[] }[]
  expect(pinganMarkers.map(marker => marker.label)).toEqual(['买', '卖'])
  expect(pinganMarkers[0]?.trades.map(trade => trade.quantity)).toEqual([600, 400])
  expect(pinganMarkers[1]?.trades).toEqual([expect.objectContaining({ side: 'sell', price: 11.26, quantity: 1000, trader: '杨鹏' })])
  expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({
    trader: '杨鹏', code: '000001', limit: 200, offset: 0, sort: 'trade_date_asc',
  }))

  await clickTrader(container, 'AI选股:atr_pct')
  await vi.waitFor(() => {
    const raw = previewDialog(container)?.getAttribute('data-markers') ?? ''
    expect(raw).not.toContain('10.8')
  })
  await vi.waitFor(() => expect(previewDialog(container)).toBeNull())

  await clickColumn(container, '当前持仓')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="查看 贵州茅台 详情"]')).not.toBeNull())
  const maotai = await openPreview(container, '查看 贵州茅台 详情')
  await vi.waitFor(() => expect(maotai.getAttribute('data-markers')).toContain('"price":1688.5'))
  expect(maotai.getAttribute('data-markers')).not.toContain('10.8')
  expect(maotai.getAttribute('data-markers')).toContain('"label":"买"')
  expect(listRecords).toHaveBeenCalledWith(expect.objectContaining({
    trader: 'AI选股:atr_pct', code: '600519', limit: 200, offset: 0, sort: 'trade_date_asc',
  }))
  for (const [query] of listRecords.mock.calls) {
    expect(query?.trader).toBeTruthy()
    expect(query?.code).toMatch(/^[0-9]{6}$/)
  }
})

it('切换交易员或股票时，新结果返回前不留下上一套标记', async () => {
  const real = journal.listRecords.bind(journal)
  const held: { query: Parameters<typeof real>[0]; finish: (value: Awaited<ReturnType<typeof real>>) => void }[] = []
  vi.spyOn(journal, 'listRecords').mockImplementation(query => {
    const hold = query.trader === 'AI选股:atr_pct' && (query.code === '000001' || query.code === '600519')
    if (!hold) return real(query)
    return new Promise(resolve => { held.push({ query, finish: resolve }) })
  })
  const container = await renderPage()
  await vi.waitFor(() => expect(container.querySelector('#journal-tab-history')).not.toBeNull())
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const pingan = await openPreview(container, '查看 平安银行 详情')
  await vi.waitFor(() => expect(pingan.getAttribute('data-markers')).toContain('"price":10.8'))

  await clickTrader(container, 'AI选股:atr_pct')
  expect(previewDialog(container)).toBeNull()
  expect(held).toHaveLength(1)
  held[0]?.finish(await real(held[0].query))
  await vi.waitFor(() => expect(previewDialog(container)).toBeNull())

  await clickColumn(container, '当前持仓')
  await vi.waitFor(() => expect(container.querySelector('[aria-label="查看 贵州茅台 详情"]')).not.toBeNull())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看 贵州茅台 详情"]')?.click())
  expect(previewDialog(container)?.getAttribute('data-markers')).toBe('')
  expect(held).toHaveLength(2)
  held[1]?.finish(await real(held[1].query))
  await vi.waitFor(() => expect(previewDialog(container)?.getAttribute('data-markers')).toContain('"price":1688.5'))
  expect(previewDialog(container)?.getAttribute('data-markers')).not.toContain('10.8')
})

it('成交标记读取失败时详情仍在，且不把标记说成没有成交', async () => {
  vi.spyOn(journal, 'listRecords').mockRejectedValue(new Error('network'))
  const container = await renderPage()
  await vi.waitFor(() => {
    const names = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="交易者"] [role="tab"]')).map(traderName)
    expect(names).toEqual(['杨鹏', 'AI选股:atr_pct'])
  })
  await clickTrader(container, '杨鹏')
  await clickColumn(container, '历史收益')
  await vi.waitFor(() => expect(container.textContent).toContain('平安银行'))
  const dialog = await openPreview(container, '查看 平安银行 详情')
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('成交标记加载失败'))
  expect(dialog.getAttribute('data-markers')).toBe('')
  expect(dialog.textContent).toContain('000001.SZ')
})
