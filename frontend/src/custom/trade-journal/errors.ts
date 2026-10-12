import type { FieldError } from './types'

/** 与 docs/api.md §2.6 错误 envelope 对齐的客户端错误。 */
export class TradeJournalError extends Error {
  readonly status: number
  readonly code: string
  readonly fields: FieldError[]

  constructor(status: number, code: string, message: string, fields: FieldError[] = []) {
    super(message)
    this.name = 'TradeJournalError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export function isTradeJournalError(error: unknown): error is TradeJournalError {
  return error instanceof TradeJournalError
}
