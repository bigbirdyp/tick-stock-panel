// Pure selection of one daily raw close. This module does not fetch quotes.
// `close` is forward-adjusted (qfq) and is never a substitute for `raw_close`.
import { SCALE, roundedNumber } from './money.js';

const MAX_UNITS = 1_000_000n * SCALE;
const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Ordinary decimal text only. Exponents, signs, and blanks are rejected here
// so they cannot reach decimalUnits. Fraction digits stop at the 1e-8 yuan scale.
const PRICE_TEXT = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/;
const PLAIN_NUMBER_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function isLeapYear(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

// YYYY-MM-DD must be a real calendar day. Timestamps and impossible dates are not bars.
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const leapDay = month === 2 && isLeapYear(year) ? 1 : 0;
  return day >= 1 && day <= MONTH_DAYS[month] + leapDay;
}

function formatUnits(units) {
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

// Snap an already-plain positive decimal onto the 1e-8 yuan scale.
// Explicit strings never reach this with more than 8 fraction digits.
function scaleDecimal(text) {
  if (!PLAIN_NUMBER_TEXT.test(text)) return null;
  let [whole, fraction = ''] = text.split('.');
  if (whole.length > 7) return null;
  if (fraction.length > 8) {
    const roundUp = fraction[8] >= '5';
    fraction = fraction.slice(0, 8);
    if (roundUp) {
      const joined = `${whole}${fraction}`;
      const bumped = String(BigInt(joined) + 1n).padStart(joined.length, '0');
      whole = bumped.slice(0, -8).replace(/^0+(?=\d)/, '') || '0';
      fraction = bumped.slice(-8);
    }
  }
  const units = BigInt(whole) * SCALE + BigInt((fraction + '00000000').slice(0, 8));
  if (units <= 0n || units > MAX_UNITS) return null;
  // current_price is roundedNumber(units, 4). Below half of 0.0001 that display price is 0.
  if (roundedNumber(units, 4) === 0) return null;
  return formatUnits(units);
}

function rawClosePrice(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !(value > 0) || value > 1_000_000) return null;
    const plain = String(value);
    // 1e-8 and similar JSON numbers stringify in scientific form; toFixed keeps them on scale.
    return scaleDecimal(PLAIN_NUMBER_TEXT.test(plain) ? plain : value.toFixed(8));
  }
  if (typeof value !== 'string' || !PRICE_TEXT.test(value)) return null;
  return scaleDecimal(value);
}

function isBar(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// rows: one symbol's daily bars, or a flat batch of bars. Both use `date` + `raw_close`.
// Returns null when no finite positive raw close exists on or before asOf.
export function selectDailyQuote(rows, asOf) {
  if (!Array.isArray(rows) || !isCalendarDate(asOf)) return null;
  let best = null;
  for (const row of rows) {
    if (!isBar(row) || !isCalendarDate(row.date) || row.date > asOf) continue;
    const price = rawClosePrice(row.raw_close);
    if (price === null) continue;
    // ISO dates sort chronologically. A later row on the same day replaces an earlier one.
    if (best === null || row.date >= best.price_as_of) {
      best = {
        price,
        price_as_of: row.date,
        price_status: row.date === asOf ? 'fresh' : 'stale',
      };
    }
  }
  return best;
}
