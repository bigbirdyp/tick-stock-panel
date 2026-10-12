// All stored monetary inputs are decimal strings. Derived amounts use 1e-8 yuan units.
export const SCALE = 100_000_000n;

export function decimalUnits(value) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0') || '0');
}

export function roundDivide(numerator, denominator) {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function roundedNumber(units, places) {
  const divisor = 10n ** BigInt(8 - places);
  return Number(roundDivide(units, divisor)) / 10 ** places;
}

export function ratio(numerator, denominator) {
  return denominator === 0n ? null : Number(roundDivide(numerator * 1_000_000n, denominator)) / 1_000_000;
}
