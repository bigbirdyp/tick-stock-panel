import { useState, type FormEvent } from 'react'
import { Modal } from '@/components/Modal'
import { shanghaiToday } from './calendar'
import { TradeJournalError, isTradeJournalError } from './errors'
import { normalizeTradeTime, normalizeTrader } from './validate'
import type { ApiSuccess, DailyReview, RecordWrite, ReviewWrite, TradeRecord } from './types'

const inputClass = 'h-9 w-full rounded-md border border-border bg-base px-3 text-sm text-foreground outline-none focus:border-accent'
const textareaClass = 'w-full rounded-md border border-border bg-base px-3 py-2 text-sm text-foreground outline-none focus:border-accent'

function traderInvalid(error: unknown): boolean {
  return isTradeJournalError(error) && error.fields.some(field => field.path === 'trader')
}

function createRequestId(): string {
  // getRandomValues 在 HTTP 部署中也可用；128 位随机键满足请求去重契约。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null
  const known = isTradeJournalError(error)
  const message = known ? error.message : error instanceof Error ? error.message : '提交失败，请重试'
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
      <p>{message}</p>
      {known && error.fields.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {error.fields.map(field => <li key={`${field.path}:${field.message}`}>{field.path}: {field.message}</li>)}
        </ul>
      )}
      {known && error.code === 'VERSION_CONFLICT' && <p className="mt-1">版本已更新。请关闭表单，刷新列表后重新编辑。</p>}
      {known && error.code === 'DUPLICATE_REVIEW' && <p className="mt-1">该日期下该交易者已有每日复盘，请编辑已有条目。</p>}
      {known && error.code === 'DUPLICATE_RECORD' && <p className="mt-1">请求标识已用于不同内容，请检查后重新提交。</p>}
    </div>
  )
}

interface RecordFormProps {
  record: TradeRecord | null
  /** 非空时锁定为当前交易员：展示该名称且只读，提交也固定为该值。空字符串表示还没有交易员，可以填写新名称。 */
  defaultTrader?: string
  onClose: () => void
  onSave: (body: RecordWrite, original: TradeRecord | null) => Promise<ApiSuccess<TradeRecord>>
}

