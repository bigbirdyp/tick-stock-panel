# 股票记录小应用 API（设计契约）

> 状态：拟议、未实现。本文只约定目标 HTTP JSON 契约，不代表当前 FastAPI、Vite 或任何 Node 服务已经提供这些接口。
>
> 范围：交易记录、每日复盘、当前持仓和已实现收益。不包含每日选股、荐股或 AI 自动生成选股资源。

本文档用于前端、后端和文档评审对齐。所有字段、错误码和计算口径都应按本契约实现后再对外声明可用。

## 1. 服务边界

### 1.1 路由与运行形态

- 公共 HTTP 路径统一挂在同源 `/api` 下，例如 `/api/records`。浏览器只请求同源 `/api`，不得直接访问 Node 服务 origin。
- 拟议 Node 服务代码目录为 `backend/trade-journal-node/`。Node 进程在开发态监听 `http://127.0.0.1:3022`；该地址只作为本机开发代理目标，对浏览器客户端保持私有，不得作为前端 `baseURL` 或公开 API origin。
- 开发态可实现的路由拆分（拟议，未要求当前 `vite.config.ts` 已经配置）：浏览器继续请求同源 `/api`；Vite 开发代理仅把本文列出的交易记录、每日复盘和持仓路径转发到 `127.0.0.1:3022` 的 Node 服务，具体包括 `/api/records`、`/api/records/*`、`/api/reviews`、`/api/reviews/*`、`/api/positions/current` 和 `/api/positions/history`；其余既有 `/api` 路径（以及 `/health` 等现有代理项）继续转发到 FastAPI，不经过 Node。
- 本契约不要求、也不假设 FastAPI（`backend/app/`）增加转发路由。开发联调以 Vite 路径拆分为准；生产或 Docker 应用同一同源 `/api` 规则：本文路径落到 Node，其余仍由 FastAPI 处理，且不得让浏览器侧同时出现 Node 与 FastAPI 两个公开 API origin。

### 1.2 认证边界

- 本契约不定义登录、会话或多用户隔离 API。v1 按本地单用户记录本设计，不接受客户端传入 `user_id`、`owner_id` 或类似身份字段。未来若增加多用户，需另行扩展认证与数据隔离契约。
- 开发态 Vite 把本文路径直连 Node 时，请求不经过 FastAPI，因此不能继承 FastAPI 现有的访问密码、会话或其他认证中间件。该直连代理只适用于本机开发，不得当作可对外暴露的认证边界。
- 生产或任何对外暴露形态：必须在反向代理、网关或与 FastAPI 等价的认证边界之后再挂载本文路径；认证失败使用本文错误 envelope 返回 `401` 或 `403`。Node 的 `3022`（或等价内网地址）仍不得对浏览器公开。

## 2. 通用约定

### 2.1 请求与响应

- 请求体和响应体均使用 `application/json; charset=utf-8`。
- 成功响应统一使用顶层 `data`，可选使用顶层 `meta`，结构固定为 `{ "data": ..., "meta": { "duplicate": boolean } }`。`meta` 不放在 `data` 内。
- `meta` 只承载不会改变资源 schema 的响应元信息。当前唯一字段是 `duplicate`；`meta` 省略时客户端必须按 `{ "duplicate": false }` 处理。
- 新建资源成功返回 `201`，且默认省略 `meta`。使用 `client_request_id` 命中完全相同的幂等重复创建时返回 `200`，并必须返回 `"meta": { "duplicate": true }`。
- 列表响应的分页信息放在 `data.pagination`，不使用 `meta.pagination`。
- 未特别说明时，响应中的可选文本字段使用 `null` 表示缺失，不用空字符串伪装缺失。
- 所有 ID 都是服务端生成的不透明稳定字符串。客户端不得解析 ID 结构、按 ID 排序或自行生成资源 ID。

幂等重复创建的成功响应示例：

