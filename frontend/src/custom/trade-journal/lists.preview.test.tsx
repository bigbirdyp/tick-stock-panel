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

const SHELL = 'flex items-center gap-1 text-left min-w-0'
const CODE = 'font-mono text-foreground text-xs group-hover:text-accent transition-colors duration-150'
const NAME = 'text-xs text-secondary truncate group-hover:text-foreground transition-colors duration-150'

function stockCells(name: string, symbol: string) {
  return Array.from(container?.querySelectorAll('button, span') ?? []).flatMap(el => {
    const [code, label] = Array.from(el.children)
    if (code?.textContent !== symbol || label?.textContent !== name) return []
    if (!(el instanceof HTMLElement) || !(code instanceof HTMLElement) || !(label instanceof HTMLElement)) return []
    return [{ shell: el, code, name: label }]
  })
}

function stockCell(name: string, symbol: string) {
  return stockCells(name, symbol)[0] ?? null
}

function expectSharedStock(name: string, symbol: string, clickable: boolean) {
  const cell = stockCell(name, symbol)
  expect(cell, `${symbol} ${name}`).not.toBeNull()
  expect(cell!.shell.tagName).toBe(clickable ? 'BUTTON' : 'SPAN')
  if (clickable) expect((cell!.shell as HTMLButtonElement).type).toBe('button')
  expect(cell!.shell.className).toBe(SHELL)
  expect(cell!.code?.className).toBe(CODE)
  expect(cell!.name?.className).toBe(NAME)
  expect(Array.from(cell!.shell.children).map(el => el.textContent)).toEqual([symbol, name])

  const row = cell!.shell.closest('tr')
  expect(row?.className).toContain('group')
  expect(row?.className).toContain('hover:bg-elevated/50')
  const column = cell!.shell.closest('td')
  expect(column?.className).toContain('px-1.5')
  expect(column?.className).toContain('py-1.5')
  expect(column?.className).toContain('border-b')
  expect(column?.className).toContain('border-border/50')
  expect(column?.className).not.toContain('px-4')
  expect(column?.className).not.toMatch(/\b(?:w-|max-w-)/)
  expect(cell!.shell.parentElement?.className).toBe('flex items-center gap-1 w-full')
  return cell!
}

it('持仓名称和代码都打开规范化 symbol，无法识别的代码不可点', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  const bare: Position = { ...position, position_key: 'pos-bare', symbol: '600519' }
  const mismatch: Position = { ...position, position_key: 'pos-mismatch', symbol: '600519.SZ', name: '错误后缀' }
  render(<PositionTable rows={[position, bare, bShare, mismatch]} onPreview={(symbol, name) => opened.push({ symbol, name })} />)

  const maotaiCells = stockCells('贵州茅台', '600519.SH')
  expect(maotaiCells).toHaveLength(2)
  const maotai = expectSharedStock('贵州茅台', '600519.SH', true)
  expect(maotaiCells.every(cell => cell.shell.tagName === 'BUTTON' && cell.shell.getAttribute('aria-label') === '查看 贵州茅台 详情')).toBe(true)
  expect(Array.from(container?.querySelectorAll('span') ?? []).filter(el => el.textContent === '600519')).toHaveLength(0)

  const plain = expectSharedStock('B股样本', '900901.SH', false)
  expect(plain.shell.getAttribute('aria-label')).toBeNull()
  expect(plain.shell.closest('tr')?.querySelector('button')).toBeNull()
  const wrong = expectSharedStock('错误后缀', '600519.SZ', false)
  expect(wrong.shell.closest('tr')?.querySelector('button')).toBeNull()
  expect(container?.textContent).toContain('错误后缀')
  expect(container?.textContent).toContain('600519.SZ')

  act(() => maotai.name!.click())
  act(() => maotai.code!.click())
  act(() => maotaiCells[1]?.code.click())
  maotai.shell.focus()
  // jsdom 不实现按钮的 Enter/Space 激活。未阻止默认行为时补一次 click，等同浏览器原生按钮。
  for (const key of ['Enter', ' ']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => { maotai.shell.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  }
  act(() => { maotai.shell.click() })

  expect(opened).toEqual([
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
  ])
  expect(document.activeElement).toBe(maotai.shell)
})

it('历史收益名称和代码打开同一标的', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  render(<HistoryTable rows={[history]} onPreview={(symbol, name) => opened.push({ symbol, name })} />)
  const cell = expectSharedStock('平安银行', '000001.SZ', true)
  act(() => cell.name!.click())
  act(() => cell.code!.click())
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
  const cell = expectSharedStock('贵州茅台', '600519.SH', true)
  act(() => cell.name!.click())
  act(() => cell.code!.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="编辑 贵州茅台 2026-10-12 交易记录"]')?.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="删除 贵州茅台 2026-10-12 交易记录"]')?.click())
  expect(opened).toEqual(['600519.SH:贵州茅台', '600519.SH:贵州茅台'])
  expect(edited).toEqual(['rec-maotai'])
  expect(deleted).toEqual(['rec-maotai'])
})

it('不传预览回调时表格仍只接收原有参数', () => {
  render(<PositionTable rows={[position]} />)
  const cell = expectSharedStock('贵州茅台', '600519.SH', false)
  expect(cell.shell.getAttribute('role')).toBeNull()
  expect(container?.querySelector('button')).toBeNull()
  expect(container?.textContent).toContain('贵州茅台')
  expect(container?.textContent).toContain('600519.SH')
})
