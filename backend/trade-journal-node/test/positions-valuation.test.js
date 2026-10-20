import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPositions, derive } from '../src/positions.js';

function trade(overrides) {
  return {
    id: 'rec-1',
    trader: '杨鹏',
    code: '600519',
    symbol: '600519.SH',
    name: '贵州茅台',
    side: 'buy',
    trade_date: '2026-10-01',
    trade_time: '09:30:00',
    created_at: '2026-10-01T01:30:00.000Z',
    quantity: 1,
    price: '10.005',
    fee: '0',
    tax: '0',
    ...overrides,
  };
}

function quote(price, price_as_of, price_status) {
  return { price, price_as_of, price_status };
}

test('current positions stay unavailable when no quote is supplied', () => {
  const open = [trade()];
  const [plain] = currentPositions(open);
  assert.equal(plain.cost, 10.005);
  assert.equal(plain.cost_amount, 10.01);
  assert.equal(plain.current_price, null);
  assert.equal(plain.price_source, null);
  assert.equal(plain.price_as_of, null);
  assert.equal(plain.price_status, 'unavailable');
  assert.equal(plain.market_value, null);
  assert.equal(plain.unrealized_pnl, null);
  assert.equal(plain.return_rate, null);

  assert.deepEqual(currentPositions(open, new Map()), [plain]);
  assert.deepEqual(currentPositions(open, new Map([
    ['000001.SZ', quote('9.000', '2026-10-17', 'fresh')],
  ])), [plain]);

  const closed = [
    trade(),
    trade({
      id: 'rec-2',
      side: 'sell',
      price: '10.014',
      trade_date: '2026-10-02',
      trade_time: '10:00:00',
      created_at: '2026-10-02T02:00:00.000Z',
    }),
  ];
  const { history } = derive(closed);
  assert.equal(history.length, 1);
  assert.equal(history[0].cost_amount, 10.01);
  assert.equal(history[0].exit_amount, 10.01);
  assert.equal(history[0].realized_pnl, 0.01);
  assert.equal(history[0].return_rate, 0.0009);
  assert.equal(Object.hasOwn(history[0], 'current_price'), false);
  assert.equal(currentPositions(closed, new Map([
    ['600519.SH', quote('10.014', '2026-10-17', 'fresh')],
  ])).length, 0);
});

test('fresh and stale quotes round exact cost independently of displayed amounts', () => {
  const positions = currentPositions([
    trade({ id: 'fresh-buy', symbol: '600519.SH', code: '600519', price: '10.005' }),
    trade({
      id: 'stale-buy',
      symbol: '000001.SZ',
      code: '000001',
      name: '平安银行',
      price: '10.014',
      trade_time: '09:31:00',
      created_at: '2026-10-01T01:31:00.000Z',
    }),
  ], new Map([
    ['600519.SH', quote('10.014', '2026-10-17', 'fresh')],
    ['000001.SZ', quote('10.005', '2026-10-16', 'stale')],
  ]));
  const fresh = positions.find((row) => row.symbol === '600519.SH');
  const stale = positions.find((row) => row.symbol === '000001.SZ');

  assert.equal(fresh.current_price, 10.014);
  assert.equal(fresh.price_source, 'tsp_kline_daily');
  assert.equal(fresh.price_as_of, '2026-10-17');
  assert.equal(fresh.price_status, 'fresh');
  assert.equal(fresh.cost_amount, 10.01);
  assert.equal(fresh.market_value, 10.01);
  assert.equal(fresh.market_value - fresh.cost_amount, 0);
  assert.equal(fresh.unrealized_pnl, 0.01);
  assert.equal(fresh.return_rate, 0.0009);

  assert.equal(stale.current_price, 10.005);
  assert.equal(stale.price_source, 'tsp_kline_daily');
  assert.equal(stale.price_as_of, '2026-10-16');
  assert.equal(stale.price_status, 'stale');
  assert.equal(stale.cost_amount, 10.01);
  assert.equal(stale.market_value, 10.01);
  assert.equal(stale.market_value - stale.cost_amount, 0);
  assert.equal(stale.unrealized_pnl, -0.01);
  assert.equal(stale.return_rate, -0.000899);
});

test('traders sharing a symbol share the quote and keep separate costs', () => {
  const positions = currentPositions([
    trade({ id: 'yang', trader: '杨鹏', price: '10.005', fee: '0' }),
    trade({
      id: 'li',
      trader: '李明',
      price: '10.014',
      fee: '0.03',
      trade_time: '09:31:00',
      created_at: '2026-10-01T01:31:00.000Z',
    }),
  ], new Map([
    ['600519.SH', quote('10.014', '2026-10-17', 'fresh')],
  ]));
  const yang = positions.find((row) => row.trader === '杨鹏');
  const li = positions.find((row) => row.trader === '李明');

  assert.equal(positions.length, 2);
  assert.equal(yang.current_price, li.current_price);
  assert.equal(yang.price_as_of, '2026-10-17');
  assert.equal(li.price_as_of, '2026-10-17');
  assert.equal(yang.price_source, 'tsp_kline_daily');
  assert.equal(li.price_source, 'tsp_kline_daily');
  assert.equal(yang.cost_amount, 10.01);
  assert.equal(yang.unrealized_pnl, 0.01);
  assert.equal(yang.return_rate, 0.0009);
  assert.equal(li.cost, 10.044);
  assert.equal(li.cost_amount, 10.04);
  assert.equal(li.market_value, 10.01);
  assert.equal(li.unrealized_pnl, -0.03);
  assert.equal(li.return_rate, -0.002987);
  assert.notEqual(yang.cost_amount, li.cost_amount);
  assert.notEqual(yang.unrealized_pnl, li.unrealized_pnl);
});
