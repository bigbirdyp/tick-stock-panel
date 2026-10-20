// @vitest-environment jsdom
import { act, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EChartsCandlestick, type ChartMarker, type OHLC } from './EChartsCandlestick'

const chart = vi.hoisted(() => {
  const zoomState = { current: { start: 0, end: 100 } as Record<string, number | string> }
  return {
    handlers: {} as Record<string, (event?: any) => void>,
    zoomState,
    setOption: vi.fn((option?: { dataZoom?: Array<Record<string, number | string>> }) => {
      const zoom = option?.dataZoom?.[0]
      if (zoom) zoomState.current = { ...zoom }
    }),
    on: vi.fn(),
    off: vi.fn(),
    // 与 ECharts setRawRange 一致：只传百分比时清掉成对的 startValue/endValue。
    dispatchAction: vi.fn((action?: {
      type?: string
      start?: number
      end?: number
      startValue?: number | string
      endValue?: number | string
    }) => {
      if (action?.type !== 'dataZoom') return
      const next = { ...zoomState.current }
      if (action.start != null || action.startValue != null) {
        if (action.start != null) next.start = action.start
        else delete next.start
        if (action.startValue != null) next.startValue = action.startValue
        else delete next.startValue
      }
      if (action.end != null || action.endValue != null) {
        if (action.end != null) next.end = action.end
        else delete next.end
        if (action.endValue != null) next.endValue = action.endValue
        else delete next.endValue
      }
      zoomState.current = next
    }),
    resize: vi.fn(),
    dispose: vi.fn(),
    getZr: () => ({ on: vi.fn(), off: vi.fn() }),
    getOption: () => ({ dataZoom: [{ ...zoomState.current }] }),
    containPixel: () => false,
    convertFromPixel: () => [0, 0],
  }
})

vi.mock('echarts', () => ({ init: () => chart }))

