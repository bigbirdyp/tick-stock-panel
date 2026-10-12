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