```json
{
  "data": {
    "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
    "version": 1
  },
  "meta": {
    "duplicate": true
  }
}
```

### 2.2 股票标识

- 创建和更新交易记录时，客户端提交 `code`，格式为六位 A 股代码字符串，例如 `600519`、`000001`。
- 服务端必须把 `code` 解析为标准 `symbol`，例如 `600519.SH`、`000001.SZ`，并在响应中同时返回 `code` 和 `symbol`。
- `code` 只允许 `^[0-9]{6}$`。如客户端额外提交 `symbol`，服务端应忽略它或校验它与 `code` 的解析结果一致；不一致时返回 `422 VALIDATION_ERROR`。
- 无法解析交易所或资产类型时返回 `422 INVALID_STOCK_CODE`，不得猜测交易所，也不得把无法识别的代码错配到行情。
- `name` 是显示名称，不参与身份匹配。持仓和收益计算以 `symbol` 为准。

### 2.3 日期、时间与时区

- 日期字段使用 `YYYY-MM-DD`，必须是真实日历日期，例如 `2026-02-29` 无效。
- 交易记录的 `trade_date` 和复盘的 `date` 按 `Asia/Shanghai` 自然日解释。接口不接受服务器本地时区作为隐式业务时区。
- `trade_date` 不强制必须是 A 股交易日，因为用户可能补录停牌、盘后或历史更正记录；需要按交易日取行情时，行情源应单独返回价格状态。
- `as_of` 表示按 `Asia/Shanghai` 日期截止计算持仓，包含 `trade_date <= as_of` 的记录。
- 时间戳字段使用 ISO 8601 字符串并带时区偏移，例如 `2026-10-12T15:04:05+08:00`。
- `trade_time` 可选，格式为 `HH:mm:ss`，按 `Asia/Shanghai` 当日墙钟解释；为 `null` 时同日内排序退回到 `created_at` 和 `id`。
- `holding_days` 是自然日差值：`close_date - open_date`，同日开平为 `0`。本文不把它定义为交易日数量。

### 2.4 数值、单位与精度

| 字段类型 | JSON 类型 | 范围 | 精度与单位 |
| --- | --- | --- | --- |
| 价格字段 | number | `> 0` 且 `<= 1000000` | 人民币元，最多 4 位小数 |
| 金额字段 | number | `>= 0`，盈亏字段可为负 | 人民币元，响应四舍五入到 2 位小数 |
| 数量字段 | integer | `>= 1` 且 `<= 1000000000` | 股，不支持小数股 |
| 费税字段 | number | `>= 0` 且 `<= 100000000` | 人民币元，最多 2 位小数 |
| 收益率字段 | number 或 null | 无固定上下限 | 小数制，响应四舍五入到 6 位小数，`0.123456` 表示 `12.3456%` |

- 服务端内部计算应使用十进制定点数，不用二进制浮点作为持久化口径。
- `fee` 表示佣金、过户费等交易费用合计；`tax` 表示印花税等税费。缺省均为 `0`。
- `gross_amount = price * quantity`。
- 买入现金流成本为 `gross_amount + fee + tax`。卖出净回收金额为 `gross_amount - fee - tax`。

### 2.5 分页、排序与空列表

- 列表接口统一支持 `limit` 和 `offset`。
- `limit` 默认 `50`，最小 `1`，最大 `200`。超过最大值返回 `422 VALIDATION_ERROR`，不自动截断。
- `offset` 默认 `0`，必须为 `>= 0` 的整数。
- 列表响应包含精确 `total` 和 `has_more`。空结果返回空数组、`total: 0`、`has_more: false`，不返回 `404`。
- 每个列表接口必须在自己的章节列出所有 `sort` 选项的完整排序键。排序键必须确定；业务字段相同后必须追加稳定的时间和 ID 后缀。
- 对可为空的排序字段，无论升序还是降序，`null` 都排在最后。
- 对同一份未变化的数据集，相同查询参数必须返回相同顺序；分页页码不能因为未定义排序而漂移。

