/** 只接受能唯一对应交易所的 A 股代码。无法识别时返回 null，调用方不得猜交易所。 */
export function resolveSymbol(code: string): string | null {
  if (!/^[0-9]{6}$/.test(code)) return null
  if (/^(60|68|90)\d{4}$/.test(code)) return `${code}.SH`
  if (/^(00|30|20)\d{4}$/.test(code)) return `${code}.SZ`
  if (/^(43|82|83|87|92)\d{4}$/.test(code)) return `${code}.BJ`
  return null
}
