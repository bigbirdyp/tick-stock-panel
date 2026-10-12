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

// Response cost is cost_amount / quantity. cost_amount is already rounded to
// cents, so the average must divide that cent amount rather than the 1e-8 lot.
export function averagePrice(amountUnits, quantity) {
  const cents = roundDivide(amountUnits, 1_000_000n);
  return roundedNumber(roundDivide(cents * 1_000_000n, BigInt(quantity)), 4);
}

export function ratio(numerator, denominator) {
  return denominator === 0n ? null : Number(roundDivide(numerator * 1_000_000n, denominator)) / 1_000_000;
}
