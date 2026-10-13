import { TradeJournalError } from './errors'
import type {
  ApiSuccess,
  DailyReview,
  HistoryList,
  PositionList,
  RecordList,
  RecordPatch,
  RecordWrite,
  ReviewList,
  ReviewPatch,
  ReviewWrite,
  TradeJournalApi,
  TradeRecord,
  TraderList,
} from './types'

/**
 * 同源 /api 适配器。错误读取 docs/api.md 的 error.code，
 * 不走 lib/api.ts：那里的 request 未导出，且按 FastAPI detail 解析。
 */
export function createHttpTradeJournal(fetchImpl: typeof fetch = fetch): TradeJournalApi {
  return {
    mode: 'api',
    listRecords: query => send<RecordList>(fetchImpl, `/api/records${qs(query)}`),
    listTraders: () => send<TraderList>(fetchImpl, '/api/traders'),
    createRecord: body => send<TradeRecord>(fetchImpl, '/api/records', { method: 'POST', body }),
    patchRecord: (id, body) => send<TradeRecord>(fetchImpl, `/api/records/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteRecord: (id, expectedVersion) => send<void>(fetchImpl, `/api/records/${encodeURIComponent(id)}${qs({ expected_version: expectedVersion })}`, { method: 'DELETE' }).then(() => undefined),
    listReviews: query => send<ReviewList>(fetchImpl, `/api/reviews${qs(query)}`),
    createReview: body => send<DailyReview>(fetchImpl, '/api/reviews', { method: 'POST', body }),
    patchReview: (id, body) => send<DailyReview>(fetchImpl, `/api/reviews/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteReview: (id, expectedVersion) => send<void>(fetchImpl, `/api/reviews/${encodeURIComponent(id)}${qs({ expected_version: expectedVersion })}`, { method: 'DELETE' }).then(() => undefined),
    currentPositions: query => send<PositionList>(fetchImpl, `/api/positions/current${qs(query)}`),
    history: query => send<HistoryList>(fetchImpl, `/api/positions/history${qs(query)}`),
  }
}

function qs(query: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function send<T>(fetchImpl: typeof fetch, path: string, init?: { method?: string; body?: RecordWrite | RecordPatch | ReviewWrite | ReviewPatch }): Promise<ApiSuccess<T>> {
  let response: Response
  try {
    response = await fetchImpl(path, {
      method: init?.method ?? 'GET',
      headers: init?.body == null
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
      body: init?.body == null ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new TradeJournalError(0, 'INTERNAL_ERROR', '网络连接中断，请重试')
  }
  if (response.status === 204) {
    return { data: undefined as T, meta: { duplicate: false }, status: 204 }
  }
  const text = await response.text()
  let payload: { data?: T; meta?: { duplicate?: boolean }; error?: { code?: string; message?: string; details?: { fields?: { path: string; message: string }[] } } } = {}
  if (text) {
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      throw new TradeJournalError(response.status, 'BAD_REQUEST', '响应不是 JSON')
    }
  }
  if (!response.ok) {
    const code = payload.error?.code ?? 'INTERNAL_ERROR'
    const message = payload.error?.message ?? `接口返回 ${response.status}`
    throw new TradeJournalError(response.status, code, message, payload.error?.details?.fields ?? [])
  }
  return {
    data: payload.data as T,
    meta: { duplicate: payload.meta?.duplicate === true },
    status: response.status,
  }
}
