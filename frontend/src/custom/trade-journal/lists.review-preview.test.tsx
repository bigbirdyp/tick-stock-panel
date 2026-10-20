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

function previewButtons() {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(button => button.getAttribute('aria-label')?.startsWith('查看 '))
}

it('复盘已知名称和代码点击回规范 symbol，原文与编辑删除仍在', () => {
  const opened: Array<{ symbol: string; name: string }> = []
  const edited: string[] = []
  const deleted: string[] = []
  render(<ReviewListView
    rows={[review, { ...review, id: 'rev-noise', content: ignored }]}
    stockNames={names}
    onPreview={(symbol, name) => opened.push({ symbol, name })}
    onEdit={item => edited.push(item.id)}
    onDelete={item => deleted.push(item.id)}
  />)

  const articles = container?.querySelectorAll('article') ?? []
  expect(articles[0]?.querySelector('p')?.textContent).toBe(recognized)
  expect(articles[1]?.querySelector('p')?.textContent).toBe(ignored)
  expect(articles[1]?.querySelector('button[aria-label^="查看 "]')).toBeNull()

  const buttons = previewButtons()
  expect(buttons.map(button => button.textContent)).toEqual(['贵州茅台', '600519', '000001', '600519.SH'])
  for (const button of buttons) act(() => button.click())
  expect(opened).toEqual([
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '000001.SZ', name: '' },
    { symbol: '600519.SH', name: '贵州茅台' },
  ])

  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="编辑 杨鹏 2026-10-19 复盘"]')?.click())
  act(() => container?.querySelector<HTMLButtonElement>('[aria-label="删除 杨鹏 2026-10-19 复盘"]')?.click())
  expect(edited).toEqual(['rev-maotai'])
  expect(deleted).toEqual(['rev-maotai'])
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
