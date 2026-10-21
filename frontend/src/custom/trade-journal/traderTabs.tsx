import type { KeyboardEvent } from 'react'
import type { TraderSummary } from './types'

interface TraderTabsProps {
  traders: TraderSummary[]
  selected: string | undefined
  loading: boolean
  error: unknown
  onSelect: (trader: string | undefined) => void
  onRetry: () => void
}

/** 记录数从多到少；相同则按标签的 UTF-16 code unit 升序。页签和选中解析共用这次序。 */
function compareTraders(left: TraderSummary, right: TraderSummary): number {
  if (left.record_count !== right.record_count) return right.record_count - left.record_count
  if (left.trader < right.trader) return -1
  if (left.trader > right.trader) return 1
  return 0
}

function sortedTraders(traders: readonly TraderSummary[]): TraderSummary[] {
  return [...traders].sort(compareTraders)
}

/**
 * 在排序后的真实交易者里决定选中谁。候选只含名册中的交易者。
 * urlTrader 为 null 表示地址栏没有该参数；空字符串表示参数在场但为空。
 * 参数在场时只认名单里的名字：未知、已删除或空白落到第一人，不读已保存值。
 * 参数缺席时才用已保存的合法名字，否则也是第一人。没有交易者就没有选中值。
 */
export function resolveTraderSelection(
  traders: readonly TraderSummary[],
  urlTrader: string | null,
  savedTrader: string | null,
): string | undefined {
  const sorted = sortedTraders(traders)
  const first = sorted[0]?.trader
  if (first === undefined) return undefined
  const names = new Set(sorted.map(item => item.trader))
  if (urlTrader !== null) {
    const name = urlTrader.trim()
    if (name !== '' && names.has(name)) return name
    return first
  }
  const saved = (savedTrader ?? '').trim()
  if (saved !== '' && names.has(saved)) return saved
  return first
}

/**
 * 外层交易者页签按记录数从多到少；记录数相同则按标签的 UTF-16 code unit 升序。
 * GET /api/traders 本身不按记录数排序，这个次序只在客户端决定。
 */
export function TraderTabs({ traders, selected, loading, error, onSelect, onRetry }: TraderTabsProps) {
  const sorted = sortedTraders(traders)
  const items = sorted.map(item => ({ key: item.trader, label: item.trader, count: item.record_count }))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    const selectedIndex = Math.max(0, items.findIndex(item => item.key === selected))
    const next = event.key === 'ArrowRight' ? (selectedIndex + 1) % items.length
      : event.key === 'ArrowLeft' ? (selectedIndex - 1 + items.length) % items.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : -1
    if (next < 0) return
    event.preventDefault()
    const item = items[next]
    onSelect(item.key)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="space-y-2">
      <div role="tablist" aria-label="交易者" onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
        {items.map(item => {
          const active = item.key === selected
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(item.key)}
              className={`rounded px-3 py-1.5 text-xs font-medium ${active ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-elevated'}`}
            >
              {item.label}
              <span className="ml-1 tabular-nums text-muted"> {item.count}</span>
            </button>
          )
        })}
      </div>
      {loading && <p role="status" className="text-xs text-muted">正在加载交易者…</p>}
      {error != null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
          <span>交易者列表读取失败：{error instanceof Error ? error.message : '未知错误'}</span>
          <button type="button" className="rounded-btn border border-danger/40 px-2 py-1" onClick={onRetry}>重试</button>
        </div>
      )}
    </div>
  )
}
