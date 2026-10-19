// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { HistoryTable, PositionTable, RecordTable } from './lists'
import type { HistoryRow, Position, TradeRecord } from './types'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const position: Position = {
  position_key: 'pos-maotai',
  trader: 'AI选股:atr_pct',
  code: '600519',
  symbol: '600519.SH',
  name: '贵州茅台',
  open_date: '2026-10-12',
  quantity: 100,
  cost: 1688.5,
  cost_amount: 168855,
  current_price: 1712.3,
  price_source: 'quote',
  price_as_of: '2026-10-12',
  price_status: 'fresh',
  market_value: 171230,
  unrealized_pnl: 2375,
  return_rate: 0.014,
}

const bShare: Position = {
  ...position,
  position_key: 'pos-bshare',
  code: '900901',
  symbol: '900901.SH',
  name: 'B股样本',
}

const history: HistoryRow = {
  history_id: 'hist-pingan',
  sell_record_id: 'sell-1',
  buy_record_ids: ['buy-1'],
  trader: '杨鹏',
  code: '000001',
  symbol: '000001.SZ',
  name: '平安银行',
  open_date: '2026-09-28',
  close_date: '2026-10-12',
  quantity: 1000,
  cost: 10.8,
  exit_price: 11.26,
  cost_amount: 10805,
  exit_amount: 11255,
  realized_pnl: 450,
  return_rate: 0.0416,
  holding_days: 14,
}

const record: TradeRecord = {
  id: 'rec-maotai',
  version: 1,
  trader: 'AI选股:atr_pct',
  trade_date: '2026-10-12',
  trade_time: '10:35:12',
  code: '600519',
  symbol: '600519.SH',
  name: '贵州茅台',
  side: 'buy',
  price: 1688.5,
  quantity: 100,
  fee: 5,
  tax: 0,
  note: null,
  client_request_id: null,
  created_at: '2026-10-12T10:35:30+08:00',
  updated_at: '2026-10-12T10:35:30+08:00',
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

function stockButtons(name: string, symbol: string) {
  return {
    name: container?.querySelector<HTMLButtonElement>(`[aria-label="查看 ${name} 详情"]`) ?? null,
    code: container?.querySelector<HTMLButtonElement>(`[aria-label="查看 ${symbol} 详情"]`) ?? null,
  }
}

function expectClickable(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull()
  expect(button?.tagName).toBe('BUTTON')
  expect(button?.type).toBe('button')
  expect(button?.className).toContain('cursor-pointer')
  expect(button?.className).toContain('hover:underline')
  expect(button?.className).toContain('focus-visible:outline')
}

it('持仓名称和代码都打开规范化 symbol，无法识别的代码不可点', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  render(<PositionTable rows={[position, bShare]} onPreview={(symbol, name) => opened.push({ symbol, name })} />)

  const maotai = stockButtons('贵州茅台', '600519.SH')
  expectClickable(maotai.name)
  expectClickable(maotai.code)
  expect(container?.querySelector('[aria-label="查看 B股样本 详情"]')).toBeNull()
  expect(container?.querySelector('[aria-label="查看 900901.SH 详情"]')).toBeNull()

  act(() => maotai.name!.click())
  act(() => maotai.code!.click())
  maotai.code!.focus()
  // jsdom 不实现按钮的 Enter 激活。未阻止默认行为时补一次 click，等同浏览器原生按钮。
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  act(() => { maotai.code!.dispatchEvent(enter) })
  expect(enter.defaultPrevented).toBe(false)
  act(() => { maotai.code!.click() })

  expect(opened).toEqual([
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
  ])
  expect(document.activeElement).toBe(maotai.code)
})

it('历史收益名称和代码打开同一标的', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  render(<HistoryTable rows={[history]} onPreview={(symbol, name) => opened.push({ symbol, name })} />)
  const buttons = stockButtons('平安银行', '000001.SZ')
  expectClickable(buttons.name)
  expectClickable(buttons.code)
  act(() => buttons.name!.click())
  act(() => buttons.code!.click())
  expect(opened).toEqual([
    { symbol: '000001.SZ', name: '平安银行' },
    { symbol: '000001.SZ', name: '平安银行' },
  ])
})

it('交易记录名称和代码打开同一标的，编辑删除契约仍在', () => {
  const opened: string[] = []
  const edited: string[] = []
  const deleted: string[] = []
  render(<RecordTable
    rows={[record]}
    onPreview={(symbol, name) => opened.push(`${symbol}:${name}`)}
    onEdit={item => edited.push(item.id)}
    onDelete={item => deleted.push(item.id)}
  />)
  const buttons = stockButtons('贵州茅台', '600519.SH')
  expectClickable(buttons.name)
  expectClickable(buttons.code)
  act(() => buttons.name!.click())
  act(() => buttons.code!.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="编辑 贵州茅台 2026-10-12 交易记录"]')?.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="删除 贵州茅台 2026-10-12 交易记录"]')?.click())
  expect(opened).toEqual(['600519.SH:贵州茅台', '600519.SH:贵州茅台'])
  expect(edited).toEqual(['rec-maotai'])
  expect(deleted).toEqual(['rec-maotai'])
})

it('不传预览回调时表格仍只接收原有参数', () => {
  render(<PositionTable rows={[position]} />)
  expect(container?.querySelector('button')).toBeNull()
  expect(container?.textContent).toContain('贵州茅台')
  expect(container?.textContent).toContain('600519.SH')
})
