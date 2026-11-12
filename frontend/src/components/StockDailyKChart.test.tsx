// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KlineRow } from '@/lib/api'
import { StockDailyKChart } from './StockDailyKChart'

const fixture = vi.hoisted(() => ({ rows: [
  { date: '2026-11-03', open: 10, high: 11, low: 10, close: 11, volume: 100, signal_limit_up: true, consecutive_limit_ups: 3 },
  { date: '2026-11-04', open: 11, high: 12, low: 10, close: 10.5, volume: 100, signal_limit_up: true, signal_broken_limit_up: true },
  { date: '2026-11-05', open: 10.5, high: 11, low: 10, close: 10.8, volume: 100 },
  { date: '2026-11-06', open: 10.2, high: 11.88, low: 9.72, close: 9.72, volume: 100, signal_limit_down: true, signal_broken_limit_up: true },
] as KlineRow[] }))
const queryFlags = vi.hoisted(() => ({ isLoading: false, isError: false, hideData: false }))
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({
  data: queryFlags.hideData ? undefined : fixture,
  isLoading: queryFlags.isLoading,
  isError: queryFlags.isError,
}) }))
vi.mock('@/lib/kline', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/kline')>(), klineDailyQueryOptions: vi.fn(() => ({})),
}))
vi.mock('./charts/LightweightDaily', () => ({ LightweightDaily: (props: any) => <output>{JSON.stringify(props)}</output> }))
vi.mock('./EChartsCandlestick', () => ({ EChartsCandlestick: (props: any) => <output>{JSON.stringify(props)}</output> }))

let host: HTMLDivElement, root: Root
const originalRows = fixture.rows
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  fixture.rows = originalRows
  queryFlags.isLoading = false
  queryFlags.isError = false
  queryFlags.hideData = false
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })
const props = () => JSON.parse(host.querySelector('output')!.textContent!)
const render = async (extra: Partial<Parameters<typeof StockDailyKChart>[0]> = {}) => act(async () => {
  root.render(<StockDailyKChart symbol="605365.SH" renderer="lightweight" {...extra} />)
})
const text = () => host.textContent ?? ''
const labels = () => (props().markers ?? []).map((marker: { label?: string }) => marker.label ?? '')

it('identifies limit events from existing signals, prioritizing a limit-down close over a broken limit-up', async () => {
  await render({ markers: [{ date: '2026-11-05', kind: 'buy', label: '策略买点' }] })
  expect((host.querySelector('[aria-label="异动显示方式"]') as HTMLSelectElement).value).toBe('label')
  expect(props().markerStyle).toBe('label')
  expect(props().markers).toEqual([
    expect.objectContaining({ label: '策略买点' }),
    expect.objectContaining({ date: '2026-11-03', event: 'limit_up', label: '3', color: '#FACC15' }),
    expect.objectContaining({ date: '2026-11-04', event: 'broken_limit_up', label: '炸', color: '#8B5CF6' }),
    expect.objectContaining({ date: '2026-11-06', event: 'limit_down', kind: 'sell', above: false, label: '跌', color: '#22D3EE' }),
  ])
  expect(props().markers[0].event).toBeUndefined()
})

it.each([
  ['bearish recovery', { open: 4.75, signal_limit_down_recovery: false }, 'limit_down_recovery'],
  ['bullish recovery', { open: 4.6, signal_limit_down_recovery: true }, 'limit_down_recovery'],
  ['doji recovery', { open: 4.7 }, 'limit_down_recovery'],
  ['no custom signal', { signal_limit_down_recovery: undefined }, 'limit_down_recovery'],
  ['not touching the raw limit', { raw_low: 9.01 }, undefined],
  ['still at the raw limit', { raw_close: 9.005 }, undefined],
  ['no-limit day overrides old signal', { limit_down_price: null, signal_limit_down_recovery: true }, undefined],
  ['invalid raw price', { raw_low: NaN, signal_limit_down_recovery: true }, undefined],
  ['missing raw price', { raw_close: undefined }, undefined],
  ['legacy recovery signal', { raw_low: undefined, raw_close: undefined, limit_down_price: undefined, signal_limit_down_recovery: true }, 'limit_down_recovery'],
  ['legacy absent signal', { raw_low: undefined, raw_close: undefined, limit_down_price: undefined }, undefined],
  ['sealed limit-down wins', { signal_limit_down: true }, 'limit_down'],
  ['broken limit-up wins a two-sided touch', { signal_broken_limit_up: true }, 'broken_limit_up'],
  ['sealed limit-up wins', { signal_limit_up: true }, 'limit_up'],
] as [string, Partial<KlineRow>, string | undefined][])('identifies %s from raw limit metadata without changing signal definitions', async (_name, patch, event) => {
  const row: KlineRow = { date: '2026-11-05', open: 4.75, high: 5, low: 4.5, close: 4.7, volume: 100,
    raw_low: 9, raw_close: 9.4, limit_down_price: 9.005, ...patch }
  fixture.rows = [row]
  await render()
  expect(props().markers.map((marker: { event?: string }) => marker.event)).toEqual(event ? [event] : [])
  expect(fixture.rows[0]).toEqual(row)
  await render({ renderer: 'echarts' })
  expect(props().markers.some((marker: { event?: string }) => marker.event === 'limit_down_recovery')).toBe(false)
  await render({ showLimitMarkers: false })
  expect(props().markers).toEqual([])
})

