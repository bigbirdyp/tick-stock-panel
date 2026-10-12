import { ApiError } from './validation.js';
import { decimalUnits, ratio, roundDivide, roundedNumber } from './money.js';

function compare(left, right, direction = 1) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left < right ? -1 : 1) * direction;
}

function compareKeys(left, right, keys) {
  for (const [key, direction] of keys) {
    const result = compare(left[key], right[key], direction);
    if (result) return result;
  }
  return 0;
}

const chronologicalKeys = [
  ['trade_date', 1], ['trade_time', 1], ['created_at', 1], ['id', 1],
];

export function sortRecords(records, order = 'trade_date_asc') {
  const direction = order === 'trade_date_desc' ? -1 : 1;
  const keys = chronologicalKeys.map(([key]) => [key, direction]);
  return [...records].sort((a, b) => compareKeys(a, b, keys));
}

export function sortReviews(reviews, order = 'date_desc') {
  const direction = order === 'date_desc' ? -1 : 1;
  return [...reviews].sort((a, b) => compareKeys(a, b, [['date', direction], ['created_at', direction], ['id', direction]]));
}

export function derive(records) {
  const bySymbol = new Map();
  const history = [];
  for (const record of sortRecords(records)) {
    let state = bySymbol.get(record.symbol);
    if (!state) {
      state = { code: record.code, symbol: record.symbol, name: record.name, lots: [] };
      bySymbol.set(record.symbol, state);
    }
    state.name = record.name;
    if (record.side === 'buy') {
      state.lots.push({
        recordId: record.id,
        openDate: record.trade_date,
        quantity: record.quantity,
        costAmount: decimalUnits(record.price) * BigInt(record.quantity) + decimalUnits(record.fee) + decimalUnits(record.tax),
      });
      continue;
    }

    let remaining = record.quantity;
    let consumedCost = 0n;
    let openDate = null;
    const buyIds = [];
    for (const lot of state.lots) {
      if (remaining === 0) break;
      if (lot.quantity === 0) continue;
      const matched = Math.min(remaining, lot.quantity);
      const matchedCost = matched === lot.quantity
        ? lot.costAmount
        : roundDivide(lot.costAmount * BigInt(matched), BigInt(lot.quantity));
      lot.quantity -= matched;
      lot.costAmount -= matchedCost;
      remaining -= matched;
      consumedCost += matchedCost;
      openDate = openDate === null || lot.openDate < openDate ? lot.openDate : openDate;
      buyIds.push(lot.recordId);
    }
    if (remaining > 0) throw new ApiError(409, 'INSUFFICIENT_POSITION', `卖出 ${record.symbol} 超过此前持仓`);
    state.lots = state.lots.filter((lot) => lot.quantity > 0);
    const exitAmount = decimalUnits(record.price) * BigInt(record.quantity) - decimalUnits(record.fee) - decimalUnits(record.tax);
    const pnl = exitAmount - consumedCost;
    const exitCents = roundDivide(exitAmount, 1_000_000n);
    const costCents = roundDivide(consumedCost, 1_000_000n);
    history.push({
      history_id: record.id,
      sell_record_id: record.id,
      buy_record_ids: buyIds,
      code: record.code,
      symbol: record.symbol,
      name: record.name,
      open_date: openDate,
      close_date: record.trade_date,
      quantity: record.quantity,
      cost: roundedNumber(roundDivide(consumedCost, BigInt(record.quantity)), 4),
      exit_price: Number(record.price),
      cost_amount: Number(costCents) / 100,
      exit_amount: Number(exitCents) / 100,
      realized_pnl: Number(exitCents - costCents) / 100,
      return_rate: ratio(pnl, consumedCost),
      holding_days: (Date.parse(`${record.trade_date}T00:00:00Z`) - Date.parse(`${openDate}T00:00:00Z`)) / 86_400_000,
      sell_trade_time: record.trade_time,
      sell_created_at: record.created_at,
    });
  }
  return { bySymbol, history };
}

export function currentPositions(records) {
  const { bySymbol } = derive(records);
  const positions = [];
  for (const state of bySymbol.values()) {
    if (state.lots.length === 0) continue;
    const quantity = state.lots.reduce((total, lot) => total + lot.quantity, 0);
    const costAmount = state.lots.reduce((total, lot) => total + lot.costAmount, 0n);
    positions.push({
      position_key: state.symbol,
      code: state.code,
      symbol: state.symbol,
      name: state.name,
      open_date: state.lots.reduce((min, lot) => lot.openDate < min ? lot.openDate : min, state.lots[0].openDate),
      quantity,
      cost: roundedNumber(roundDivide(costAmount, BigInt(quantity)), 4),
      cost_amount: roundedNumber(costAmount, 2),
      current_price: null,
      price_source: null,
      price_as_of: null,
      price_status: 'unavailable',
      market_value: null,
      unrealized_pnl: null,
      return_rate: null,
    });
  }
  return positions;
}

export function sortPositions(positions, order) {
  const keys = order === 'market_value_desc'
    ? [['market_value', -1], ['symbol', 1], ['position_key', 1]]
    : order === 'return_rate_desc'
      ? [['return_rate', -1], ['symbol', 1], ['position_key', 1]]
      : [['symbol', 1], ['position_key', 1]];
  return [...positions].sort((a, b) => compareKeys(a, b, keys));
}

export function sortHistory(history, order) {
  const direction = order === 'close_date_asc' ? 1 : -1;
  return [...history].sort((a, b) => compareKeys(a, b, [
    ['close_date', direction], ['sell_trade_time', direction], ['sell_created_at', direction], ['sell_record_id', direction],
  ]));
}

export function publicHistory(row) {
  const { sell_trade_time, sell_created_at, ...publicRow } = row;
  return publicRow;
}
