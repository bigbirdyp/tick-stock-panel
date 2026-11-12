import { openableSymbol, resolveSymbol } from './symbol'

export type StockAlias = { code: string; symbol: string; name: string }
export type StockNameRef = { symbol: string; name: string }

export type ReviewSegment =
  | { kind: 'text'; text: string }
  | { kind: 'stock'; text: string; symbol: string; name: string; via: 'symbol' | 'code' | 'name' }

const AMOUNT_BEFORE = new Set(['.', '￥', '¥', '$'])
const AMOUNT_AFTER = new Set(['.', '元', '万', '亿', '%', '％'])
// 中文语句可以贴着名称。字母、数字和名称里常见的 *· 才算还在同一个词里。
const NAME_CONTINUE = /[A-Za-z0-9*·]/u

type Hit = { start: number; end: number; text: string; symbol: string; name: string; via: 'symbol' | 'code' | 'name' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function pushAliasRows(target: StockAlias[], value: unknown) {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.asset_type === 'string' && item.asset_type !== 'stock') continue
    const name = typeof item.name === 'string' ? item.name : ''
    const code = typeof item.code === 'string' ? item.code : ''
    const symbol = typeof item.symbol === 'string' ? item.symbol : ''
    if (!name.trim() || (!code.trim() && !symbol.trim())) continue
    target.push({ code, symbol, name })
  }
}

/**
 * 从已经拿到的查询结果里抽出 code/symbol/name。
 * 认这些形状：交易日记列表的 data.positions / history / records，
 * instrument-search 的 results，instrument-names 的 names（symbol → name）。
 * 其它字段忽略，避免把交易者或复盘正文当成股票。
 */
export function aliasesFromPayload(data: unknown): StockAlias[] {
  const rows: StockAlias[] = []
  if (!isRecord(data)) return rows
  pushAliasRows(rows, data.results)
  pushAliasRows(rows, data.positions)
  pushAliasRows(rows, data.history)
  pushAliasRows(rows, data.records)
  if (isRecord(data.data)) {
    pushAliasRows(rows, data.data.results)
    pushAliasRows(rows, data.data.positions)
    pushAliasRows(rows, data.data.history)
    pushAliasRows(rows, data.data.records)
  }
  if (isRecord(data.names)) {
    for (const [symbol, name] of Object.entries(data.names)) {
      if (typeof name !== 'string' || !/^[0-9]{6}/.test(symbol)) continue
      rows.push({ code: symbol.slice(0, 6), symbol, name })
    }
  }
  return rows
}

/** 同名只对应一个规范 symbol 才可点。对不上、重名或带数字的名称记为 null，正文保持原样。 */
export function indexStockNames(rows: readonly StockAlias[]): Map<string, StockNameRef | null> {
  const map = new Map<string, StockNameRef | null>()
  for (const row of rows) {
    const symbol = openableSymbol(row.code, row.symbol)
    const name = row.name.trim()
    if (symbol == null || name.length < 2 || /[0-9]/.test(name)) continue
    const next: StockNameRef = { symbol, name }
    const prev = map.get(name)
    if (prev === undefined) map.set(name, next)
    else if (prev === null || prev.symbol !== symbol) map.set(name, null)
  }
  return map
}

export function stockNamesFromPayloads(payloads: readonly unknown[]): Map<string, StockNameRef | null> {
  return indexStockNames(payloads.flatMap(payload => aliasesFromPayload(payload)))
}

function uniqueName(symbol: string, names: ReadonlyMap<string, StockNameRef | null>): string {
  let found = ''
  for (const ref of names.values()) {
    if (ref == null || ref.symbol !== symbol) continue
    if (found === '') found = ref.name
    else if (found !== ref.name) return ''
  }
  return found
}

function overlaps(hits: readonly Hit[], start: number, end: number): boolean {
  return hits.some(hit => start < hit.end && end > hit.start)
}

function digitRun(content: string, index: number, step: -1 | 1): number {
  let count = 0
  for (let cursor = index; cursor >= 0 && cursor < content.length; cursor += step) {
    const char = content[cursor] ?? ''
    if (char < '0' || char > '9') break
    count += 1
  }
  return count
}

