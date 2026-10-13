import { useEffect, useState, type KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { PageHeader } from '@/components/PageHeader'
import { toast } from '@/components/Toast'
import { QK } from '@/lib/queryKeys'
import { shanghaiToday } from './calendar'
import { journal } from './client'
import { isTradeJournalError } from './errors'
import { RecordForm, ReviewForm } from './forms'
import { HistoryTable, Pager, PositionTable, RecordTable, ResultState, ReviewListView } from './lists'
import { TraderTabs } from './traderTabs'
import type {
  DailyReview,
  HistoryQuery,
  PositionQuery,
  RecordListQuery,
  RecordWrite,
  ReviewListQuery,
  ReviewWrite,
  TradeRecord,
} from './types'

type Tab = 'positions' | 'history' | 'records' | 'reviews'
type Deletion = { kind: 'record'; item: TradeRecord } | { kind: 'review'; item: DailyReview }

const tabs: { key: Tab; label: string }[] = [
  { key: 'positions', label: '当前持仓' },
  { key: 'history', label: '历史收益' },
  { key: 'records', label: '交易记录' },
  { key: 'reviews', label: '每日复盘' },
]

const filterClass = 'h-8 rounded-md border border-border bg-base px-2 text-xs text-foreground outline-none focus:border-accent'

function isJournalTab(value: string | null): value is Tab {
  return value === 'positions' || value === 'history' || value === 'records' || value === 'reviews'
}

// 只在首次挂载时读地址栏。jsdom 与浏览器都用 location.search；没有 window 时按缺省处理。
// 非法或缺省 tab 回到持仓；空白或缺省 trader 表示「全部」。
function readLocationSearch(): string {
  if (typeof window === 'undefined') return ''
  const search = window.location?.search
  return typeof search === 'string' ? search : ''
}

// 用户点选交易者或栏目时写回地址栏。其它查询参数和 hash 原样保留。
// 解析后的查询与当前一致则不 pushState，避免重复历史。本阶段不监听 popstate。
function pushJournalSearch(update: (params: URLSearchParams) => void): void {
  if (typeof window === 'undefined') return
  const history = window.history
  if (typeof history?.pushState !== 'function') return
  const current = new URLSearchParams(readLocationSearch())
  const next = new URLSearchParams(current)
  update(next)
  if (next.toString() === current.toString()) return
  const query = next.toString()
  const pathname = typeof window.location.pathname === 'string' ? window.location.pathname : ''
  const hash = typeof window.location.hash === 'string' ? window.location.hash : ''
  history.pushState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`)
}

// 「全部」或空白交易者删除 trader；不改当前栏目参数。
function writeTraderSelection(trader: string | undefined): void {
  pushJournalSearch(params => {
    const name = trader?.trim() ?? ''
    if (name) params.set('trader', name)
    else params.delete('trader')
  })
}

// 只改 tab，保留地址栏里现有的 trader。
function writeTabSelection(next: Tab): void {
  pushJournalSearch(params => {
    params.set('tab', next)
  })
}

function initialJournalView(): { tab: Tab; trader?: string } {
  const params = new URLSearchParams(readLocationSearch())
  const tabParam = params.get('tab')
  const tab: Tab = isJournalTab(tabParam) ? tabParam : 'positions'
  const trader = params.get('trader')?.trim()
  return trader ? { tab, trader } : { tab }
}

function withTrader<T extends { trader?: string; offset?: number }>(query: T, trader: string | undefined): T {
  const next: T = { ...query, offset: 0 }
  if (trader) next.trader = trader
  else delete next.trader
  return next
}

export function TradeJournalPage() {
  const qc = useQueryClient()
  const [view] = useState<{ tab: Tab; trader?: string }>(initialJournalView)
  const [tab, setTab] = useState<Tab>(view.tab)
  const [positionQuery, setPositionQuery] = useState<PositionQuery>(() => withTrader({ as_of: shanghaiToday(), limit: 20, offset: 0, sort: 'symbol_asc' }, view.trader))
  const [historyQuery, setHistoryQuery] = useState<HistoryQuery>(() => withTrader({ limit: 20, offset: 0, sort: 'close_date_desc' }, view.trader))
  const [recordQuery, setRecordQuery] = useState<RecordListQuery>(() => withTrader({ limit: 20, offset: 0, sort: 'trade_date_desc' }, view.trader))
  const [reviewQuery, setReviewQuery] = useState<ReviewListQuery>({ limit: 20, offset: 0, sort: 'date_desc' })
  const [codeInput, setCodeInput] = useState('')
  const [recordEditor, setRecordEditor] = useState<TradeRecord | 'new' | null>(null)
  const [reviewEditor, setReviewEditor] = useState<DailyReview | 'new' | null>(null)
  const [deletion, setDeletion] = useState<Deletion | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)

  const traders = useQuery({
    queryKey: QK.tradeJournalTraders(),
    queryFn: () => journal.listTraders(),
  })
  const positions = useQuery({
    queryKey: QK.tradeJournalPositions(JSON.stringify(positionQuery)),
    queryFn: () => journal.currentPositions(positionQuery),
    enabled: tab === 'positions',
  })
  const history = useQuery({
    queryKey: QK.tradeJournalHistory(JSON.stringify(historyQuery)),
    queryFn: () => journal.history(historyQuery),
    enabled: tab === 'history',
  })
  const records = useQuery({
    queryKey: QK.tradeJournalRecords(JSON.stringify(recordQuery)),
    queryFn: () => journal.listRecords(recordQuery),
    enabled: tab === 'records',
  })
  const reviews = useQuery({
    queryKey: QK.tradeJournalReviews(JSON.stringify(reviewQuery)),
    queryFn: () => journal.listReviews(reviewQuery),
    enabled: tab === 'reviews',
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: QK.tradeJournal })

  const saveRecord = async (body: RecordWrite, original: TradeRecord | null) => {
    const result = original
      ? await journal.patchRecord(original.id, {
          expected_version: original.version,
          trader: body.trader,
          trade_date: body.trade_date,
          trade_time: body.trade_time,
          code: body.code,
          name: body.name,
          side: body.side,
          price: body.price,
          quantity: body.quantity,
          fee: body.fee,
          tax: body.tax,
          note: body.note,
        })
      : await journal.createRecord(body)
    await invalidate()
    setRecordEditor(null)
    setRecordQuery(query => ({ ...query, offset: 0 }))
    setTab('records')
    writeTabSelection('records')
    toast(result.meta.duplicate ? '这笔交易已保存，无需重复录入' : '交易记录已保存', 'success')
    return result
  }

  const saveReview = async (body: ReviewWrite, original: DailyReview | null) => {
    const result = original
      ? await journal.patchReview(original.id, { ...body, expected_version: original.version })
      : await journal.createReview(body)
    await invalidate()
    setReviewEditor(null)
    setReviewQuery(query => ({ ...query, offset: 0 }))
    setTab('reviews')
    writeTabSelection('reviews')
    toast('复盘已保存', 'success')
    return result
  }

  const askDelete = (target: Deletion) => {
    setDeletion(target)
    setDeleteError(null)
  }

  const confirmDelete = async () => {
    if (!deletion || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      if (deletion.kind === 'record') {
        await journal.deleteRecord(deletion.item.id, deletion.item.version)
        setRecordQuery(query => ({ ...query, offset: 0 }))
      } else {
        await journal.deleteReview(deletion.item.id, deletion.item.version)
        setReviewQuery(query => ({ ...query, offset: 0 }))
      }
      await invalidate()
      setDeletion(null)
      toast('已删除', 'success')
    } catch (error) {
      setDeleteError(error)
      if (isTradeJournalError(error) && (error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND')) {
        await invalidate()
      }
    } finally { setDeleting(false) }
  }

  const selectTrader = (trader: string | undefined) => {
    setPositionQuery(query => withTrader(query, trader))
    setHistoryQuery(query => withTrader(query, trader))
    setRecordQuery(query => withTrader(query, trader))
    writeTraderSelection(trader)
  }

  useEffect(() => {
    const selected = recordQuery.trader
    if (!selected || !traders.isSuccess || traders.isFetching) return
    if (traders.data.data.traders.some(item => item.trader === selected)) return
    setPositionQuery(query => withTrader(query, undefined))
    setHistoryQuery(query => withTrader(query, undefined))
    setRecordQuery(query => withTrader(query, undefined))
  }, [recordQuery.trader, traders.data, traders.isSuccess, traders.isFetching])

  const applyCode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const code = codeInput.trim() || undefined
    if (tab === 'positions') setPositionQuery(query => ({ ...query, code, offset: 0 }))
    if (tab === 'history') setHistoryQuery(query => ({ ...query, code, offset: 0 }))
    if (tab === 'records') setRecordQuery(query => ({ ...query, code, offset: 0 }))
  }

  const changeTab = (next: Tab) => {
    setTab(next)
    const code = next === 'positions' ? positionQuery.code : next === 'history' ? historyQuery.code : next === 'records' ? recordQuery.code : ''
    setCodeInput(code ?? '')
    writeTabSelection(next)
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(item => item.key === tab)
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : -1
    if (next < 0) return
    event.preventDefault()
    changeTab(tabs[next].key)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const currentQuery = tab === 'positions' ? positions : tab === 'history' ? history : tab === 'records' ? records : reviews

  return (
    <div className="flex h-full flex-col bg-base">
      <PageHeader
        title="交易日记"
        className="flex-wrap"
        titleExtra={journal.mode === 'mock' ? <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] text-warning">示例数据</span> : undefined}
        right={<div className="flex gap-2">
          <button type="button" onClick={() => setRecordEditor('new')} className="inline-flex items-center gap-1 rounded-btn bg-accent px-3 py-1.5 text-xs font-medium text-white"><Plus className="h-3.5 w-3.5" />记交易</button>
          <button type="button" onClick={() => setReviewEditor('new')} className="inline-flex items-center gap-1 rounded-btn border border-border px-3 py-1.5 text-xs text-secondary"><Plus className="h-3.5 w-3.5" />写复盘</button>
        </div>}
      />
      <div className="flex-1 overflow-y-auto p-4 sm:p-5">
        <div className="mx-auto max-w-7xl space-y-4">
          <p className="text-xs text-muted">持仓与历史收益包含成交费用和税费。收益率为小数制 API 数值换算后的百分比；行情不可用时显示“—”，过期行情会标记。</p>
          <div className="rounded-md border border-border bg-surface p-3">
            <TraderTabs
              traders={traders.data?.data.traders ?? []}
              selected={recordQuery.trader}
              loading={traders.isPending}
              error={traders.error}
              onSelect={selectTrader}
              onRetry={() => void traders.refetch()}
            />
          </div>
          <div role="tablist" aria-label="交易日记栏目" onKeyDown={onTabKeyDown} className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-1">
            {tabs.map(item => <button key={item.key} id={`journal-tab-${item.key}`} type="button" role="tab" aria-controls="journal-panel" aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} onClick={() => changeTab(item.key)} className={`rounded px-3 py-2 text-xs font-medium ${tab === item.key ? 'bg-accent/15 text-accent' : 'text-secondary hover:bg-elevated'}`}>{item.label}</button>)}
          </div>

          <section id="journal-panel" role="tabpanel" aria-labelledby={`journal-tab-${tab}`} className="overflow-hidden rounded-card border border-border bg-surface">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              {tab !== 'reviews' && <form onSubmit={applyCode} className="flex items-center gap-2">
                <input className={filterClass} aria-label="按股票代码筛选" placeholder="股票代码" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={codeInput} onChange={event => setCodeInput(event.target.value)} />
                <button type="submit" className="rounded-btn border border-border px-3 py-1.5 text-xs text-secondary">筛选</button>
              </form>}
              {tab === 'positions' && <>
                <label className="text-xs text-muted">截止日期 <input className={filterClass} type="date" aria-label="持仓截止日期" value={positionQuery.as_of ?? ''} onChange={event => setPositionQuery(query => ({ ...query, as_of: event.target.value || undefined, offset: 0 }))} /></label>
                <select className={filterClass} aria-label="持仓排序" value={positionQuery.sort} onChange={event => setPositionQuery(query => ({ ...query, sort: event.target.value as PositionQuery['sort'], offset: 0 }))}>
                  <option value="symbol_asc">代码升序</option><option value="market_value_desc">市值降序</option><option value="return_rate_desc">收益率降序</option>
                </select>
              </>}
              {tab === 'history' && <>
                <label className="text-xs text-muted">从 <input className={filterClass} type="date" aria-label="收益起始日期" value={historyQuery.from ?? ''} onChange={event => setHistoryQuery(query => ({ ...query, from: event.target.value || undefined, offset: 0 }))} /></label>
                <label className="text-xs text-muted">至 <input className={filterClass} type="date" aria-label="收益结束日期" value={historyQuery.to ?? ''} onChange={event => setHistoryQuery(query => ({ ...query, to: event.target.value || undefined, offset: 0 }))} /></label>
              </>}
              {tab === 'records' && <>
                <label className="text-xs text-muted">日期 <input className={filterClass} type="date" aria-label="交易日期筛选" value={recordQuery.date ?? ''} onChange={event => setRecordQuery(query => ({ ...query, date: event.target.value || undefined, offset: 0 }))} /></label>
                <select className={filterClass} aria-label="交易方向筛选" value={recordQuery.side ?? ''} onChange={event => setRecordQuery(query => ({ ...query, side: event.target.value as RecordListQuery['side'] || undefined, offset: 0 }))}>
                  <option value="">全部方向</option><option value="buy">买入</option><option value="sell">卖出</option>
                </select>
              </>}
              {tab === 'reviews' && <>
                <label className="text-xs text-muted">日期 <input className={filterClass} type="date" aria-label="复盘日期筛选" value={reviewQuery.date ?? ''} onChange={event => setReviewQuery(query => ({ ...query, date: event.target.value || undefined, offset: 0 }))} /></label>
                <input className={filterClass} aria-label="复盘标签筛选" placeholder="标签" value={reviewQuery.tag ?? ''} onChange={event => setReviewQuery(query => ({ ...query, tag: event.target.value || undefined, offset: 0 }))} />
              </>}
              <button type="button" aria-label="刷新当前列表" onClick={() => void currentQuery.refetch()} className="ml-auto rounded-btn p-1.5 text-muted hover:bg-elevated hover:text-foreground"><RefreshCw className="h-4 w-4" /></button>
            </div>

            {tab === 'positions' && <>
              <ResultState loading={positions.isPending} error={positions.error} empty={positions.data?.data.positions.length === 0} onRetry={() => void positions.refetch()} />
              {positions.data?.data.positions.length ? <PositionTable rows={positions.data.data.positions} /> : null}
              <Pager pagination={positions.data?.data.pagination} onPage={offset => setPositionQuery(query => ({ ...query, offset }))} />
            </>}
            {tab === 'history' && <>
              <ResultState loading={history.isPending} error={history.error} empty={history.data?.data.history.length === 0} onRetry={() => void history.refetch()} />
              {history.data?.data.history.length ? <HistoryTable rows={history.data.data.history} /> : null}
              <Pager pagination={history.data?.data.pagination} onPage={offset => setHistoryQuery(query => ({ ...query, offset }))} />
            </>}
            {tab === 'records' && <>
              <ResultState loading={records.isPending} error={records.error} empty={records.data?.data.records.length === 0} onRetry={() => void records.refetch()} />
              {records.data?.data.records.length ? <RecordTable rows={records.data.data.records} onEdit={setRecordEditor} onDelete={item => askDelete({ kind: 'record', item })} /> : null}
              <Pager pagination={records.data?.data.pagination} onPage={offset => setRecordQuery(query => ({ ...query, offset }))} />
            </>}
            {tab === 'reviews' && <>
              <ResultState loading={reviews.isPending} error={reviews.error} empty={reviews.data?.data.reviews.length === 0} onRetry={() => void reviews.refetch()} />
              {reviews.data?.data.reviews.length ? <ReviewListView rows={reviews.data.data.reviews} onEdit={setReviewEditor} onDelete={item => askDelete({ kind: 'review', item })} /> : null}
              <Pager pagination={reviews.data?.data.pagination} onPage={offset => setReviewQuery(query => ({ ...query, offset }))} />
            </>}
          </section>
        </div>
      </div>

      {recordEditor !== null && <RecordForm key={recordEditor === 'new' ? 'new' : recordEditor.id} record={recordEditor === 'new' ? null : recordEditor} defaultTrader={recordEditor === 'new' ? recordQuery.trader ?? '' : ''} onClose={() => setRecordEditor(null)} onSave={saveRecord} />}
      {reviewEditor !== null && <ReviewForm key={reviewEditor === 'new' ? 'new' : reviewEditor.id} review={reviewEditor === 'new' ? null : reviewEditor} onClose={() => setReviewEditor(null)} onSave={saveReview} />}
      {deletion && <Modal onClose={() => !deleting && setDeletion(null)} ariaLabel="确认删除" panelClassName="w-[92vw] max-w-md rounded-card border border-border bg-surface p-5 shadow-xl" closeOnBackdrop={!deleting}>
        <div className="space-y-4">
          <h2 className="text-base font-semibold">确认删除</h2>
          <p className="text-sm text-secondary">{deletion.kind === 'record' ? `删除 ${deletion.item.trade_date} ${deletion.item.name} 的交易记录？相关持仓和收益会重新计算。` : `删除 ${deletion.item.date} 的每日复盘？`}</p>
          {deleteError !== null && <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {deleteError instanceof Error ? deleteError.message : '删除失败'}
            {isTradeJournalError(deleteError) && deleteError.code === 'VERSION_CONFLICT' && <p className="mt-1">版本已变化，请关闭后从刷新过的列表重新操作。</p>}
          </div>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={deleting} onClick={() => setDeletion(null)} className="rounded-btn border border-border px-4 py-2 text-xs">取消</button>
            <button type="button" disabled={deleting || (isTradeJournalError(deleteError) && deleteError.code === 'VERSION_CONFLICT')} onClick={() => void confirmDelete()} className="rounded-btn bg-danger px-4 py-2 text-xs text-white disabled:opacity-50">{deleting ? '删除中…' : '删除'}</button>
          </div>
        </div>
      </Modal>}
    </div>
  )
}