it('persists the style independently of the existing marker on/off switch', async () => {
  await render()
  const select = host.querySelector('[aria-label="异动显示方式"]') as HTMLSelectElement
  expect([...select.options].map(option => [option.value, option.text])).toEqual([['label', '文字'], ['candle', '颜色']])
  await act(async () => { select.value = 'candle'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(props().markerStyle).toBe('candle')
  expect(JSON.parse(localStorage.getItem('stock_daily_marker_style')!)).toBe('candle')
  const toggle = [...host.querySelectorAll('button')].find(button => button.textContent === '异动')!
  await act(async () => toggle.click())
  expect(props().showMarkers).toBe(false)
  expect(select.disabled).toBe(true)
  await act(async () => toggle.click())
  expect(props().showMarkers).toBe(true)
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  expect(props().markerStyle).toBe('candle')
})

it('falls back from a saved arrow preference to text labels without discarding candle preferences', async () => {
  localStorage.setItem('stock_daily_marker_style', JSON.stringify('arrow'))
  await render()
  expect(props().markerStyle).toBe('label')
  expect((host.querySelector('[aria-label="异动显示方式"]') as HTMLSelectElement).value).toBe('label')
  expect(host.querySelector('option[value="arrow"]')).toBeNull()
})

it('rejects unknown saved styles and leaves legacy ECharts consumers on their existing behavior', async () => {
  localStorage.setItem('stock_daily_marker_style', JSON.stringify('unsupported'))
  await render()
  expect(props().markerStyle).toBe('label')
  await render({ renderer: 'echarts' })
  expect(host.querySelector('[aria-label="异动显示方式"]')).toBeNull()
  expect(props().markerStyle).toBeUndefined()
  expect(props().markers.some((marker: { event?: string }) => marker.event === 'limit_down')).toBe(false)
  expect(props().markers).toContainEqual(expect.objectContaining({ date: '2026-11-06', event: 'broken_limit_up' }))
})

it('hides the style selector wherever the existing event toggle is unavailable', async () => {
  await render({ showMarkerToggle: false })
  expect(host.querySelector('[aria-label="异动显示方式"]')).toBeNull()
  await render({ showLimitMarkers: false })
  expect(host.querySelector('[aria-label="异动显示方式"]')).toBeNull()
})

const trade = { date: '2026-01-07', side: 'buy' as const, price: 10.2, quantity: 200, trader: '甲' }
const passedMarkers = [
  { date: '2026-01-07', kind: 'buy' as const, label: '买', trades: [trade] },
  { date: '2026-01-07', kind: 'sell' as const, label: '旧' },
  { date: '2026-01-05', kind: 'neutral' as const, label: '空', trades: [] as const },
]

it('关闭异动时保留成交，藏起旧标记，再打开恢复', async () => {
  fixture.rows = [
    { date: '2026-01-05', open: 10, high: 11, low: 9, close: 11, volume: 100, signal_limit_up: true, consecutive_limit_ups: 2 },
    { date: '2026-01-06', open: 11, high: 12, low: 10, close: 10, volume: 90, signal_broken_limit_up: true },
    { date: '2026-01-07', open: 10, high: 11, low: 9.5, close: 10.2, volume: 80 },
  ]
  await render({ renderer: 'echarts', symbol: '000001', markers: passedMarkers })

  expect(labels()).toEqual(['买', '旧', '空', '2', '炸'])
  expect(props().showMarkers).toBe(true)
  expect(props().markers[0].trades).toEqual([trade])

  const toggle = [...host.querySelectorAll('button')].find(button => button.textContent === '异动')!
  await act(async () => toggle.click())
  expect(labels()).toEqual(['买'])
  expect(props().showMarkers).toBe(true)
  expect(props().markers[0].trades).toEqual([trade])

  await act(async () => toggle.click())
  expect(labels()).toEqual(['买', '旧', '空', '2', '炸'])
  expect(props().showMarkers).toBe(true)
})

it('showLimitMarkers 关闭时成交标记仍传给图表', async () => {
  fixture.rows = [
    { date: '2026-01-05', open: 10, high: 11, low: 9, close: 11, volume: 100, signal_limit_up: true, consecutive_limit_ups: 2 },
    { date: '2026-01-06', open: 11, high: 12, low: 10, close: 10, volume: 90, signal_broken_limit_up: true },
    { date: '2026-01-07', open: 10, high: 11, low: 9.5, close: 10.2, volume: 80 },
  ]
  await render({ renderer: 'echarts', symbol: '000001', showLimitMarkers: false, markers: passedMarkers })
  expect(labels()).toContain('买')
  expect(labels()).not.toContain('2')
  expect(labels()).not.toContain('炸')
  expect(props().markers.some((marker: { trades?: readonly { price: number }[] }) => (marker.trades?.length ?? 0) > 0)).toBe(true)
  expect(props().showMarkers).toBe(true)
})

it('成功空K线显示暂无日K，并按笔统计同日多笔和多组', async () => {
  fixture.rows = []
  const markers = [
    {
      date: '2026-01-07',
      kind: 'buy' as const,
      label: '买',
      trades: [trade, { ...trade, price: 10.4, quantity: 100 }],
    },
    {
      date: '2026-01-07',
      kind: 'sell' as const,
      label: '卖',
      trades: [{ ...trade, side: 'sell' as const, price: 10.8, quantity: 50 }],
    },
    { date: '2026-01-06', kind: 'neutral' as const, label: '旧' },
    { date: '2026-01-05', kind: 'neutral' as const, label: '空', trades: [] as const },
  ]
  await render({ symbol: '000001', markers })
  expect(text()).toContain('暂无日K数据')
  expect(text()).toContain('有 3 笔交易不在当前区间')
  expect(text()).not.toContain('有 2 笔')
  expect(text()).not.toContain('有 4 笔')
  expect(host.querySelector('output')).toBeNull()
})

it('空K线没有成交或标记未就绪时不显示笔数', async () => {
  fixture.rows = []
  await render({ symbol: '000001', markers: [{ date: '2026-01-07', kind: 'sell', label: '旧' }] })
  expect(text()).toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')

  await render({ symbol: '000001', markers: [{ date: '2026-01-05', kind: 'neutral', label: '空', trades: [] }] })
  expect(text()).toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')

  await render({ symbol: '000001' })
  expect(text()).toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')
})

it('加载、失败和尚未返回时不显示空K成功状态', async () => {
  const markers = [{ date: '2026-01-07', kind: 'buy' as const, label: '买', trades: [trade, trade] }]
  fixture.rows = []
  queryFlags.isLoading = true
  await render({ symbol: '000001', markers })
  expect(text()).toContain('加载中')
  expect(text()).not.toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')
  expect(host.querySelector('output')).toBeNull()

  queryFlags.isLoading = false
  queryFlags.isError = true
  await render({ symbol: '000001', markers })
  expect(text()).toContain('日K加载失败')
  expect(text()).not.toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')

  queryFlags.isError = false
  queryFlags.hideData = true
  await render({ symbol: '000001', markers })
  expect(text()).not.toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')
  expect(text()).not.toContain('日K加载失败')
  expect(text()).not.toContain('加载中')
})

it('原始行全部无效时仍只显示格式异常', async () => {
  fixture.rows = [{ date: null, open: null, close: null } as unknown as KlineRow]
  await render({ symbol: '000001', markers: [{ date: '2026-01-07', kind: 'buy', trades: [trade] }] })
  expect(text()).toContain('数据格式异常，请刷新页面')
  expect(text()).not.toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')
  expect(host.querySelector('output')).toBeNull()
})

it('切换 symbol 和 markers 后显示当前笔数', async () => {
  fixture.rows = []
  await render({
    symbol: '000001',
    markers: [{ date: '2026-01-07', kind: 'buy', trades: [trade, { ...trade, price: 10.5 }] }],
  })
  expect(text()).toContain('有 2 笔交易不在当前区间')

  await render({
    symbol: '000002',
    markers: [{ date: '2026-01-08', kind: 'sell', trades: [{ ...trade, date: '2026-01-08', side: 'sell' }] }],
  })
  expect(text()).toContain('暂无日K数据')
  expect(text()).toContain('有 1 笔交易不在当前区间')
  expect(text()).not.toContain('有 2 笔交易不在当前区间')

  fixture.rows = originalRows
  await render({
    symbol: '000002',
    markers: [{ date: '2026-01-08', kind: 'sell', trades: [trade, trade, trade] }],
  })
  expect(text()).not.toContain('暂无日K数据')
  expect(text()).not.toContain('不在当前区间')
  expect(props().markers.some((marker: { trades?: readonly unknown[] }) => (marker.trades?.length ?? 0) > 0)).toBe(true)
})
