import type { ReactNode } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { fmtPct, priceColorClass } from '@/lib/format'
import { isTradeJournalError } from './errors'
import { resolveSymbol } from './symbol'
import type { DailyReview, HistoryRow, Pagination, Position, TradeRecord } from './types'
import { LEGACY_TRADER_LABEL } from './types'

/** 响应里缺标签时按迁移口径显示，避免旧行空白。有字面量时原样展示，包括「未指定」。 */
export function traderLabel(trader: string | null | undefined): string {
  const text = trader?.trim() ?? ''
  return text === '' ? LEGACY_TRADER_LABEL : text
}

const money = (value: number | null, digits = 2) => value == null
  ? '—'
  : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function ResultState({ loading, error, empty, onRetry }: { loading: boolean; error: unknown; empty: boolean; onRetry: () => void }) {
  if (loading) return <div role="status" className="p-8 text-center text-sm text-muted">正在加载…</div>
  if (error) return (
    <div role="alert" className="m-4 rounded-md border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
      <p>读取失败：{error instanceof Error ? error.message : '未知错误'}</p>
      {isTradeJournalError(error) && error.fields.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {error.fields.map(field => <li key={`${field.path}:${field.message}`}>{field.path}: {field.message}</li>)}
        </ul>
      )}
      <button type="button" className="mt-2 rounded-btn border border-danger/40 px-3 py-1 text-xs" onClick={onRetry}>重试</button>
    </div>
  )
  if (empty) return <div className="p-8 text-center text-sm text-muted">暂无记录</div>
  return null
}

export function Pager({ pagination, onPage }: { pagination: Pagination | undefined; onPage: (offset: number) => void }) {
  if (!pagination) return null
  const { offset, limit, total, has_more } = pagination
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted">
      <span>共 {total} 条 · {total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, total)}</span>
      <div className="flex gap-2">
        <button type="button" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))} className="rounded-btn border border-border px-3 py-1 disabled:opacity-40">上一页</button>
        <button type="button" disabled={!has_more} onClick={() => onPage(offset + limit)} className="rounded-btn border border-border px-3 py-1 disabled:opacity-40">下一页</button>
      </div>
    </div>
  )
}

function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] border-collapse text-left text-xs">{children}</table></div>
}

const th = 'whitespace-nowrap border-b border-border bg-elevated/40 px-4 py-2 font-medium text-muted'
const td = 'whitespace-nowrap border-b border-border/50 px-4 py-3 text-secondary'
const stockButtonClass = 'cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

type StockRow = { code: string; symbol: string; name: string }

// 只接受 resolveSymbol(code) 的结果。已有 symbol 必须与它一致，或本身就是同一六位代码。
// 对不上、或代码无法识别交易所时返回 null，调用方保持纯文本，不猜后缀。
function openableSymbol(row: StockRow): string | null {
  const code = row.code.trim()
  const resolved = resolveSymbol(code)
  if (resolved == null) return null
  const existing = row.symbol.trim()
  if (existing === '' || existing === resolved || resolveSymbol(existing) === resolved) return resolved
  return null
}

function StockIdentity({ row, onPreview }: { row: StockRow; onPreview?: (symbol: string, name: string) => void }) {
  const symbol = openableSymbol(row)
  if (symbol == null || onPreview == null) {
    return <><span className="font-medium text-foreground">{row.name}</span><span className="ml-2 font-mono text-muted">{row.symbol}</span></>
  }
  const open = () => onPreview(symbol, row.name)
  return <>
    <button type="button" className={`font-medium text-foreground ${stockButtonClass}`} aria-label={`查看 ${row.name} 详情`} onClick={open}>{row.name}</button>
    <button type="button" className={`ml-2 font-mono text-muted ${stockButtonClass}`} aria-label={`查看 ${row.symbol || symbol} 详情`} onClick={open}>{row.symbol || symbol}</button>
  </>
}

export function PositionTable({ rows, onPreview }: { rows: Position[]; onPreview?: (symbol: string, name: string) => void }) {
  return (
    <TableWrap>
      <thead><tr>
        {['交易者', '股票', '开仓日', '数量', '成本价', '成本金额', '最近价', '市值', '浮动盈亏', '收益率'].map(label => <th key={label} className={th}>{label}</th>)}
      </tr></thead>
      <tbody>{rows.map(row => (
        <tr key={row.position_key} className="hover:bg-elevated/30">
          <td className={td}>{traderLabel(row.trader)}</td>
          <td className={td}><StockIdentity row={row} onPreview={onPreview} /></td>
          <td className={td}>{row.open_date}</td>
          <td className={`${td} font-mono`}>{row.quantity.toLocaleString('zh-CN')}</td>
          <td className={`${td} font-mono`}>{money(row.cost, 4)}</td>
          <td className={`${td} font-mono`}>{money(row.cost_amount)}</td>
          <td className={`${td} font-mono`}>{money(row.current_price, 4)}<span className="ml-1 text-[10px] text-muted">{row.price_status === 'stale' ? '过期' : row.price_status === 'unavailable' ? '不可用' : ''}</span></td>
          <td className={`${td} font-mono`}>{money(row.market_value)}</td>
          <td className={`${td} font-mono ${priceColorClass(row.unrealized_pnl)}`}>{money(row.unrealized_pnl)}</td>
          <td className={`${td} font-mono ${priceColorClass(row.return_rate)}`}>{fmtPct(row.return_rate)}</td>
        </tr>
      ))}</tbody>
    </TableWrap>
  )
}

