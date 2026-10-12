/**
 * 与 Node `stockCode` 当前接受的 A 股前缀对齐。
 * 沪：600/601/603/605/688/689；深：000/001/002/003/300/301；北：920。
 * B 股（90/20）和其他无法唯一对应交易所的六位代码返回 null，调用方不得猜交易所。
 */
const SH_PREFIXES = ['600', '601', '603', '605', '688', '689']
const SZ_PREFIXES = ['000', '001', '002', '003', '300', '301']

export function resolveSymbol(code: string): string | null {
  if (!/^[0-9]{6}$/.test(code)) return null
  if (SH_PREFIXES.some(prefix => code.startsWith(prefix))) return `${code}.SH`
  if (SZ_PREFIXES.some(prefix => code.startsWith(prefix))) return `${code}.SZ`
  if (code.startsWith('920')) return `${code}.BJ`
  return null
}
