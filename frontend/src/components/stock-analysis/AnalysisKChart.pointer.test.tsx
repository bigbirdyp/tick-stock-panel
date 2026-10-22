// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KlineRow } from '@/lib/api'
import { AnalysisKChart } from './AnalysisKChart'

type ZoomMouseEvent = MouseEvent & { zrX?: number; zrY?: number }

const POINTER_TYPES = [
  'mousemove',
  'pointermove',
  'mousedown',
  'pointerdown',
  'mouseup',
  'pointerup',
  'mouseout',
  'pointerout',
  'click',
  'dblclick',
  'contextmenu',
]

const harness = vi.hoisted(() => ({
  order: [] as string[],
  binds: 0,
  unbinds: 0,
  initCount: 0,
  chart: {
    setOption: vi.fn(),
    on: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  },
}))

vi.mock('echarts', () => ({
  init: () => {
    harness.order.push('init')
    harness.initCount += 1
    return harness.chart
  },
}))

function row(date: string, close: number): KlineRow {
  return { date, open: close, high: close + 1, low: close - 1, close, volume: 100 }
}

function isCapture(options: boolean | AddEventListenerOptions | undefined): boolean {
  return options === true || (!!options && typeof options === 'object' && options.capture === true)
}

// createRoot 会在宿主节点上注册一套捕获委托。只统计图表容器本身。
// 卸载时 React 先摘掉该节点，useEffect cleanup 才 removeEventListener，所以要记住节点引用。
function isChartTarget(target: EventTarget): boolean {
  if (chartTarget) return target === chartTarget
  const matched = host instanceof HTMLDivElement
    && target instanceof HTMLDivElement
    && target !== host
    && host.contains(target)
    && target.style.height !== ''
  if (matched) chartTarget = target
  return matched
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let mounted = false
let chartTarget: EventTarget | null = null
let restoreAdd: typeof EventTarget.prototype.addEventListener
let restoreRemove: typeof EventTarget.prototype.removeEventListener

beforeEach(() => {
  mounted = true
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  harness.order = []
  harness.binds = 0
  harness.unbinds = 0
  harness.initCount = 0
  chartTarget = null
  harness.chart.setOption.mockClear()
  harness.chart.on.mockClear()
  restoreAdd = EventTarget.prototype.addEventListener
  restoreRemove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (POINTER_TYPES.includes(type) && isCapture(options) && isChartTarget(this)) {
      harness.binds += 1
      if (!harness.order.includes('bind')) harness.order.push('bind')
    }
    return restoreAdd.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (POINTER_TYPES.includes(type) && isCapture(options) && isChartTarget(this)) harness.unbinds += 1
    return restoreRemove.call(this, type, listener, options)
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  mounted = false
  host.remove()
  EventTarget.prototype.addEventListener = restoreAdd
  EventTarget.prototype.removeEventListener = restoreRemove
})

function chartEl(): HTMLDivElement {
  const el = host.querySelector('div[style*="height"]')
  if (!(el instanceof HTMLDivElement)) throw new Error('chart container missing')
  return el
}

function attachCanvas(scale: { width: number; height: number }) {
  const canvas = chartEl().appendChild(document.createElement('canvas'))
  Object.defineProperties(canvas, {
    clientWidth: { value: 600, configurable: true },
    clientHeight: { value: 400, configurable: true },
  })
  canvas.getBoundingClientRect = () => ({
    left: 100,
    top: 200,
    width: scale.width,
    height: scale.height,
    right: 100 + scale.width,
    bottom: 200 + scale.height,
    x: 100,
    y: 200,
    toJSON() {},
  }) as DOMRect
  return canvas
}

function zoomEvent(type: string): ZoomMouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: 370, clientY: 380 }) as ZoomMouseEvent
  Object.defineProperty(event, 'offsetX', { value: 270 })
  Object.defineProperty(event, 'offsetY', { value: 180 })
  return event
}

it('无交易标记时挂载即绑定，数据更新不重绑，卸载后 wheel 与悬停都不再改写', async () => {
  await act(async () => root.render(
    <AnalysisKChart rows={[row('2024-01-02', 10), row('2024-01-03', 11)]} height={460} />,
  ))

  expect(harness.order).toEqual(['bind', 'init'])
  expect(harness.binds).toBe(POINTER_TYPES.length)
  expect(harness.unbinds).toBe(0)
  expect(harness.initCount).toBe(1)

  const option = harness.chart.setOption.mock.calls.at(-1)?.[0] as {
    tooltip?: { show?: boolean }
    dataZoom?: unknown[]
    series?: Array<{ name?: string; markPoint?: unknown }>
  }
  expect(option.tooltip?.show).toBe(false)
  expect(option.dataZoom).toHaveLength(2)
  expect(option.series?.find(series => series.name === 'K')?.markPoint).toBeUndefined()

  await act(async () => root.render(
    <AnalysisKChart rows={[row('2024-01-02', 12), row('2024-01-03', 13), row('2024-01-04', 14)]} height={460} />,
  ))
  await act(async () => root.render(
    <AnalysisKChart rows={[row('2024-02-01', 20)]} height={460} />,
  ))

  expect(harness.binds).toBe(POINTER_TYPES.length)
  expect(harness.unbinds).toBe(0)
  expect(harness.initCount).toBe(1)

  const canvas = attachCanvas({ width: 540, height: 360 })
  const at90 = zoomEvent('mousemove')
  canvas.dispatchEvent(at90)
  expect([at90.zrX, at90.zrY]).toEqual([300, 200])
  expect([at90.offsetX, at90.offsetY]).toEqual([270, 180])

  canvas.getBoundingClientRect = () => ({
    left: 100, top: 200, width: 600, height: 400, right: 700, bottom: 600, x: 100, y: 200, toJSON() {},
  }) as DOMRect
  const at100 = zoomEvent('mousemove')
  canvas.dispatchEvent(at100)
  expect([at100.zrX, at100.zrY]).toEqual([270, 180])

  const wheel = new WheelEvent('wheel', { bubbles: true, clientX: 370, clientY: 380, deltaY: 2 })
  Object.defineProperty(wheel, 'offsetX', { value: 270 })
  Object.defineProperty(wheel, 'offsetY', { value: 180 })
  canvas.dispatchEvent(wheel)
  expect((wheel as ZoomMouseEvent).zrX).toBeUndefined()
  expect([wheel.offsetX, wheel.offsetY]).toEqual([270, 180])

  const bindsBeforeUnmount = harness.binds
  await act(async () => root.unmount())
  mounted = false
  expect(harness.unbinds).toBe(POINTER_TYPES.length)
  expect(harness.binds).toBe(bindsBeforeUnmount)

  const after = zoomEvent('click')
  canvas.dispatchEvent(after)
  expect(after.zrX).toBeUndefined()
  expect([after.offsetX, after.offsetY]).toEqual([270, 180])
})