export function RecordForm({ record, defaultTrader = '', onClose, onSave }: RecordFormProps) {
  const traderLocked = defaultTrader !== ''
  const [trader, setTrader] = useState(traderLocked ? defaultTrader : (record?.trader ?? ''))
  const [date, setDate] = useState(record?.trade_date ?? shanghaiToday())
  const [time, setTime] = useState(record?.trade_time ?? '')
  const [code, setCode] = useState(record?.code ?? '')
  const [name, setName] = useState(record?.name ?? '')
  const [side, setSide] = useState<'buy' | 'sell'>(record?.side ?? 'buy')
  const [price, setPrice] = useState(record ? String(record.price) : '')
  const [quantity, setQuantity] = useState(record ? String(record.quantity) : '')
  const [fee, setFee] = useState(record ? String(record.fee) : '0')
  const [tax, setTax] = useState(record ? String(record.tax) : '0')
  const [note, setNote] = useState(record?.note ?? '')
  const [requestId, setRequestId] = useState(createRequestId)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  // 编辑草稿后换一个幂等键；网络失败而未改草稿时保留原键，安全重试。
  const changed = <T,>(setter: (value: T) => void, value: T) => {
    setter(value)
    if (!record) setRequestId(createRequestId())
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const traderResult = normalizeTrader(traderLocked ? defaultTrader : trader)
    if (!traderResult.ok) {
      setError(new TradeJournalError(traderResult.issue.status, traderResult.issue.code, traderResult.issue.message, traderResult.issue.fields))
      return
    }
    const body: RecordWrite = {
      trader: traderResult.value,
      trade_date: date,
      trade_time: normalizeTradeTime(time),
      code,
      name,
      side,
      price: Number(price),
      quantity: Number(quantity),
      fee: Number(fee),
      tax: Number(tax),
      note: note || null,
      ...(!record ? { client_request_id: requestId } : {}),
    }
    setPending(true)
    setError(null)
    try { await onSave(body, record) }
    catch (reason) { setError(reason) }
    finally { setPending(false) }
  }

  const requestClose = () => { if (!pending) onClose() }

  return (
    <Modal onClose={requestClose} closeOnBackdrop={!pending} ariaLabel={record ? '编辑交易记录' : '新增交易记录'} panelClassName="w-[94vw] max-w-2xl max-h-[90vh] overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{record ? '编辑交易记录' : '新增交易记录'}</h2>
          {record && <span className="text-xs text-muted">版本 {record.version}</span>}
        </div>
        <label className="block space-y-1 text-xs text-secondary">交易者
          <input className={inputClass} aria-label="交易者" aria-invalid={traderInvalid(error)} required maxLength={64} autoComplete="off" placeholder="策略名或人名" readOnly={traderLocked} value={traderLocked ? defaultTrader : trader} onChange={e => { if (traderLocked) return; changed(setTrader, e.target.value) }} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-secondary">交易日期
            <input className={inputClass} aria-label="交易日期" type="date" required value={date} onChange={e => changed(setDate, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">成交时间（可选）
            <input className={inputClass} aria-label="成交时间" type="time" step="1" value={time} onChange={e => changed(setTime, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">股票代码
            <input className={inputClass} aria-label="股票代码" required pattern="[0-9]{6}" maxLength={6} inputMode="numeric" placeholder="600519" value={code} onChange={e => changed(setCode, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">股票名称
            <input className={inputClass} aria-label="股票名称" required maxLength={64} value={name} onChange={e => changed(setName, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">方向
            <select className={inputClass} aria-label="交易方向" value={side} onChange={e => changed(setSide, e.target.value as 'buy' | 'sell')}>
              <option value="buy">买入</option><option value="sell">卖出</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-secondary">成交价（元）
            <input className={inputClass} aria-label="成交价" type="number" required min="0.0001" max="1000000" step="0.0001" value={price} onChange={e => changed(setPrice, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">数量（股）
            <input className={inputClass} aria-label="数量" type="number" required min="1" max="1000000000" step="1" value={quantity} onChange={e => changed(setQuantity, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">费用（元）
            <input className={inputClass} aria-label="费用" type="number" required min="0" max="100000000" step="0.01" value={fee} onChange={e => changed(setFee, e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-secondary">税费（元）
            <input className={inputClass} aria-label="税费" type="number" required min="0" max="100000000" step="0.01" value={tax} onChange={e => changed(setTax, e.target.value)} />
          </label>
        </div>
        <label className="block space-y-1 text-xs text-secondary">备注（可选）
          <textarea className={textareaClass} aria-label="交易备注" rows={3} maxLength={1000} value={note} onChange={e => changed(setNote, e.target.value)} />
        </label>
        <ErrorMessage error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} className="rounded-btn border border-border px-4 py-2 text-xs disabled:opacity-50" onClick={requestClose}>取消</button>
          <button type="submit" disabled={pending} className="rounded-btn bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{pending ? '提交中…' : '保存记录'}</button>
        </div>
      </form>
    </Modal>
  )
}

interface ReviewFormProps {
  review: DailyReview | null
  /** 非空时锁定为当前交易员：展示该名称且只读，提交也固定为该值。空字符串表示还没有交易员，可以填写新名称。 */
  defaultTrader?: string
  onClose: () => void
  onSave: (body: ReviewWrite, original: DailyReview | null) => Promise<ApiSuccess<DailyReview>>
}

export function ReviewForm({ review, defaultTrader = '', onClose, onSave }: ReviewFormProps) {
  const traderLocked = defaultTrader !== ''
  const [trader, setTrader] = useState(traderLocked ? defaultTrader : (review?.trader ?? ''))
  const [date, setDate] = useState(review?.date ?? shanghaiToday())
  const [content, setContent] = useState(review?.content ?? '')
  const [tagsText, setTagsText] = useState(review?.tags.join('，') ?? '')
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const traderResult = normalizeTrader(traderLocked ? defaultTrader : trader)
    if (!traderResult.ok) {
      setError(new TradeJournalError(traderResult.issue.status, traderResult.issue.code, traderResult.issue.message, traderResult.issue.fields))
      return
    }
    const tags = tagsText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
    setPending(true)
    setError(null)
    try { await onSave({ trader: traderResult.value, date, content, tags }, review) }
    catch (reason) { setError(reason) }
    finally { setPending(false) }
  }

  const requestClose = () => { if (!pending) onClose() }

  return (
    <Modal onClose={requestClose} closeOnBackdrop={!pending} ariaLabel={review ? '编辑每日复盘' : '新增每日复盘'} panelClassName="w-[94vw] max-w-2xl max-h-[90vh] overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{review ? '编辑每日复盘' : '新增每日复盘'}</h2>
          {review && <span className="text-xs text-muted">版本 {review.version}</span>}
        </div>
        <label className="block space-y-1 text-xs text-secondary">交易者
          <input className={inputClass} aria-label="复盘交易者" aria-invalid={traderInvalid(error)} required maxLength={64} autoComplete="off" placeholder="策略名或人名" readOnly={traderLocked} value={traderLocked ? defaultTrader : trader} onChange={e => { if (traderLocked) return; setTrader(e.target.value); setError(null) }} />
        </label>
        <label className="block space-y-1 text-xs text-secondary">复盘日期
          <input className={inputClass} aria-label="复盘日期" type="date" required value={date} onChange={e => { setDate(e.target.value); setError(null) }} />
        </label>
        <label className="block space-y-1 text-xs text-secondary">复盘内容
          <textarea className={textareaClass} aria-label="复盘内容" rows={8} required maxLength={20000} value={content} onChange={e => { setContent(e.target.value); setError(null) }} />
        </label>
        <label className="block space-y-1 text-xs text-secondary">标签（以逗号分隔，最多 20 个）
          <input className={inputClass} aria-label="复盘标签" value={tagsText} onChange={e => { setTagsText(e.target.value); setError(null) }} />
        </label>
        <ErrorMessage error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} className="rounded-btn border border-border px-4 py-2 text-xs disabled:opacity-50" onClick={requestClose}>取消</button>
          <button type="submit" disabled={pending} className="rounded-btn bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{pending ? '提交中…' : '保存复盘'}</button>
        </div>
      </form>
    </Modal>
  )
}
