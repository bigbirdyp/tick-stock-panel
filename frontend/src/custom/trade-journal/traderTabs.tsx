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

/**
 * 交易记录、持仓和历史收益共用的交易者切换。
 * 第一项固定为「全部」，其余按服务端给出的顺序展示标签和条数。
 * 与栏目 tab 分开，避免左右键把两个列表混在一起。
 */
export function TraderTabs({ traders, selected, loading, error, onSelect, onRetry }: TraderTabsProps) {
  const items = [
    { key: '', label: '全部', count: null as number | null },
    ...traders.map(item => ({ key: item.trader, label: item.trader, count: item.record_count })),
  ]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selectedIndex = Math.max(0, items.findIndex(item => (item.key === '' ? selected == null : item.key === selected)))
    const next = event.key === 'ArrowRight' ? (selectedIndex + 1) % items.length
      : event.key === 'ArrowLeft' ? (selectedIndex - 1 + items.length) % items.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : -1
    if (next < 0) return
    event.preventDefault()
    const item = items[next]
    onSelect(item.key === '' ? undefined : item.key)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      <div role="tablist" aria-label="交易者" onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
        {items.map(item => {
          const active = item.key === '' ? selected == null : item.key === selected
          return (
            <button
              key={item.key === '' ? 'all' : item.key}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(item.key === '' ? undefined : item.key)}
              className={`rounded px-3 py-1.5 text-xs font-medium ${active ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-elevated'}`}
            >
              {item.label}
              {item.count != null && <span className="ml-1 tabular-nums text-muted"> {item.count}</span>}
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
