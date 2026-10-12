/**
 * 金额用定点微元（10^-6 元）计算，避免二进制浮点成为持仓口径。
 * 对外仍按契约转成 JSON number：金额 2 位、价格类最多 4 位、收益率 6 位。
 * 极大金额会超出 JS number 安全整数，A 股日常成交额在安全范围内。
 */

const SCALE = 1_000_000n

export function decimalPlacesOf(value: number): number {
  if (!Number.isFinite(value)) return 99
  const text = String(value)
  if (/e/i.test(text)) return 99
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/** 把有限小数转成微元。小数位超过 maxPlaces 时返回 null，交给校验报错。 */
export function decFromNumber(value: number, maxPlaces: number): bigint | null {
  if (!Number.isFinite(value)) return null
  if (decimalPlacesOf(value) > maxPlaces) return null
  const negative = value < 0
  const [whole, frac = ''] = Math.abs(value).toFixed(6).split('.')
  const micro = BigInt(whole) * SCALE + BigInt(frac)
  return negative ? -micro : micro
}

function magnitudeRoundHalfAway(value: bigint, step: bigint): bigint {
  const negative = value < 0n
  const abs = negative ? -value : value
  const q = abs / step
  const r = abs % step
  const rounded = r * 2n >= step ? q + 1n : q
  return negative ? -rounded : rounded
}

export function roundDec(micro: bigint, places: number): bigint {
  const step = 10n ** BigInt(6 - places)
  return magnitudeRoundHalfAway(micro, step) * step
}

export function decToNumber(micro: bigint, places: number): number {
  const rounded = roundDec(micro, places)
  const negative = rounded < 0n
  const abs = negative ? -rounded : rounded
  const whole = abs / SCALE
  const frac = (abs % SCALE).toString().padStart(6, '0').slice(0, places)
  const text = places > 0 ? `${whole.toString()}.${frac}` : whole.toString()
  return Number(negative ? `-${text}` : text)
}

export function mulQty(micro: bigint, quantity: number): bigint {
  return micro * BigInt(quantity)
}

export function divHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('除数为 0')
  const negative = (numerator < 0n) !== (denominator < 0n)
  const left = numerator < 0n ? -numerator : numerator
  const right = denominator < 0n ? -denominator : denominator
  const q = left / right
  const r = left % right
  const rounded = r * 2n >= right ? q + 1n : q
  return negative ? -rounded : rounded
}

/** 收益率 = numerator / denominator，四舍五入到 places 位小数。分母为 0 返回 null。 */
export function ratio(numerator: bigint, denominator: bigint, places: number): number | null {
  if (denominator === 0n) return null
  const scaled = divHalfAway(numerator * (10n ** BigInt(places)), denominator)
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const unit = 10n ** BigInt(places)
  const whole = abs / unit
  const frac = (abs % unit).toString().padStart(places, '0')
  return Number(`${negative ? '-' : ''}${whole.toString()}.${frac}`)
}