// 逗号两边都是数字时，才可能是千分位或金额碎片。
// 两边各是一组六位代码时，逗号是股票列表标点，不能把代码当成金额。
function commaJoinsAmount(content: string, commaIndex: number): boolean {
  const before = digitRun(content, commaIndex - 1, -1)
  const after = digitRun(content, commaIndex + 1, 1)
  if (before === 0 || after === 0) return false
  return !(before === 6 && after === 6)
}

function isAmountCode(content: string, start: number, end: number): boolean {
  const prev = start > 0 ? content[start - 1] ?? '' : ''
  const next = end < content.length ? content[end] ?? '' : ''
  if (prev !== '' && AMOUNT_BEFORE.has(prev)) return true
  if (next !== '' && AMOUNT_AFTER.has(next)) return true
  if ((prev === ',' || prev === '，') && commaJoinsAmount(content, start - 1)) return true
  if ((next === ',' || next === '，') && commaJoinsAmount(content, end)) return true
  return false
}

function isNameBoundary(content: string, start: number, end: number): boolean {
  const before = start > 0 ? content[start - 1] ?? '' : ''
  const after = end < content.length ? content[end] ?? '' : ''
  if (before !== '' && NAME_CONTINUE.test(before)) return false
  if (after !== '' && NAME_CONTINUE.test(after)) return false
  return true
}

/**
 * 把复盘正文拆成原文和可点股票。只认三件事：
 * 规范 symbol（且后缀与 resolveSymbol 一致）、不在更长数字或 ASCII 标识符内部的六位 A 股代码、
 * 目录里唯一的名称。名称可以贴着中文，但不能贴着英文或数字。
 * 7 位以上数字、日期、小数/货币金额、错误后缀和未知名称留在原文。
 * 两个六位代码之间的中英文逗号是列表标点；逗号用来拼接数字时仍视为金额。
 * 片段按原文切片拼回，不改空格和换行。
 */
export function segmentReviewContent(content: string, names: ReadonlyMap<string, StockNameRef | null> = new Map()): ReviewSegment[] {
  const hits: Hit[] = []
  const symbolRe = /(?<![A-Za-z0-9_])([0-9]{6})\.(SH|SZ|BJ)(?![A-Za-z0-9_])/g
  for (const match of content.matchAll(symbolRe)) {
    const code = match[1] ?? ''
    const full = `${code}.${match[2] ?? ''}`
    if (resolveSymbol(code) !== full) continue
    const start = match.index ?? 0
    hits.push({ start, end: start + match[0].length, text: match[0], symbol: full, name: uniqueName(full, names), via: 'symbol' })
  }
  const codeRe = /(?<![A-Za-z0-9_])([0-9]{6})(?![A-Za-z0-9_])/g
  for (const match of content.matchAll(codeRe)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (overlaps(hits, start, end) || isAmountCode(content, start, end)) continue
    const symbol = resolveSymbol(match[1] ?? '')
    if (symbol == null) continue
    hits.push({ start, end, text: match[0], symbol, name: uniqueName(symbol, names), via: 'code' })
  }
  const known = [...names.entries()].filter((entry): entry is [string, StockNameRef] => entry[1] != null)
  known.sort((left, right) => right[0].length - left[0].length)
  for (const [name, ref] of known) {
    let from = 0
    while (from < content.length) {
      const start = content.indexOf(name, from)
      if (start < 0) break
      const end = start + name.length
      if (isNameBoundary(content, start, end) && !overlaps(hits, start, end)) {
        hits.push({ start, end, text: content.slice(start, end), symbol: ref.symbol, name: ref.name, via: 'name' })
      }
      from = end
    }
  }
  hits.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))
  const segments: ReviewSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start < cursor) continue
    if (hit.start > cursor) segments.push({ kind: 'text', text: content.slice(cursor, hit.start) })
    segments.push({ kind: 'stock', text: hit.text, symbol: hit.symbol, name: hit.name, via: hit.via })
    cursor = hit.end
  }
  if (cursor < content.length || segments.length === 0) segments.push({ kind: 'text', text: content.slice(cursor) })
  return segments
}
