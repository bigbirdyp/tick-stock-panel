# 股票记录小应用 API

本文档约定股票记录小应用的 HTTP JSON 接口,用于记录每日交易、每日复盘,并查询当前持仓与已平仓收益。

## 通用约定

- 请求和响应均使用 `application/json`。
- 日期字段使用 `YYYY-MM-DD` 字符串,例如 `2026-10-12`。
- 股票代码字段使用交易所通用代码字符串,例如 `600519`、`000001`。
- 价格、成本、盈亏金额默认单位为人民币元。
- 数量字段 `quantity` 默认单位为股。
- 收益率字段 `return_rate` 使用小数制,例如 `0.1234` 表示 `12.34%`。
- 买卖方向字段 `side` 取值为 `buy` 或 `sell`,分别表示买入和卖出。

通用错误响应:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "date 必须是 YYYY-MM-DD 格式"
  }
}
```

## POST /api/records

保存一条每日交易记录。

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 是 | 交易日期,格式为 `YYYY-MM-DD` |
| `code` | string | 是 | 股票代码 |
| `name` | string | 是 | 股票名称 |
| `side` | string | 是 | 买卖方向:`buy` 买入,`sell` 卖出 |
| `price` | number | 是 | 成交价格 |
| `quantity` | number | 是 | 成交数量,单位为股 |
| `note` | string | 否 | 备注 |

### 请求示例

```json
{
  "date": "2026-10-12",
  "code": "600519",
  "name": "贵州茅台",
  "side": "buy",
  "price": 1688.5,
  "quantity": 100,
  "note": "突破前高后小仓位试单"
}
```

### 响应示例

```json
{
  "data": {
    "date": "2026-10-12",
    "code": "600519",
    "name": "贵州茅台",
    "side": "buy",
    "price": 1688.5,
    "quantity": 100,
    "note": "突破前高后小仓位试单"
  }
}
```

## GET /api/records

按日期查询交易记录。

### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 是 | 交易日期,格式为 `YYYY-MM-DD` |

### 请求示例

```http
GET /api/records?date=2026-10-12
```

### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | string | 交易日期 |
| `records` | array | 当日交易记录列表 |
| `records[].code` | string | 股票代码 |
| `records[].name` | string | 股票名称 |
| `records[].side` | string | 买卖方向:`buy` 或 `sell` |
| `records[].price` | number | 成交价格 |
| `records[].quantity` | number | 成交数量,单位为股 |
| `records[].note` | string | 备注 |

### 响应示例

```json
{
  "data": {
    "date": "2026-10-12",
    "records": [
      {
        "code": "600519",
        "name": "贵州茅台",
        "side": "buy",
        "price": 1688.5,
        "quantity": 100,
        "note": "突破前高后小仓位试单"
      },
      {
        "code": "000001",
        "name": "平安银行",
        "side": "sell",
        "price": 11.26,
        "quantity": 1000,
        "note": "止盈减仓"
      }
    ]
  }
}
```

## POST /api/reviews

保存一条每日复盘。

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 是 | 复盘日期,格式为 `YYYY-MM-DD` |
| `content` | string | 是 | 复盘正文 |
| `tags` | string[] | 否 | 标签列表 |

### 请求示例

```json
{
  "date": "2026-10-12",
  "content": "指数缩量震荡,高位题材分歧加大。明日重点观察成交量能否恢复,以及金融、消费方向是否继续承接资金。",
  "tags": ["缩量", "题材分歧", "等待确认"]
}
```

### 响应示例

```json
{
  "data": {
    "date": "2026-10-12",
    "content": "指数缩量震荡,高位题材分歧加大。明日重点观察成交量能否恢复,以及金融、消费方向是否继续承接资金。",
    "tags": ["缩量", "题材分歧", "等待确认"]
  }
}
```

## GET /api/reviews

查询每日复盘列表。传入 `date` 时返回指定日期复盘;不传时返回全部复盘,按日期倒序排列。

### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 否 | 复盘日期,格式为 `YYYY-MM-DD` |

### 请求示例

```http
GET /api/reviews?date=2026-10-12
```

### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `reviews` | array | 复盘列表 |
| `reviews[].date` | string | 复盘日期 |
| `reviews[].content` | string | 复盘正文 |
| `reviews[].tags` | string[] | 标签列表 |

### 响应示例

```json
{
  "data": {
    "reviews": [
      {
        "date": "2026-10-12",
        "content": "指数缩量震荡,高位题材分歧加大。明日重点观察成交量能否恢复,以及金融、消费方向是否继续承接资金。",
        "tags": ["缩量", "题材分歧", "等待确认"]
      }
    ]
  }
}
```

## GET /api/positions/current

返回当前持仓。当前持仓由交易记录汇总得到,未完全卖出的标的会出现在本接口中。

### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `positions` | array | 当前持仓列表 |
| `positions[].code` | string | 股票代码 |
| `positions[].name` | string | 股票名称 |
| `positions[].quantity` | number | 当前持仓数量,单位为股 |
| `positions[].cost` | number | 持仓成本价 |
| `positions[].current_price` | number | 当前价格 |
| `positions[].cost_amount` | number | 持仓成本金额 |
| `positions[].market_value` | number | 当前市值 |
| `positions[].unrealized_pnl` | number | 浮动盈亏金额 |
| `positions[].return_rate` | number | 收益率,小数制 |

### 响应示例

```json
{
  "data": {
    "positions": [
      {
        "code": "600519",
        "name": "贵州茅台",
        "quantity": 100,
        "cost": 1688.5,
        "current_price": 1712.3,
        "cost_amount": 168850,
        "market_value": 171230,
        "unrealized_pnl": 2380,
        "return_rate": 0.0141
      }
    ]
  }
}
```

## GET /api/positions/history

返回已平仓历史持仓收益。已平仓持仓指买入数量已被卖出记录完全抵扣的交易批次或汇总头寸。

### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `positions` | array | 已平仓历史持仓列表 |
| `positions[].code` | string | 股票代码 |
| `positions[].name` | string | 股票名称 |
| `positions[].open_date` | string | 开仓日期 |
| `positions[].close_date` | string | 平仓日期 |
| `positions[].quantity` | number | 平仓数量,单位为股 |
| `positions[].cost` | number | 持仓成本价 |
| `positions[].exit_price` | number | 平仓价格 |
| `positions[].cost_amount` | number | 持仓成本金额 |
| `positions[].exit_amount` | number | 平仓成交金额 |
| `positions[].realized_pnl` | number | 已实现盈亏金额 |
| `positions[].return_rate` | number | 收益率,小数制 |
| `positions[].holding_days` | number | 持仓自然日天数 |

### 响应示例

```json
{
  "data": {
    "positions": [
      {
        "code": "000001",
        "name": "平安银行",
        "open_date": "2026-09-28",
        "close_date": "2026-10-12",
        "quantity": 1000,
        "cost": 10.8,
        "exit_price": 11.26,
        "cost_amount": 10800,
        "exit_amount": 11260,
        "realized_pnl": 460,
        "return_rate": 0.0426,
        "holding_days": 14
      }
    ]
  }
}
```
