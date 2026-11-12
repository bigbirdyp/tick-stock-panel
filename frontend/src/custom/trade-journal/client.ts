import { createHttpTradeJournal } from './httpClient'
import { createMockTradeJournal } from './mockStore'

/** 真正的同源 API 为默认；mock 仅供前后端未联通时显式试用。 */
export const journal = import.meta.env.VITE_TRADE_JOURNAL_SOURCE === 'mock'
  ? createMockTradeJournal(true)
  : createHttpTradeJournal()