// 超过 COMPACT_THRESHOLD(60): 切标的后 dataZoom 一响就会走紧凑态转换, 进而重写 markPoint
const DAYS = Array.from({ length: 62 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10))
const rows = (base: number): OHLC[] =>
  DAYS.map(date => ({ date, open: base, high: base + 1, low: base - 1, close: base, volume: 1 }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  chart.handlers = {}
  chart.zoomState.current = { start: 0, end: 100 }
  chart.setOption.mockClear()
  chart.dispatchAction.mockClear()
  chart.on.mockImplementation((name: string, callback: (event?: any) => void) => {
    chart.handlers[name] = callback
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** 最后一次 setOption 里 K 线的 markPoint (买卖箭头来源) */
function lastMarkPoint(): string {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const k = option?.series?.find((s: any) => s.name === 'K')
  return JSON.stringify(k?.markPoint ?? null)
}

/** 模拟竖虚线命中某根 K 线 (鼠标在数据区内移动时 echarts 派发的事件) */
async function hoverCandle(index: number) {
  await act(async () => { chart.handlers.updateAxisPointer?.({ axesInfo: [{ value: index }] }) })
}

it('切标的后响应 dataZoom 仍用当前标的的买卖标记, 不回退到上一只', async () => {
  const render = async (symbol: string, data: OHLC[], markerLabel: string, markerDate: string) => {
    await act(async () => root.render(
      <EChartsCandlestick
        data={data}
        markers={[{ date: markerDate, kind: 'buy', label: markerLabel }]}
        symbol={symbol}
        height={400}
        showInfoBar={false}
        visibleBars="all"
        activeIndicators={['vol']}
      />,
    ))
  }

  await render('600000', rows(10), 'A-BUY', DAYS[10])
  await render('000001', rows(100), 'B-SELL', DAYS[20])

  // 切换标的后图表实例被复用, dataZoom 监听仍是最初注册的那个; 首次 setOption 已是当前标的
  expect(lastMarkPoint()).toContain('B-SELL')

  await act(async () => { chart.handlers.dataZoom?.() })

  expect(lastMarkPoint()).toContain('B-SELL')
  expect(lastMarkPoint()).not.toContain('A-BUY')
})

it('切股后鼠标未离开图表, 竖虚线重新命中即恢复「至今/周期」', async () => {
  const render = async (symbol: string) => {
    await act(async () => root.render(
      <EChartsCandlestick data={rows(10)} symbol={symbol} height={400} visibleBars="all" />,
    ))
  }

  await render('600000')
  const surface = host.firstElementChild as HTMLElement
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseenter')) })
  await hoverCandle(30)
  expect(host.textContent).toContain('至今')

  // 切股: 上一只的悬停上下文作废, 清掉「至今/周期」
  await render('000001')
  expect(host.textContent).not.toContain('至今')

  // 鼠标没离开图表区 (只是切股), 竖虚线重新命中即恢复, 不靠 mouseenter
  await hoverCandle(20)
  expect(host.textContent).toContain('至今')
  expect(host.textContent).toContain('周期')

  // 移出图表区 → 重新收起
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseleave')) })
  expect(host.textContent).not.toContain('至今')
})

const BULL = '#C74040'
const BEAR = '#2D9B65'

function kSeriesFrom(option: any) {
  return option?.series?.find((series: any) => series.name === 'K')
}

function lastKMarkData(): any[] {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  return kSeriesFrom(option)?.markPoint?.data ?? []
}

function lastOptionWithTooltip(): any {
  const calls = chart.setOption.mock.calls.map(call => call[0] as any)
  return [...calls].reverse().find(option => option?.tooltip)
}

async function renderChart(symbol: string, markers: ChartMarker[]) {
  await act(async () => root.render(
    <EChartsCandlestick
      data={rows(10)}
      markers={markers}
      symbol={symbol}
      height={400}
      showInfoBar={false}
      visibleBars="all"
      activeIndicators={['vol']}
    />,
  ))
}

function tradeMarker(date: string, trades: ChartMarker['trades'], label?: string): ChartMarker {
  const buy = trades?.some(trade => trade.side === 'buy') ?? false
  const sell = trades?.some(trade => trade.side === 'sell') ?? false
  const kind = buy && !sell ? 'buy' : !buy && sell ? 'sell' : 'neutral'
  return { date, kind, label, trades }
}

function svgOf(symbol: string): string {
  const encoded = symbol.slice(symbol.indexOf(',') + 1)
  return decodeURIComponent(encoded)
}

it('单买是红色上箭头，文字为买，坐标在最低价下方', async () => {
  const date = DAYS[10]
  await renderChart('600000', [tradeMarker(date, [
    { date, side: 'buy', price: 10.125, quantity: 100, trader: '甲' },
  ])])

  const [point] = lastKMarkData()
  expect(lastKMarkData()).toHaveLength(1)
  expect(point.symbol).toBe('arrow')
  expect(point.symbolRotate).toBe(0)
  expect(point.symbolOffset).toEqual([0, '60%'])
  expect(point.coord).toEqual([date, 9])
  expect(point.itemStyle.color).toBe(BULL)
  expect(point.label.formatter).toBe('买')
  expect(point.label.position).toBe('bottom')
  expect(point.label.color).toBe(BULL)
})

it('单卖是绿色下箭头，文字为卖，坐标在最高价上方', async () => {
  const date = DAYS[12]
  await renderChart('600000', [tradeMarker(date, [
    { date, side: 'sell', price: 8, quantity: 2, trader: '乙' },
  ])])

  const [point] = lastKMarkData()
  expect(lastKMarkData()).toHaveLength(1)
  expect(point.symbol).toBe('arrow')
  expect(point.symbolRotate).toBe(180)
  expect(point.symbolOffset).toEqual([0, '-60%'])
  expect(point.coord).toEqual([date, 11])
  expect(point.itemStyle.color).toBe(BEAR)
  expect(point.label.formatter).toBe('卖')
  expect(point.label.position).toBe('top')
  expect(point.label.color).toBe(BEAR)
})

it('同一天买卖只生成一个标记，SVG 里同时有两个方向和买卖字', async () => {
  const date = DAYS[15]
  await renderChart('600000', [tradeMarker(date, [
    { date, side: 'buy', price: 10.5, quantity: 3, trader: '甲' },
    { date, side: 'sell', price: 11.25, quantity: 4, trader: '乙' },
  ], '买/卖')])

  const points = lastKMarkData()
  expect(points).toHaveLength(1)
  expect(points[0].symbolSize).toEqual([96, 22])
  const svg = svgOf(points[0].symbol)
  expect(svg.match(/<path /g)).toHaveLength(2)
  expect(svg).toContain(BULL)
  expect(svg).toContain(BEAR)
  expect(svg).toContain('买')
  expect(svg).toContain('卖')
})

it('逐笔提示用 DOM 文本保留日期、方向、原精度价格、数量和交易员', async () => {
  const date = DAYS[8]
  await renderChart('600000', [tradeMarker(date, [
    { date, side: 'buy', price: 10.125, quantity: 100, trader: '甲' },
    { date, side: 'sell', price: 9.5, quantity: 7, trader: '乙' },
  ])])

  const tip = lastKMarkData()[0].tooltip.formatter() as HTMLElement
  expect(tip).toBeInstanceOf(HTMLElement)
  expect(tip.children[0].textContent).toBe('日期 方向 价格 数量 交易员')
  const rows = [...tip.children].slice(1)
  expect(rows).toHaveLength(2)
  expect([...rows[0].children].map(node => node.textContent)).toEqual([date, '买', '价 10.125', '量 100', '甲'])
  expect([...rows[1].children].map(node => node.textContent)).toEqual([date, '卖', '价 9.5', '量 7', '乙'])
  expect(rows[0].children[1].getAttribute('style')).toContain('rgb(199, 64, 64)')
  expect(rows[1].children[1].getAttribute('style')).toContain('rgb(45, 155, 101)')
})

it('恶意交易员字符串只进入文本，不生成可执行节点', async () => {
  const date = DAYS[9]
  const payload = '<img src=x onerror=alert(1)>'
  await renderChart('600000', [tradeMarker(date, [
    { date, side: 'buy', price: 3, quantity: 1, trader: payload },
  ])])

  const tip = lastKMarkData()[0].tooltip.formatter() as HTMLElement
  expect(tip.querySelector('img')).toBeNull()
  expect(tip.textContent).toContain(payload)
  expect(tip.innerHTML).toContain('&lt;img')
  expect(tip.innerHTML).not.toContain('<img')
})

it('当天 200 笔全部留在提示里', async () => {
  const date = DAYS[11]
  const trades = Array.from({ length: 200 }, (_, index) => ({
    date,
    side: 'buy' as const,
    price: index === 199 ? 9.875 : 1,
    quantity: index + 1,
    trader: `trader-${index}`,
  }))
  await renderChart('600000', [tradeMarker(date, trades)])

  const tip = lastKMarkData()[0].tooltip.formatter() as HTMLElement
  const rows = [...tip.children].slice(1)
  expect(rows).toHaveLength(200)
  expect(rows[0].textContent).toContain('trader-0')
  expect(rows[0].textContent).toContain('量 1')
  expect(rows[199].textContent).toContain('trader-199')
  expect(rows[199].textContent).toContain('价 9.875')
  expect(rows[199].textContent).toContain('量 200')
})

it('没有逐笔时买卖标记和根 tooltip 保持原来的轴触发', async () => {
  const date = DAYS[10]
  await renderChart('600000', [{ date, kind: 'buy', label: 'A-BUY' }])

  const [point] = lastKMarkData()
  expect(point.tooltip).toBeUndefined()
  expect(point.symbol).toBe('arrow')
  expect(point.symbolRotate).toBe(0)
  expect(point.coord).toEqual([date, 9])
  expect(point.itemStyle.color).toBe(BULL)
  expect(point.label.show).toBe(true)
  expect(point.label.formatter).toBe('A-BUY')
  expect(point.label.color).toBe('#A1A1AA')
  expect(lastOptionWithTooltip().tooltip.trigger).toBe('axis')
})

it('切标的后 dataZoom 重建仍使用当前逐笔，不回到上一只', async () => {
  const previousDate = DAYS[10]
  const currentDate = DAYS[20]
  await renderChart('600000', [tradeMarker(previousDate, [
    { date: previousDate, side: 'buy', price: 1, quantity: 1, trader: 'OLD' },
  ], 'OLD')])
  await renderChart('000001', [tradeMarker(currentDate, [
    { date: currentDate, side: 'buy', price: 2.5, quantity: 6, trader: 'NEW-BUY' },
    { date: currentDate, side: 'sell', price: 3.5, quantity: 8, trader: 'NEW-SELL' },
  ], 'NEW')])

  expect(lastOptionWithTooltip().tooltip.trigger).toBe('item')
  expect(svgOf(lastKMarkData()[0].symbol)).toContain('买')
  expect(lastKMarkData()[0].tooltip.formatter().textContent).toContain('NEW-BUY')

  await act(async () => { chart.handlers.dataZoom?.() })

  const point = lastKMarkData()[0]
  expect(lastKMarkData()).toHaveLength(1)
  expect(svgOf(point.symbol)).toContain('卖')
  const tip = point.tooltip.formatter() as HTMLElement
  expect(tip.textContent).toContain('NEW-BUY')
  expect(tip.textContent).toContain('NEW-SELL')
  expect(tip.textContent).toContain('价 2.5')
  expect(tip.textContent).not.toContain('OLD')
})

const WINDOW_DATES = Array.from({ length: 10 }, (_, index) => `2024-04-${String(index + 1).padStart(2, '0')}`)

function datedRows(dates: string[], base = 10): OHLC[] {
  return dates.map(date => ({ date, open: base, high: base + 1, low: base - 1, close: base, volume: 1 }))
}

function buy(date: string, trader: string): NonNullable<ChartMarker['trades']>[number] {
  return { date, side: 'buy', price: 1, quantity: 1, trader }
}

function outsideNotice(): HTMLElement | null {
  const found = [...host.querySelectorAll('div.text-muted')].find(element =>
    (element.textContent ?? '').includes('不在当前区间'))
  return found instanceof HTMLElement ? found : null
}

/** 记录每次提交到 DOM 的文字，用来抓住切股后、绘制前的旧计数。 */
function ZoomFrames({ frames, children }: { frames: string[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    frames.push(ref.current?.textContent ?? '')
  })
  return <div ref={ref}>{children}</div>
}

async function renderWindow(options: {
  symbol?: string
  dates?: string[]
  markers?: ChartMarker[]
  visibleBars?: number | 'all'
  frames?: string[]
}) {
  const dates = options.dates ?? WINDOW_DATES
  const chartNode = (
    <EChartsCandlestick
      data={datedRows(dates)}
      markers={options.markers}
      symbol={options.symbol ?? '600000'}
      height={400}
      showInfoBar={false}
      visibleBars={options.visibleBars ?? 4}
      activeIndicators={['vol']}
    />
  )
  await act(async () => root.render(
    options.frames ? <ZoomFrames frames={options.frames}>{chartNode}</ZoomFrames> : chartNode,
  ))
}

async function fireZoom(slice: Record<string, number | string>) {
  chart.zoomState.current = { ...slice }
  await act(async () => { chart.handlers.dataZoom?.() })
}

it('初始尾部窗口把更早的逐笔算进 N，窗口端点当天不算', async () => {
  const early = WINDOW_DATES[0]
  const justOutside = WINDOW_DATES[4]
  const boundary = WINDOW_DATES[5]
  await renderWindow({
    markers: [
      tradeMarker(early, [buy(early, '甲'), { date: early, side: 'sell', price: 2, quantity: 1, trader: '乙' }]),
      tradeMarker(justOutside, [buy(justOutside, '丙')]),
      tradeMarker(boundary, [buy(boundary, '丁')]),
      tradeMarker(WINDOW_DATES[9], [buy(WINDOW_DATES[9], '戊')]),
    ],
  })

  expect(outsideNotice()?.textContent).toBe('有 3 笔交易不在当前区间')
})

it('停牌缺日和区间外的日期按逐笔计入，可见 K 线当天不计', async () => {
  const dates = ['2024-05-06', '2024-05-08', '2024-05-09']
  const gap = '2024-05-07'
  const before = '2024-05-05'
  await renderWindow({
    dates,
    visibleBars: 'all',
    markers: [
      tradeMarker(before, [buy(before, '区间外')]),
      tradeMarker(gap, [
        buy(gap, '缺日买'),
        { date: gap, side: 'sell', price: 2, quantity: 1, trader: '缺日卖' },
      ]),
      tradeMarker(dates[1], [buy(dates[1], '可见')]),
    ],
  })

  expect(outsideNotice()?.textContent).toBe('有 3 笔交易不在当前区间')
})

it('同一天买卖按逐笔计数，不按标记个数', async () => {
  const date = WINDOW_DATES[0]
  await renderWindow({
    markers: [tradeMarker(date, [
      buy(date, '甲'),
      { date, side: 'sell', price: 2, quantity: 1, trader: '乙' },
    ], '买/卖')],
  })

  expect(lastKMarkData()).toHaveLength(1)
  expect(outsideNotice()?.textContent).toBe('有 2 笔交易不在当前区间')
})

it('缩放拖入拖出后笔数跟着变，端点和全部窗口都不误计', async () => {
  const early = WINDOW_DATES[0]
  const boundary = WINDOW_DATES[5]
  await renderWindow({
    markers: [
      tradeMarker(early, [buy(early, '甲'), { date: early, side: 'sell', price: 2, quantity: 1, trader: '乙' }]),
      tradeMarker(WINDOW_DATES[4], [buy(WINDOW_DATES[4], '丙')]),
      tradeMarker(boundary, [buy(boundary, '丁')]),
    ],
  })
  expect(outsideNotice()?.textContent).toBe('有 3 笔交易不在当前区间')

  await fireZoom({ start: 0, end: 100 })
  expect(outsideNotice()).toBeNull()

  await fireZoom({ start: 0, end: 40, startValue: 0, endValue: 4 })
  expect(outsideNotice()?.textContent).toBe('有 1 笔交易不在当前区间')

  await fireZoom({ start: 60, end: 100 })
  expect(outsideNotice()?.textContent).toBe('有 3 笔交易不在当前区间')
})

it('有起止值时按类别序号或日期定窗口，不按百分比', async () => {
  const early = WINDOW_DATES[0]
  await renderWindow({
    markers: [
      tradeMarker(early, [buy(early, '甲')]),
      tradeMarker(WINDOW_DATES[4], [buy(WINDOW_DATES[4], '丙')]),
    ],
  })
  expect(outsideNotice()?.textContent).toBe('有 2 笔交易不在当前区间')

  await fireZoom({ start: 60, end: 100, startValue: 0, endValue: WINDOW_DATES.length - 1 })
  expect(outsideNotice()).toBeNull()

  await fireZoom({ start: 0, end: 100, startValue: WINDOW_DATES[5], endValue: WINDOW_DATES[9] })
  expect(outsideNotice()?.textContent).toBe('有 2 笔交易不在当前区间')
})

it('换标的后每一帧都用当前数据，不闪上一只的笔数', async () => {
  const frames: string[] = []
  const early = WINDOW_DATES[0]
  await renderWindow({
    frames,
    symbol: '600000',
    visibleBars: 'all',
    markers: [tradeMarker(early, Array.from({ length: 5 }, (_, index) => buy(early, `A${index}`)))],
  })
  expect(outsideNotice()).toBeNull()

  const beforeSwitch = frames.length
  await renderWindow({
    frames,
    symbol: '000001',
    visibleBars: 4,
    markers: [tradeMarker(early, [buy(early, 'B')])],
  })

  expect(outsideNotice()?.textContent).toBe('有 1 笔交易不在当前区间')
  const switched = frames.slice(beforeSwitch)
  expect(switched.length).toBeGreaterThan(0)
  for (const text of switched) {
    expect(text).toContain('有 1 笔交易不在当前区间')
    expect(text).not.toContain('有 5 笔交易不在当前区间')
  }
})

it('没有逐笔、标记未就绪或换掉标记时不显示区间提示', async () => {
  const early = WINDOW_DATES[0]
  await renderWindow({
    markers: [{ date: early, kind: 'buy', label: '旧标记' }],
  })
  expect(outsideNotice()).toBeNull()
  expect(lastKMarkData()[0].symbol).toBe('arrow')
  expect(lastOptionWithTooltip().tooltip.trigger).toBe('axis')
  expect(lastOptionWithTooltip().tooltip.axisPointer.type).toBe('cross')

  await renderWindow({
    markers: [tradeMarker(early, [buy(early, '甲'), buy(early, '乙'), buy(early, '丙')])],
  })
  expect(outsideNotice()?.textContent).toBe('有 3 笔交易不在当前区间')
  expect(lastOptionWithTooltip().tooltip.trigger).toBe('item')
  expect(lastOptionWithTooltip().tooltip.axisPointer.type).toBe('cross')

  await renderWindow({ markers: undefined })
  expect(outsideNotice()).toBeNull()
  expect(host.textContent).not.toContain('有 0 笔')

  await renderWindow({
    markers: [{ date: early, kind: 'sell', label: '仍无逐笔' }],
  })
  expect(outsideNotice()).toBeNull()
  expect(host.textContent).not.toContain('有 3 笔交易不在当前区间')
})

it('同步可见窗口不会反复重建图表', async () => {
  const early = WINDOW_DATES[0]
  await renderWindow({
    markers: [tradeMarker(early, [buy(early, '甲')])],
  })
  const afterMount = chart.setOption.mock.calls.length
  await act(async () => {})
  expect(chart.setOption.mock.calls.length).toBe(afterMount)

  await fireZoom({ start: 0, end: 100 })
  expect(chart.setOption.mock.calls.length).toBe(afterMount)
  await act(async () => { chart.handlers.dataZoom?.() })
  expect(chart.setOption.mock.calls.length).toBe(afterMount)
  expect(outsideNotice()).toBeNull()
})

it('页面缩放时成交标记悬停按容器比例归一化，切到无逐笔后不再改写同一事件', async () => {
  type ZoomMouseEvent = MouseEvent & { zrX?: number; zrY?: number }

  await renderChart('600000', [tradeMarker(DAYS[10], [{
    date: DAYS[10], side: 'buy', price: 10, quantity: 100, trader: '甲',
  }])])

  // showInfoBar=false 时，host 的第一层子节点的第一层子节点就是图表容器
  const container = host.firstElementChild!.firstElementChild!
  const canvas = container.appendChild(document.createElement('canvas'))
  Object.defineProperties(canvas, {
    clientWidth: { value: 600 },
    clientHeight: { value: 400 },
  })
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 200,
    width: 540,
    height: 360,
    right: 640,
    bottom: 560,
    x: 100,
    y: 200,
    toJSON() {},
  } as DOMRect)

  const native = new MouseEvent('mousemove', {
    bubbles: true,
    clientX: 370,
    clientY: 380,
  }) as ZoomMouseEvent
  Object.defineProperty(native, 'offsetX', { value: 270 })
  Object.defineProperty(native, 'offsetY', { value: 180 })

  const listener = vi.fn((event: ZoomMouseEvent) => [event.zrX, event.zrY])
  canvas.addEventListener('mousemove', listener)
  canvas.dispatchEvent(native)

  expect(listener.mock.calls[0]?.[0]).toBe(native)
  expect(listener.mock.results[0]?.value).toEqual([300, 200])
  expect([native.offsetX, native.offsetY]).toEqual([270, 180])

  await renderChart('600000', [tradeMarker(DAYS[10], [])])
  delete native.zrX
  delete native.zrY
  canvas.dispatchEvent(native)

  expect(listener.mock.calls.at(-1)?.[0]).toBe(native)
  expect(listener.mock.results.at(-1)?.value).toEqual([undefined, undefined])
})
