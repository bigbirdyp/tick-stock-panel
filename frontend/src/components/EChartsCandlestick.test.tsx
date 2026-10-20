// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EChartsCandlestick, type ChartMarker, type OHLC } from './EChartsCandlestick'

const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  setOption: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispatchAction: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  getZr: () => ({ on: vi.fn(), off: vi.fn() }),
  getOption: () => ({ dataZoom: [{ start: 0, end: 100 }] }),
  containPixel: () => false,
  convertFromPixel: () => [0, 0],
}))

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
  chart.setOption.mockClear()
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
