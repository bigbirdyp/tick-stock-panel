// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StockDailyKChart } from './StockDailyKChart'

const chartProps = vi.hoisted(() => ({
  current: undefined as {
    markers?: { label?: string; trades?: readonly { price: number }[] }[]
    showMarkers?: boolean
  } | undefined,
}))

const klineQuery = vi.hoisted(() => ({
  data: {
    rows: [
      { date: '2026-01-05', open: 10, high: 11, low: 9, close: 11, volume: 100, signal_limit_up: true, consecutive_limit_ups: 2 },
      { date: '2026-01-06', open: 11, high: 12, low: 10, close: 10, volume: 90, signal_broken_limit_up: true },
      { date: '2026-01-07', open: 10, high: 11, low: 9.5, close: 10.2, volume: 80 },
    ],
  },
  isLoading: false,
  isError: false,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => klineQuery,
}))

vi.mock('@/components/EChartsCandlestick', () => ({
  EChartsCandlestick: (props: {
    markers?: { label?: string; trades?: readonly { price: number }[] }[]
    showMarkers?: boolean
  }) => {
    chartProps.current = props
    return null
  },
  SUB_CHARTS: [{ key: 'vol', label: '量', height: 64 }],
  OVERLAY_INDICATORS: [] as { key: string; label: string }[],
}))

const trade = { date: '2026-01-07', side: 'buy' as const, price: 10.2, quantity: 200, trader: '甲' }
const passedMarkers = [
  { date: '2026-01-07', kind: 'buy' as const, label: '买', trades: [trade] },
  { date: '2026-01-07', kind: 'sell' as const, label: '旧' },
  { date: '2026-01-05', kind: 'neutral' as const, label: '空', trades: [] as const },
]

let root: Root | null = null
const container = document.createElement('div')
document.body.appendChild(container)

afterEach(() => {
  if (root) {
    act(() => { root!.unmount() })
    root = null
  }
  container.innerHTML = ''
  chartProps.current = undefined
})

function render(node: ReactElement) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  if (!root) root = createRoot(container)
  act(() => { root!.render(node) })
}

function labels(): string[] {
  return (chartProps.current?.markers ?? []).map(marker => marker.label ?? '')
}

function anomalyButton(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(el => el.textContent === '异动')
  if (!(found instanceof HTMLButtonElement)) throw new Error('没有异动按钮')
  return found
}

it('关闭异动时保留成交，藏起旧标记，再打开恢复', () => {
  render(<StockDailyKChart symbol="000001" markers={passedMarkers} />)

  expect(labels()).toEqual(['买', '旧', '空', '2', '炸'])
  expect(chartProps.current?.showMarkers).toBe(true)
  expect(chartProps.current?.markers?.[0]?.trades).toEqual([trade])

  act(() => { anomalyButton().click() })

  expect(labels()).toEqual(['买'])
  expect(chartProps.current?.showMarkers).toBe(true)
  expect(chartProps.current?.markers?.[0]?.trades).toEqual([trade])

  act(() => { anomalyButton().click() })

  expect(labels()).toEqual(['买', '旧', '空', '2', '炸'])
  expect(chartProps.current?.showMarkers).toBe(true)
})

it('showLimitMarkers 关闭时成交标记仍传给图表', () => {
  render(<StockDailyKChart symbol="000001" showLimitMarkers={false} markers={passedMarkers} />)

  expect(labels()).toContain('买')
  expect(labels()).not.toContain('2')
  expect(labels()).not.toContain('炸')
  expect(chartProps.current?.markers?.some(marker => (marker.trades?.length ?? 0) > 0)).toBe(true)
  expect(chartProps.current?.showMarkers).toBe(true)
})
