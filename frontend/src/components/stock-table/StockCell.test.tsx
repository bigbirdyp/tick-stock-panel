// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StockCell } from './StockCell'

const SHELL = 'flex items-center gap-1 text-left min-w-0'
const CODE = 'font-mono text-foreground text-xs group-hover:text-accent transition-colors duration-150'
const NAME = 'text-xs text-secondary truncate group-hover:text-foreground transition-colors duration-150'

let root: Root | null = null
const container = document.createElement('div')
document.body.appendChild(container)

afterEach(() => {
  if (root) {
    act(() => { root!.unmount() })
    root = null
  }
  container.innerHTML = ''
})

function render(node: ReactElement) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  if (!root) root = createRoot(container)
  act(() => { root!.render(node) })
}

function shell(): HTMLElement {
  const el = container.firstElementChild
  if (!(el instanceof HTMLElement)) throw new Error('StockCell 没有渲染根节点')
  return el
}

it('renders code before name on a native button', () => {
  render(<StockCell code="600519.SH" name="贵州茅台" onClick={() => {}} />)

  const button = shell()
  expect(button.tagName).toBe('BUTTON')
  expect(button.getAttribute('type')).toBe('button')
  expect(button.className).toBe(SHELL)
  expect(button.hasAttribute('aria-label')).toBe(false)

  const [code, name] = Array.from(button.children)
  expect(code?.tagName).toBe('SPAN')
  expect(code?.className).toBe(CODE)
  expect(code?.textContent).toBe('600519.SH')
  expect(name?.tagName).toBe('SPAN')
  expect(name?.className).toBe(NAME)
  expect(name?.textContent).toBe('贵州茅台')
  expect(button.children).toHaveLength(2)
})

it('omits the name node when name is empty', () => {
  for (const name of ['', null, undefined] as const) {
    render(<StockCell code="000001.SZ" name={name} onClick={() => {}} />)
    const button = shell()
    expect(Array.from(button.children).map(el => el.textContent)).toEqual(['000001.SZ'])
    expect(button.textContent).toBe('000001.SZ')
  }
})

it('places children after code and name', () => {
  render(
    <StockCell code="300001.SZ" name="特锐德" onClick={() => {}}>
      <i data-testid="board">创</i>
      <i data-testid="dot">点</i>
    </StockCell>,
  )

  expect(Array.from(shell().children).map(el => el.getAttribute('data-testid') ?? el.textContent)).toEqual([
    '300001.SZ',
    '特锐德',
    'board',
    'dot',
  ])
})

it('calls the open callback from a click and leaves Enter and Space to the button', () => {
  const onClick = vi.fn()
  render(<StockCell code="600519.SH" name="贵州茅台" aria-label="查看 贵州茅台 详情" onClick={onClick} />)

  const button = shell()
  expect(button.getAttribute('aria-label')).toBe('查看 贵州茅台 详情')

  act(() => { button.click() })
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(onClick.mock.calls[0]).toEqual([])

  for (const key of ['Enter', ' ']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => { button.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  }
  expect(onClick).toHaveBeenCalledTimes(1)
})

it('renders the same classes as a non-interactive span when it cannot open', () => {
  render(
    <StockCell code="000001.SZ" name="平安银行">
      <i data-testid="board">深</i>
    </StockCell>,
  )

  const el = shell()
  expect(el.tagName).toBe('SPAN')
  expect(el.className).toBe(SHELL)
  expect(el.getAttribute('role')).toBeNull()
  expect(el.hasAttribute('tabindex')).toBe(false)
  expect(container.querySelector('button')).toBeNull()
  expect(Array.from(el.children).map(child => child.getAttribute('data-testid') ?? child.textContent)).toEqual([
    '000001.SZ',
    '平安银行',
    'board',
  ])
  expect(el.querySelector('span')?.className).toBe(CODE)
  expect(el.querySelectorAll('span')[1]?.className).toBe(NAME)
})