分页对象：

```json
{
  "limit": 50,
  "offset": 0,
  "total": 1,
  "has_more": false
}
```

### 2.6 错误 envelope

错误响应统一使用：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段校验失败",
    "details": {
      "fields": [
        {
          "path": "trade_date",
          "message": "必须是 YYYY-MM-DD 格式"
        }
      ]
    }
  }
}
```

`details` 可省略；如存在字段级错误，`details.fields[].path` 使用请求 JSON path 或查询参数名。

| HTTP 状态 | 稳定错误码 | 触发场景 |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | JSON 语法错误、`Content-Type` 不支持 |
| `401` | `UNAUTHENTICATED` | 部署层或上游认证要求登录但未登录 |
| `403` | `FORBIDDEN` | 已认证但无权访问该本地记录本 |
| `404` | `NOT_FOUND` | 指定 `id` 不存在或已被删除 |
| `409` | `DUPLICATE_RECORD` | `client_request_id` 与已存在记录冲突 |
| `409` | `DUPLICATE_REVIEW` | 同一日期已存在每日复盘 |
| `409` | `INSUFFICIENT_POSITION` | 卖出、修改或删除会导致指定标的持仓为负 |
| `409` | `VERSION_CONFLICT` | `expected_version` 与当前资源版本不一致 |
| `409` | `CONFLICT` | 资源状态与本次修改冲突但不属于上述专用码 |
| `428` | `PRECONDITION_REQUIRED` | 修改或删除接口缺少必需的 `expected_version` |
| `422` | `VALIDATION_ERROR` | 字段类型、范围、格式或必填项不满足要求 |
| `422` | `INVALID_DATE` | 日期存在但不满足本接口语义，例如 `from > to` |
| `422` | `INVALID_STOCK_CODE` | 股票代码无法规范化为唯一 `symbol` |
| `500` | `INTERNAL_ERROR` | 未预期服务端错误 |

行情不可用不作为持仓列表错误返回；应在价格字段中标记为 `price_status: "unavailable"`。

### 2.7 并发、事务与版本

- 可变资源响应必须包含 `version`。`version` 是从 `1` 开始的整数，每次成功修改资源时递增；创建和幂等重复创建不会为同一资源额外递增版本。
- `PATCH` 请求体必须包含 `expected_version`；`DELETE` 请求必须以查询参数 `expected_version` 传入同名整数。缺失时返回 `428 PRECONDITION_REQUIRED`。
- 如果资源存在但当前 `version` 与 `expected_version` 不一致，返回 `409 VERSION_CONFLICT`，不得执行本次修改，也不得使用隐式 last-write-wins。
- 如果资源已被其他请求删除，后续按 ID 修改或删除返回 `404 NOT_FOUND`。
- 所有影响同一 `symbol` 持仓路径的 `POST /api/records`、`PATCH /api/records/{id}` 和 `DELETE /api/records/{id}` 必须在同一个原子事务或等价的串行化临界区内执行。事务内必须重新规范化代码、检查幂等键、检查版本前置条件、重跑 FIFO/no-short 校验，并在同一提交边界内写入记录和失效或重建派生持仓视图。
- 当 `PATCH` 会改变 `symbol` 时，事务必须同时覆盖旧 `symbol` 和新 `symbol`；实现可按字典序锁定两个 symbol，避免并发死锁。
- 对同一记录的并发修改或删除，只有一个请求能先提交；后提交请求必须基于最新 `version` 重新提交。

## 3. 交易记录资源

### 3.1 TradeRecord schema

| 字段 | 类型 | 必填 | 可为空 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 响应必有 | 否 | 稳定记录 ID，例如 `rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C` |
| `version` | integer | 响应必有 | 否 | 资源版本，从 `1` 开始，每次成功修改递增 |
| `trade_date` | string | 是 | 否 | 交易日期，`YYYY-MM-DD` |
| `trade_time` | string | 否 | 是 | 成交时间，`HH:mm:ss`；未知时为 `null` |
| `code` | string | 是 | 否 | 六位代码 |
| `symbol` | string | 响应必有 | 否 | 服务端规范化后的标准标的 |
| `name` | string | 是 | 否 | 显示名称，1 到 64 个字符 |
| `side` | string | 是 | 否 | `buy` 或 `sell` |
| `price` | number | 是 | 否 | 成交价格 |
| `quantity` | integer | 是 | 否 | 成交数量，单位为股 |
| `fee` | number | 否 | 否 | 交易费用，默认 `0` |
| `tax` | number | 否 | 否 | 税费，默认 `0` |
| `note` | string | 否 | 是 | 备注，最长 1000 个字符 |
| `client_request_id` | string | 否 | 是 | 客户端防重复提交键，最长 80 个字符 |
| `created_at` | string | 响应必有 | 否 | 创建时间戳 |
| `updated_at` | string | 响应必有 | 否 | 最近更新时间戳 |

### 3.2 创建记录：POST /api/records

创建一条交易记录。新建成功返回 `201`。

请求字段同 `TradeRecord` 中客户端可写字段：`trade_date`、`trade_time`、`code`、`name`、`side`、`price`、`quantity`、`fee`、`tax`、`note`、`client_request_id`。

重复提交语义：

- `client_request_id` 缺失时，经济字段完全相同的多笔记录仍允许创建，因为用户可能拆单成交。
- `client_request_id` 已存在且规范化请求体完全一致时，返回 `200` 和已存在记录，并返回顶层 `"meta": { "duplicate": true }`。该响应不是新建，不递增 `version`。
- `client_request_id` 已存在但请求体不同，返回 `409 DUPLICATE_RECORD`。
- 创建卖出记录会在同一事务内按第 6 节口径预演持仓；若导致负持仓，返回 `409 INSUFFICIENT_POSITION`。

请求示例：

```json
{
  "trade_date": "2026-10-12",
  "trade_time": "10:35:12",
  "code": "600519",
  "name": "贵州茅台",
  "side": "buy",
  "price": 1688.5,
  "quantity": 100,
  "fee": 5,
  "tax": 0,
  "note": "突破前高后小仓位试单",
  "client_request_id": "web-20261012-0001"
}
```

`201` 新建响应示例：

```json
{
  "data": {
    "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
    "version": 1,
    "trade_date": "2026-10-12",
    "trade_time": "10:35:12",
    "code": "600519",
    "symbol": "600519.SH",
    "name": "贵州茅台",
    "side": "buy",
    "price": 1688.5,
    "quantity": 100,
    "fee": 5,
    "tax": 0,
    "note": "突破前高后小仓位试单",
    "client_request_id": "web-20261012-0001",
    "created_at": "2026-10-12T10:35:30+08:00",
    "updated_at": "2026-10-12T10:35:30+08:00"
  }
}
```

`200` 幂等重复响应示例：

```json
{
  "data": {
    "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
    "version": 1,
    "trade_date": "2026-10-12",
    "trade_time": "10:35:12",
    "code": "600519",
    "symbol": "600519.SH",
    "name": "贵州茅台",
    "side": "buy",
    "price": 1688.5,
    "quantity": 100,
    "fee": 5,
    "tax": 0,
    "note": "突破前高后小仓位试单",
    "client_request_id": "web-20261012-0001",
    "created_at": "2026-10-12T10:35:30+08:00",
    "updated_at": "2026-10-12T10:35:30+08:00"
  },
  "meta": {
    "duplicate": true
  }
}
```

### 3.3 查询记录列表：GET /api/records

查询交易记录列表。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 否 | 等于某个 `trade_date` |
| `from` | string | 否 | 起始 `trade_date`，包含 |
| `to` | string | 否 | 结束 `trade_date`，包含 |
| `code` | string | 否 | 六位代码过滤 |
| `side` | string | 否 | `buy` 或 `sell` |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `trade_date_desc` 或 `trade_date_asc`，默认 `trade_date_desc` |

排序规则：

- `trade_date_desc`：`trade_date desc, trade_time desc nulls last, created_at desc, id desc`。
- `trade_date_asc`：`trade_date asc, trade_time asc nulls last, created_at asc, id asc`。

响应示例：

```json
{
  "data": {
    "records": [
      {
        "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
        "version": 1,
        "trade_date": "2026-10-12",
        "trade_time": "10:35:12",
        "code": "600519",
        "symbol": "600519.SH",
        "name": "贵州茅台",
        "side": "buy",
        "price": 1688.5,
        "quantity": 100,
        "fee": 5,
        "tax": 0,
        "note": "突破前高后小仓位试单",
        "client_request_id": "web-20261012-0001",
        "created_at": "2026-10-12T10:35:30+08:00",
        "updated_at": "2026-10-12T10:35:30+08:00"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "has_more": false
    }
  }
}
```

### 3.4 查询单条记录：GET /api/records/{id}

按稳定 ID 查询交易记录。不存在时返回 `404 NOT_FOUND`。

### 3.5 修改记录：PATCH /api/records/{id}

部分更新一条交易记录。至少提交一个可写字段，并必须提交 `expected_version`。`expected_version` 只用于并发前置检查，不写入资源。`id`、`version`、`symbol`、`created_at`、`updated_at` 不可由客户端直接修改。

可写字段：`trade_date`、`trade_time`、`code`、`name`、`side`、`price`、`quantity`、`fee`、`tax`、`note`、`client_request_id`。

修改会在同一事务内重新计算受影响 `symbol` 的全量持仓路径；若修改后任一时点出现负持仓，返回 `409 INSUFFICIENT_POSITION`，原记录保持不变。成功后返回更新后的完整 `TradeRecord`，`version` 递增。

请求示例：

```json
{
  "expected_version": 1,
  "price": 1686.2,
  "note": "修正成交均价"
}
```

### 3.6 删除记录：DELETE /api/records/{id}

删除一条交易记录。必须传入 `expected_version` 查询参数。成功返回 `204` 且无响应体。

请求示例：

```http
DELETE /api/records/rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C?expected_version=1
```

删除会在同一事务内预演该标的剩余记录的持仓路径；如果删除一笔买入会导致后续卖出无可匹配持仓，返回 `409 INSUFFICIENT_POSITION`，原记录保持不变。客户端应先删除或修改依赖该买入的卖出记录。

## 4. 每日复盘资源

### 4.1 DailyReview schema

| 字段 | 类型 | 必填 | 可为空 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 响应必有 | 否 | 稳定复盘 ID，例如 `rev_01HZY9QX6M5X7ER2DK2H9K6B8V` |
| `version` | integer | 响应必有 | 否 | 资源版本，从 `1` 开始，每次成功修改递增 |
| `date` | string | 是 | 否 | 复盘日期，`YYYY-MM-DD` |
| `content` | string | 是 | 否 | 复盘正文，1 到 20000 个字符 |
| `tags` | string[] | 否 | 否 | 标签列表，默认 `[]`；每个标签 1 到 30 个字符，最多 20 个 |
| `created_at` | string | 响应必有 | 否 | 创建时间戳 |
| `updated_at` | string | 响应必有 | 否 | 最近更新时间戳 |

同一 `date` 只允许一条每日复盘。需要修改正文时使用 `PATCH /api/reviews/{id}`。

### 4.2 创建复盘：POST /api/reviews

成功创建返回 `201`。同一日期已存在复盘时返回 `409 DUPLICATE_REVIEW`。

请求示例：

```json
{
  "date": "2026-10-12",
  "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
  "tags": ["缩量", "题材分歧", "等待确认"]
}
```

响应示例：

```json
{
  "data": {
    "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8V",
    "version": 1,
    "date": "2026-10-12",
    "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
    "tags": ["缩量", "题材分歧", "等待确认"],
    "created_at": "2026-10-12T20:20:00+08:00",
    "updated_at": "2026-10-12T20:20:00+08:00"
  }
}
```

### 4.3 查询复盘列表：GET /api/reviews

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 否 | 等于某个复盘日期 |
| `from` | string | 否 | 起始日期，包含 |
| `to` | string | 否 | 结束日期，包含 |
| `tag` | string | 否 | 按单个标签过滤 |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `date_desc` 或 `date_asc`，默认 `date_desc` |

排序规则：

- `date_desc`：`date desc, created_at desc, id desc`。
- `date_asc`：`date asc, created_at asc, id asc`。

响应示例：

```json
{
  "data": {
    "reviews": [
      {
        "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8V",
        "version": 1,
        "date": "2026-10-12",
        "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
        "tags": ["缩量", "题材分歧", "等待确认"],
        "created_at": "2026-10-12T20:20:00+08:00",
        "updated_at": "2026-10-12T20:20:00+08:00"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "has_more": false
    }
  }
}
```

### 4.4 查询、修改和删除单条复盘

- `GET /api/reviews/{id}`：按 ID 查询复盘，不存在时返回 `404 NOT_FOUND`。
- `PATCH /api/reviews/{id}`：可修改 `date`、`content`、`tags`，请求体必须包含 `expected_version`。若新 `date` 与另一条复盘冲突，返回 `409 DUPLICATE_REVIEW`；若版本不匹配，返回 `409 VERSION_CONFLICT`。
- `DELETE /api/reviews/{id}?expected_version=1`：删除复盘。成功返回 `204` 且无响应体；版本不匹配时返回 `409 VERSION_CONFLICT`。

## 5. 行情价格字段

持仓接口可能需要行情价格，但本契约不声称实时行情一定可用。

| 字段 | 类型 | 可为空 | 说明 |
| --- | --- | --- | --- |
| `current_price` | number | 是 | 用于估算当前市值的最近价格；不可用时为 `null` |
| `price_source` | string | 是 | 行情来源标识，例如 `tickflow`、`fuyao`、`local_daily`；不可用时为 `null` |
| `price_as_of` | string | 是 | 价格对应时间戳，ISO 8601；不可用时为 `null` |
| `price_status` | string | 否 | `fresh`、`stale` 或 `unavailable` |

语义：

- `fresh`：价格来源声明覆盖 `as_of` 对应交易时点，或是该日期已收盘日线价格。
- `stale`：返回了最近一次可得价格，但 `price_as_of` 早于 `as_of` 对应的最近可用交易日。可用它计算展示值，但前端必须显示过期状态。
- `unavailable`：没有可用价格。此时 `current_price`、`price_source`、`price_as_of`、`market_value`、`unrealized_pnl` 和未实现 `return_rate` 均为 `null`。

## 6. 持仓与收益计算口径

### 6.1 成交匹配

- 持仓按 `symbol` 独立计算。
- 记录排序为 `trade_date asc, trade_time asc nulls last, created_at asc, id asc`。
- 卖出按 FIFO 消耗最早未卖出的买入 lot。
- 不支持做空。任一卖出数量超过此前未卖出数量时，创建、修改或删除操作返回 `409 INSUFFICIENT_POSITION`。
- 一笔卖出可以消耗多个买入 lot；内部可以有多段 FIFO 匹配批次，但对外历史收益列表必须按卖出记录聚合为一行。

### 6.2 成本、盈亏和收益率

定义：

- 买入 lot 初始成本金额：`buy_price * buy_quantity + buy_fee + buy_tax`。
- 部分卖出消耗成本：`lot_remaining_cost_amount * matched_quantity / lot_remaining_quantity`。
- 卖出净回收金额：`sell_price * sell_quantity - sell_fee - sell_tax`。如果一笔卖出消耗多个 lot，卖出费税按每个 matched quantity 占该卖出总数量的比例分摊；对外历史收益行再把这些内部匹配批次求和。
- 已实现盈亏：`allocated_sell_net_amount - consumed_cost_amount`。
- 已实现收益率：`realized_pnl / consumed_cost_amount`。当 `consumed_cost_amount` 为 `0` 时返回 `null`；正常买入成本不应为 `0`。
- 当前持仓成本金额：所有未卖出 lot 的剩余成本金额之和。
- 当前持仓成本价：`cost_amount / quantity`。当 `quantity` 为 `0` 时该标的不出现在当前持仓。
- 当前市值：`current_price * quantity`。`current_price` 为 `null` 时返回 `null`。
- 未实现盈亏：`market_value - cost_amount`。`market_value` 为 `null` 时返回 `null`。
- 未实现收益率：`unrealized_pnl / cost_amount`。`cost_amount` 为 `0` 或价格不可用时返回 `null`。

当前持仓和历史收益必须使用同一套 FIFO、费税、分摊和舍入口径。

## 7. 持仓接口

### 7.1 当前持仓：GET /api/positions/current

返回 `as_of` 截止的未平仓持仓。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `as_of` | string | 否 | 截止日期，默认请求发生时的 `Asia/Shanghai` 日期 |
| `code` | string | 否 | 六位代码过滤 |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `symbol_asc`、`market_value_desc`、`return_rate_desc`，默认 `symbol_asc` |

排序规则：

- `symbol_asc`：`symbol asc, position_key asc`。
- `market_value_desc`：`market_value desc nulls last, symbol asc, position_key asc`。
- `return_rate_desc`：`return_rate desc nulls last, symbol asc, position_key asc`。

响应字段：

| 字段 | 类型 | 可为空 | 说明 |
| --- | --- | --- | --- |
| `position_key` | string | 否 | 当前持仓稳定键，等于 `symbol` |
| `code` | string | 否 | 六位代码 |
| `symbol` | string | 否 | 标准标的 |
| `name` | string | 否 | 最近一笔相关记录的显示名称 |
| `open_date` | string | 否 | 当前未平仓 lot 中最早买入日期 |
| `quantity` | integer | 否 | 当前持仓股数 |
| `cost` | number | 否 | 当前平均成本价 |
| `cost_amount` | number | 否 | 当前持仓成本金额 |
| `current_price` | number | 是 | 最近价格 |
| `price_source` | string | 是 | 行情来源 |
| `price_as_of` | string | 是 | 价格时间 |
| `price_status` | string | 否 | `fresh`、`stale` 或 `unavailable` |
| `market_value` | number | 是 | 当前市值 |
| `unrealized_pnl` | number | 是 | 未实现盈亏 |
| `return_rate` | number | 是 | 未实现收益率，小数制 |

响应示例：

```json
{
  "data": {
    "as_of": "2026-10-12",
    "positions": [
      {
        "position_key": "600519.SH",
        "code": "600519",
        "symbol": "600519.SH",
        "name": "贵州茅台",
        "open_date": "2026-10-12",
        "quantity": 100,
        "cost": 1688.55,
        "cost_amount": 168855,
        "current_price": 1712.3,
        "price_source": "local_daily",
        "price_as_of": "2026-10-12T15:00:00+08:00",
        "price_status": "fresh",
        "market_value": 171230,
        "unrealized_pnl": 2375,
        "return_rate": 0.014065
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "has_more": false
    }
  }
}
```

价格不可用示例：

```json
{
  "position_key": "600519.SH",
  "code": "600519",
  "symbol": "600519.SH",
  "name": "贵州茅台",
  "open_date": "2026-10-12",
  "quantity": 100,
  "cost": 1688.55,
  "cost_amount": 168855,
  "current_price": null,
  "price_source": null,
  "price_as_of": null,
  "price_status": "unavailable",
  "market_value": null,
  "unrealized_pnl": null,
  "return_rate": null
}
```

### 7.2 历史收益：GET /api/positions/history

返回由卖出记录产生的已实现收益行。部分卖出也会产生历史收益行，即使该标的仍有剩余持仓。对外一笔卖出记录只产生一行历史收益；内部 FIFO 匹配批次不得作为响应行 ID 暴露。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `from` | string | 否 | `close_date` 起始日期，包含 |
| `to` | string | 否 | `close_date` 结束日期，包含 |
| `code` | string | 否 | 六位代码过滤 |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `close_date_desc` 或 `close_date_asc`，默认 `close_date_desc` |

排序规则：

- `close_date_desc`：`close_date desc, sell_trade_time desc nulls last, sell_created_at desc, sell_record_id desc`。
- `close_date_asc`：`close_date asc, sell_trade_time asc nulls last, sell_created_at asc, sell_record_id asc`。

`pagination.total` 表示过滤后的卖出记录行数，不表示内部 FIFO 匹配批次数。

响应字段：

| 字段 | 类型 | 可为空 | 说明 |
| --- | --- | --- | --- |
| `history_id` | string | 否 | 稳定历史收益行 ID，等于 `sell_record_id` |
| `sell_record_id` | string | 否 | 产生该收益的卖出记录 ID |
| `buy_record_ids` | string[] | 否 | 被该卖出消耗的买入记录 ID 去重列表，按首次被消耗顺序排列 |
| `code` | string | 否 | 六位代码 |
| `symbol` | string | 否 | 标准标的 |
| `name` | string | 否 | 卖出记录的显示名称 |
| `open_date` | string | 否 | 被本次卖出消耗的买入 lot 中最早买入日期 |
| `close_date` | string | 否 | 卖出记录的 `trade_date` |
| `quantity` | integer | 否 | 卖出记录数量，等于该行聚合的匹配总数量 |
| `cost` | number | 否 | 聚合平均成本价，等于 `cost_amount / quantity` |
| `exit_price` | number | 否 | 卖出成交价 |
| `cost_amount` | number | 否 | 本次卖出消耗的所有买入 lot 成本金额之和 |
| `exit_amount` | number | 否 | 本次卖出净回收金额，等于卖出总成交额扣除该卖出记录的费税 |
| `realized_pnl` | number | 否 | 已实现盈亏，等于 `exit_amount - cost_amount` |
| `return_rate` | number | 是 | 已实现收益率，小数制，等于 `realized_pnl / cost_amount`；分母为 `0` 时为 `null` |
| `holding_days` | integer | 否 | `close_date - open_date` 的自然日天数，使用最早被消耗买入 lot 的日期 |

响应示例：

```json
{
  "data": {
    "history": [
      {
        "history_id": "rec_01HZZ1H7S4J9T7R5P0A2BV6F9K",
        "sell_record_id": "rec_01HZZ1H7S4J9T7R5P0A2BV6F9K",
        "buy_record_ids": [
          "rec_01HZ8VCY6N4Q6Y7Z4R0ME2P1XA",
          "rec_01HZA9Z4D7Q8R2B1K6V0MN5P3C"
        ],
        "code": "000001",
        "symbol": "000001.SZ",
        "name": "平安银行",
        "open_date": "2026-09-28",
        "close_date": "2026-10-12",
        "quantity": 1000,
        "cost": 10.805,
        "exit_price": 11.26,
        "cost_amount": 10805,
        "exit_amount": 11255,
        "realized_pnl": 450,
        "return_rate": 0.041647,
        "holding_days": 14
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 1,
      "has_more": false
    }
  }
}
```