export function HistoryTable({ rows, onPreview }: { rows: HistoryRow[]; onPreview?: (symbol: string, name: string) => void }) {
  return (
    <TableWrap>
      <thead><tr>
        {['交易者', '股票', '买入日期', '卖出日期', '数量', '成本金额', '净回收', '已实现盈亏', '收益率', '持有天数'].map(label => <th key={label} className={th}>{label}</th>)}
      </tr></thead>
      <tbody>{rows.map(row => (
        <tr key={row.history_id} className="hover:bg-elevated/30">
          <td className={td}>{traderLabel(row.trader)}</td>
          <td className={td}><StockIdentity row={row} onPreview={onPreview} /></td>
          <td className={td}>{row.open_date}</td>
          <td className={td}>{row.close_date}</td>
          <td className={`${td} font-mono`}>{row.quantity.toLocaleString('zh-CN')}</td>
          <td className={`${td} font-mono`}>{money(row.cost_amount)}</td>
          <td className={`${td} font-mono`}>{money(row.exit_amount)}</td>
          <td className={`${td} font-mono ${priceColorClass(row.realized_pnl)}`}>{money(row.realized_pnl)}</td>
          <td className={`${td} font-mono ${priceColorClass(row.return_rate)}`}>{fmtPct(row.return_rate)}</td>
          <td className={`${td} font-mono`}>{row.holding_days}</td>
        </tr>
      ))}</tbody>
    </TableWrap>
  )
}

export function RecordTable({ rows, onEdit, onDelete, onPreview }: { rows: TradeRecord[]; onEdit: (record: TradeRecord) => void; onDelete: (record: TradeRecord) => void; onPreview?: (symbol: string, name: string) => void }) {
  return (
    <TableWrap>
      <thead><tr>
        {['日期 / 时间', '交易者', '股票', '方向', '价格', '数量', '费用 / 税费', '备注', '操作'].map(label => <th key={label} className={th}>{label}</th>)}
      </tr></thead>
      <tbody>{rows.map(row => (
        <tr key={row.id} className="hover:bg-elevated/30">
          <td className={td}>{row.trade_date}<span className="ml-1 text-muted">{row.trade_time ?? ''}</span></td>
          <td className={td}>{traderLabel(row.trader)}</td>
          <td className={td}><StockIdentity row={row} onPreview={onPreview} /></td>
          <td className={td}><span className={row.side === 'buy' ? 'text-bull' : 'text-bear'}>{row.side === 'buy' ? '买入' : '卖出'}</span></td>
          <td className={`${td} font-mono`}>{money(row.price, 4)}</td>
          <td className={`${td} font-mono`}>{row.quantity.toLocaleString('zh-CN')}</td>
          <td className={`${td} font-mono`}>{money(row.fee)} / {money(row.tax)}</td>
          <td className={`${td} max-w-[180px] truncate`} title={row.note ?? undefined}>{row.note ?? '—'}</td>
          <td className={td}>
            <div className="flex gap-1">
              <button type="button" aria-label={`编辑 ${row.name} ${row.trade_date} 交易记录`} onClick={() => onEdit(row)} className="rounded-btn p-1.5 hover:bg-elevated"><Pencil className="h-3.5 w-3.5" /></button>
              <button type="button" aria-label={`删除 ${row.name} ${row.trade_date} 交易记录`} onClick={() => onDelete(row)} className="rounded-btn p-1.5 text-danger hover:bg-danger/10"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          </td>
        </tr>
      ))}</tbody>
    </TableWrap>
  )
}

export function ReviewListView({ rows, onEdit, onDelete }: { rows: DailyReview[]; onEdit: (review: DailyReview) => void; onDelete: (review: DailyReview) => void }) {
  return <div className="divide-y divide-border/70">{rows.map(row => (
    <article key={row.id} className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-foreground">{row.date}</h3>
          <span className="text-[11px] text-muted">{traderLabel(row.trader)} · 版本 {row.version}</span>
        </div>
        <div className="flex gap-1">
          <button type="button" aria-label={`编辑 ${row.trader} ${row.date} 复盘`} onClick={() => onEdit(row)} className="rounded-btn p-1.5 text-secondary hover:bg-elevated"><Pencil className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label={`删除 ${row.trader} ${row.date} 复盘`} onClick={() => onDelete(row)} className="rounded-btn p-1.5 text-danger hover:bg-danger/10"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-secondary">{row.content}</p>
      {row.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{row.tags.map((tag, index) => <span key={`${tag}-${index}`} className="rounded bg-elevated px-2 py-0.5 text-[11px] text-muted">{tag}</span>)}</div>}
    </article>
  ))}</div>
}
