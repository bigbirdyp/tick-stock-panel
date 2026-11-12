// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { PositionTable, ReviewListView } from './lists'
import { indexStockNames } from './reviewStocks'
import type { DailyReview, Position } from './types'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const names = indexStockNames([{ code: '600519', symbol: '600519.SH', name: '贵州茅台' }])
const recognized = '今天买入贵州茅台，关注600519，000001\n600519.SH 备注'
const ignored = '16005190 abc600519x 600519.25 ￥600519 000001.SH 未知公司'

const review: DailyReview = {
  id: 'rev-maotai',
  version: 2,
  trader: '杨鹏',
  date: '2026-10-19',
  content: recognized,
  tags: [],
  created_at: '2026-10-19T10:00:00+08:00',
  updated_at: '2026-10-19T10:00:00+08:00',
}

const position: Position = {
  position_key: 'pos-raw',
  trader: '杨鹏',
  code: '600519',
  symbol: '600519',
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

function previewButtons(root: ParentNode | null | undefined = container) {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(button => button.getAttribute('aria-label')?.startsWith('查看 '))
}

function prosePieces(paragraph: Element | null | undefined) {
  return Array.from(paragraph?.children ?? [])
    .filter(el => el instanceof HTMLElement && el.querySelector('button') == null)
    .map(el => el.textContent ?? '')
}

it('复盘已识别股票按共享代码名称展示，点代码和名称都打开原股票，原文与编辑删除仍在', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  const edited: string[] = []
  const editedContent: string[] = []
  const deleted: string[] = []
  render(<ReviewListView
    rows={[review, { ...review, id: 'rev-noise', content: ignored }]}
    stockNames={names}
    onPreview={(symbol, name) => opened.push({ symbol, name })}
    onEdit={item => { edited.push(item.id); editedContent.push(item.content) }}
    onDelete={item => deleted.push(item.id)}
  />)

  const articles = container?.querySelectorAll('article') ?? []
  const paragraph = articles[0]?.querySelector('p')
  expect(paragraph?.className.split(/\s+/) ?? []).not.toContain('group')
  expect(articles[0]?.className.split(/\s+/) ?? []).not.toContain('group')
  expect(prosePieces(paragraph)).toEqual(['今天买入', '，关注', '，', '\n', ' 备注'])
  expect(paragraph?.textContent).toBe('今天买入600519.SH贵州茅台，关注600519.SH贵州茅台，000001.SZ\n600519.SH贵州茅台 备注')
  expect(paragraph?.textContent).not.toBe(recognized)
  expect(articles[1]?.querySelector('p')?.textContent).toBe(ignored)
  expect(previewButtons(articles[1])).toHaveLength(0)

  const buttons = previewButtons(articles[0])
  expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
    '查看 贵州茅台 详情',
    '查看 600519.SH 详情',
    '查看 000001.SZ 详情',
    '查看 600519.SH 详情',
  ])
  expect(buttons.map(button => Array.from(button.children).map(el => el.textContent))).toEqual([
    ['600519.SH', '贵州茅台'],
    ['600519.SH', '贵州茅台'],
    ['000001.SZ'],
    ['600519.SH', '贵州茅台'],
  ])
  const groups = buttons.map(button => button.parentElement)
  expect(new Set(groups).size).toBe(buttons.length)
  for (const button of buttons) {
    expect(button.type).toBe('button')
    expect(button.className).toBe(SHELL)
    expect(button.parentElement?.tagName).toBe('SPAN')
    expect(button.parentElement?.className).toBe('group inline-flex max-w-full min-w-0 align-baseline')
    const [code, name] = Array.from(button.children)
    expect(code?.className).toBe(CODE)
    if (name) expect(name.className).toBe(NAME)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    act(() => { button.dispatchEvent(enter); button.dispatchEvent(space) })
    expect(enter.defaultPrevented).toBe(false)
    expect(space.defaultPrevented).toBe(false)
    act(() => { if (code instanceof HTMLElement) code.click() })
    if (name instanceof HTMLElement) act(() => name.click())
  }
  expect(opened).toEqual([
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '000001.SZ', name: '' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
  ])

  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="编辑 杨鹏 2026-10-19 复盘"]')?.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="删除 杨鹏 2026-10-19 复盘"]')?.click())
  expect(edited).toEqual(['rev-maotai'])
  expect(editedContent).toEqual([recognized])
  expect(deleted).toEqual(['rev-maotai'])
})

it('没有预览回调时复盘仍是原文，不出现股票按钮', () => {
  render(<ReviewListView rows={[review]} stockNames={names} onEdit={() => {}} onDelete={() => {}} />)
  const paragraph = container?.querySelector('p')
  expect(paragraph?.textContent).toBe(recognized)
  expect(paragraph?.querySelector('button')).toBeNull()
  expect(previewButtons()).toHaveLength(0)
})

it('原始六位和空 symbol 显示规范后缀，错误后缀不可点', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  render(<PositionTable rows={[
    position,
    { ...position, position_key: 'pos-empty', code: '000001', symbol: '', name: '平安银行' },
    { ...position, position_key: 'pos-wrong', code: '600519', symbol: '600519.SZ', name: '错误后缀' },
  ]} onPreview={(symbol, name) => opened.push({ symbol, name })} />)

  function stockShell(symbol: string, name: string) {
    const shell = Array.from(container?.querySelectorAll('button, span') ?? []).find(el => {
      const [code, label] = Array.from(el.children)
      return code?.textContent === symbol && label?.textContent === name
    })
    return shell instanceof HTMLElement ? shell : null
  }

  const maotai = stockShell('600519.SH', '贵州茅台')
  const pingan = stockShell('000001.SZ', '平安银行')
  const wrong = stockShell('600519.SZ', '错误后缀')
  expect(maotai?.tagName).toBe('BUTTON')
  expect(pingan?.tagName).toBe('BUTTON')
  expect([maotai, pingan].map(shell => ({
    label: shell?.getAttribute('aria-label'),
    code: shell?.children[0]?.textContent,
    name: shell?.children[1]?.textContent,
  }))).toEqual([
    { label: '查看 贵州茅台 详情', code: '600519.SH', name: '贵州茅台' },
    { label: '查看 平安银行 详情', code: '000001.SZ', name: '平安银行' },
  ])
  expect(container?.querySelector('[aria-label="查看 600519.SH 详情"]')).toBeNull()
  expect(container?.querySelector('[aria-label="查看 000001.SZ 详情"]')).toBeNull()
  expect(wrong?.tagName).toBe('SPAN')
  expect(wrong?.closest('tr')?.querySelector('button')).toBeNull()
  expect(container?.textContent).toContain('错误后缀')
  expect(container?.textContent).toContain('600519.SZ')
  expect(container?.querySelector('[aria-label="查看 错误后缀 详情"]')).toBeNull()
  expect(container?.querySelector('[aria-label="查看 600519.SZ 详情"]')).toBeNull()

  for (const shell of [maotai, pingan]) {
    const [code, name] = Array.from(shell?.children ?? [])
    act(() => { if (name instanceof HTMLElement) name.click() })
    act(() => { if (code instanceof HTMLElement) code.click() })
  }
  expect(opened).toEqual([
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '000001.SZ', name: '平安银行' },
    { symbol: '000001.SZ', name: '平安银行' },
  ])
})
