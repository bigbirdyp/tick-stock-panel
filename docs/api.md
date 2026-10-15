# 股票记录小应用 API（设计契约）

> 状态：交易日志接口统一由 FastAPI **3018** 接入，经现有访问密码 / 会话认证后反向代理到内部 `backend/trade-journal-node`（仅 `127.0.0.1:3022`）。Vite 全部 `/api` 与 `/health` 均转发到 3018；Docker 单容器管理 FastAPI 与 Node，仅发布 3018。账本仍由 Node 实现，交易记录 `trader`、FIFO 分账、每日复盘 `trader`、`(date, trader)` 唯一性、`review_count` 与 `schema_version` 3 的契约保持不变。正在运行的进程需重启后才采用新路由。
>
> 范围：交易记录、交易者标签统计、每日复盘、当前持仓和已实现收益。不包含每日选股、荐股或 AI 自动生成选股资源。不新增选股类资源。

本文档约定 HTTP JSON 契约与计算口径。交易记录和持仓的行为由 Node 实现；复盘 `trader` 以本文为准，不把旧的「按日期全局唯一」继续当作目标行为。Node 本身不提供认证，必须通过 FastAPI 的公共入口访问。

持久化实现说明（契约口径，非 SQL）：本地 Node 将状态原子写入 JSON 文件 `backend/trade-journal-node/.data/journal.json`；Docker 默认路径为 `/app/data/trade-journal/journal.json`，由现有数据卷持久化。本地文件不会自动复制到 Docker。磁盘形态为顶层 `schema_version`、`records`、`reviews`、`requests`。没有复盘表，也没有 `trader` 列；`trader` 是 `records[]` 与 `reviews[]` 元素上的字符串字段。FIFO 分账只作用于交易记录。迁移规则见 §8。

## 1. 服务边界

### 1.1 路由与运行形态

- 公共 HTTP 路径统一挂在同源 `/api` 下，例如 `/api/records`。浏览器只请求同源 `/api`，不得直接访问 Node 服务 origin。
- Node 服务代码目录为 `backend/trade-journal-node/`，仅监听内部 `http://127.0.0.1:3022`，不得作为前端 `baseURL` 或公开 API origin。`dev.sh` 与 Docker 入口负责启动单个 Node 写入进程，不由 FastAPI reload/lifespan 启动。
- 浏览器继续请求同源 `/api`；Vite 将全部 `/api` 与 `/health` 转到 FastAPI 3018。FastAPI 只将 `/api/records`、`/api/records/{id}`、`/api/reviews`、`/api/reviews/{id}`、`/api/traders`、`/api/positions/current`、`/api/positions/history` 的已定义方法转发给 Node；其他原有 API 仍由 FastAPI 处理。交易日志命名空间中的未知路径、尾斜杠和不支持的方法返回 JSON `404 NOT_FOUND`，不会落到前端 SPA。
- 开发与 Docker 统一经公共 3018 访问。内部端口配置 `TRADE_JOURNAL_PORT`（默认 3022，范围 1..65535，禁止等于 FastAPI 端口）；上游固定 `127.0.0.1`，不接受客户端提供目标。`TRADE_JOURNAL_TIMEOUT_S` 默认 10 秒，可配置为大于 0 且不超过 30 秒。请求体上限 1 MiB，解压后响应体上限 8 MiB。转发不自动重试或跟随重定向；写入超时后应先核对结果，再决定是否重试。

### 1.2 认证边界与 trader 标签语义

- 本契约不定义登录、会话或多用户隔离 API。v1 按本地单用户记录本设计，不接受客户端传入 `user_id`、`owner_id` 或类似身份字段。未来若增加多用户，需另行扩展认证与数据隔离契约。
- `trader` 是账本/核算维度上的**交易者标签**（例如策略名或人名），用于分区 FIFO、过滤记录与持仓统计。它**不是**认证身份，不授予权限，也不构成多用户隔离；服务端不得根据 `trader` 做授权判定。
- 交易日志请求先经过 FastAPI 现有认证规则：未设访问密码时仅本机/内网放行；已设密码时要求有效会话。认证拒绝使用本文错误 envelope：`401 UNAUTHENTICATED`、`403 FORBIDDEN`。普通 FastAPI API 保持原有错误格式。
- Bearer Token 沿用现有网络门禁与 scope，不新增交易日志 scope；不能用 Token 绕过会话规则。转发到 Node 前移除 Cookie 与 Authorization，Node 内部端口不对外发布。

## 2. 通用约定

### 2.1 请求与响应

- 请求体和响应体均使用 `application/json; charset=utf-8`。
- 成功响应统一使用顶层 `data`，可选使用顶层 `meta`，结构固定为 `{ "data": ..., "meta": { "duplicate": boolean } }`。`meta` 不放在 `data` 内。
- `meta` 只承载不会改变资源 schema 的响应元信息。当前唯一字段是 `duplicate`；`meta` 省略时客户端必须按 `{ "duplicate": false }` 处理。
- 新建资源成功返回 `201`，且默认省略 `meta`。使用 `client_request_id` 命中完全相同的幂等重复创建时返回 `200`，并必须返回 `"meta": { "duplicate": true }`。
- 列表响应的分页信息放在 `data.pagination`，不使用 `meta.pagination`。豁免分页的接口必须在对应章节显式声明。
- 未特别说明时，响应中的可选文本字段使用 `null` 表示缺失，不用空字符串伪装缺失。
- 所有 ID 都是服务端生成的不透明稳定字符串。客户端不得解析 ID 结构、按 ID 排序或自行生成资源 ID。

幂等重复创建的成功响应示例：

```json
{
  "data": {
    "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
    "version": 1,
    "trader": "AI选股:atr_pct"
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
- `name` 是显示名称，不参与身份匹配。持仓和收益计算以 `(trader, symbol)` 为准（见 §6）。

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
- 所有派生的金额、成本价、市值、盈亏和收益率：先在内部用精确定点值计算，再在序列化到 JSON 时按上表各自精度独立四舍五入。已舍入的响应字段之间不保证算术恒等；客户端不得用已舍入字段反推另一字段。
- `fee` 表示佣金、过户费等交易费用合计；`tax` 表示印花税等税费。缺省均为 `0`。
- `gross_amount = price * quantity`（内部精确值）。
- 买入现金流成本为 `gross_amount + fee + tax`。卖出净回收金额为 `gross_amount - fee - tax`（均为内部精确值）。

### 2.5 分页、排序与空列表

- 列表接口统一支持 `limit` 和 `offset`，**除非**该接口章节显式声明豁免分页。
- `limit` 默认 `50`，最小 `1`，最大 `200`。超过最大值返回 `422 VALIDATION_ERROR`，不自动截断。
- `offset` 默认 `0`，必须为 `>= 0` 的整数。
- 列表响应包含精确 `total` 和 `has_more`。空结果返回空数组、`total: 0`、`has_more: false`，不返回 `404`。未知但合法的过滤值（例如尚不存在的 `trader` 标签）同样返回空列表，不返回 `404`。
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
          "path": "trader",
          "message": "必填"
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
| `409` | `DUPLICATE_REVIEW` | 另一条复盘已占用同一个 `(date, trader)`；同一日期、不同交易者允许并存 |
| `409` | `INSUFFICIENT_POSITION` | 卖出、修改或删除会导致指定 `(trader, symbol)` 账本持仓为负 |
| `409` | `VERSION_CONFLICT` | `expected_version` 与当前资源版本不一致 |
| `409` | `CONFLICT` | 资源状态与本次修改冲突但不属于上述专用码 |
| `428` | `PRECONDITION_REQUIRED` | 修改或删除接口缺少必需的 `expected_version` |
| `422` | `VALIDATION_ERROR` | 字段类型、范围、格式或必填项不满足要求（含缺失/空白 `trader`） |
| `422` | `INVALID_DATE` | 日期存在但不满足本接口语义，例如 `from > to` |
| `422` | `INVALID_STOCK_CODE` | 股票代码无法规范化为唯一 `symbol` |
| `500` | `INTERNAL_ERROR` | 未预期服务端错误 |
| `502` | `BAD_GATEWAY` | 内部 Node 不可连接、响应非 JSON / 无效 / 超限或返回重定向 |
| `504` | `GATEWAY_TIMEOUT` | 内部 Node 请求超时；写请求可能已生效，应先核对结果 |

行情不可用不作为持仓列表错误返回；应在价格字段中标记为 `price_status: "unavailable"`。

### 2.7 并发、事务与版本

- 可变资源响应必须包含 `version`。`version` 是从 `1` 开始的整数，每次成功修改资源时递增；创建和幂等重复创建不会为同一资源额外递增版本。
- `PATCH` 请求体必须包含 `expected_version`；`DELETE` 请求必须以查询参数 `expected_version` 传入同名整数。缺失时返回 `428 PRECONDITION_REQUIRED`。
- 如果资源存在但当前 `version` 与 `expected_version` 不一致，返回 `409 VERSION_CONFLICT`，不得执行本次修改，也不得使用隐式 last-write-wins。
- 如果资源已被其他请求删除，后续按 ID 修改或删除返回 `404 NOT_FOUND`。删除为硬删除：记录从 `records` 移除，关联的 `requests` 条目一并移除；不保留 tombstone 行。删除成功后同一 `id` 永久 `404`；被释放的 `client_request_id` 可被新记录重新使用。
- 所有影响同一 `(trader, symbol)` 持仓路径的 `POST /api/records`、`PATCH /api/records/{id}` 和 `DELETE /api/records/{id}` 必须在同一个原子事务或等价的串行化临界区内执行。事务内必须重新规范化代码、规范化/校验 `trader`、检查幂等键、检查版本前置条件、重跑该 `(trader, symbol)` 账本的 FIFO/no-short 校验，并在同一提交边界内写入记录和失效或重建派生持仓视图。
- 当 `PATCH` 会改变 `trader` 和/或 `symbol`（经 `code`）时，事务必须同时覆盖旧账本键与新账本键上的全部受影响 `(trader, symbol)` 组合；实现可按 `(trader, symbol)` 字典序锁定多个账本键，避免并发死锁。任一受影响账本在全量时序重放后出现负持仓，则整笔事务失败，返回 `409 INSUFFICIENT_POSITION`，原记录保持不变。
- 对同一记录的并发修改或删除，只有一个请求能先提交；后提交请求必须基于最新 `version` 重新提交。

### 2.8 `trader` 字段校验（统一规则）

下列规则适用于请求体字段 `trader` 与查询参数 `trader`（路径已标明可选的除外）。

| 规则 | 要求 |
| --- | --- |
| JSON 类型 | 必须是 JSON string；`null`、number、boolean、object、array 均返回 `422 VALIDATION_ERROR`，`details.fields[].path` 为 `trader` |
| 必填（写入） | `POST /api/records` 与 `POST /api/reviews` 必须包含 `trader`；缺失返回 `422 VALIDATION_ERROR`，`details.fields[].path` 为 `trader`，字段 `message` 为 `必填`。新建不得缺省成 `未指定` |
| Trim | 写入与查询过滤均先按 ECMAScript `String.prototype.trim`（Unicode 空白）去掉首尾空白，再校验与比较；持久化与响应中的 `trader` 为 trim 后的值 |
| 空白 | trim 后长度为 `0`（空串或仅空白）→ `422 VALIDATION_ERROR` |
| 长度 | trim 后长度必须为 `1` 到 `64`（与 `name` 相同：按 JavaScript 字符串 `.length` / UTF-16 code unit 计数）；超出 → `422` |
| 内容 | 允许 Unicode 文本（含中文、冒号等），例如 `AI选股:atr_pct`、`杨鹏`；不在服务端解释标签语义 |
| 查询过滤 | `GET /api/records`、`GET /api/positions/current`、`GET /api/positions/history`、`GET /api/reviews` 上的 `?trader=` 可选。参数缺省表示该接口不过滤交易者。参数出现时先 trim，再套用空白和长度规则；查询值本身是字符串。重复出现该参数 → `422`。比较是 trim 之后的精确相等，不是前缀或忽略大小写。先按该条件过滤，再计算 `total` 和应用分页。合法但本资源集合没有匹配 → 空列表（`total: 0`），不是 `404`。持仓接口只匹配记录账本；复盘接口只匹配复盘 |
| 不是身份 | 不得映射为 `user_id`；不得因 `trader` 不同而返回 `401`/`403` |

## 3. 交易记录资源

### 3.1 TradeRecord schema

| 字段 | 类型 | 必填 | 可为空 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 响应必有 | 否 | 稳定记录 ID，例如 `rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C` |
| `version` | integer | 响应必有 | 否 | 资源版本，从 `1` 开始，每次成功修改递增 |
| `trader` | string | 是 | 否 | 交易者标签；校验见 §2.8；参与 FIFO 账本键 `(trader, symbol)` |
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
| `client_request_id` | string | 否 | 是 | 客户端防重复提交键，最长 80 个字符；**全局**唯一，不按 `trader` 分区 |
| `created_at` | string | 响应必有 | 否 | 创建时间戳 |
| `updated_at` | string | 响应必有 | 否 | 最近更新时间戳 |

### 3.2 创建记录：POST /api/records

创建一条交易记录。新建成功返回 `201`。

请求字段同 `TradeRecord` 中客户端可写字段：`trader`、`trade_date`、`trade_time`、`code`、`name`、`side`、`price`、`quantity`、`fee`、`tax`、`note`、`client_request_id`。

`trader` 为必填；缺失、类型错误、仅空白或长度不合法时返回 `422 VALIDATION_ERROR`（见 §2.8）。不得缺省为 `未指定`——该字面量只用于 §8 对旧数据的确定性迁移，不作为新建缺省。

重复提交语义：

- `client_request_id` 缺失时，经济字段完全相同的多笔记录仍允许创建，因为用户可能拆单成交。
- `client_request_id` 的键空间是**全局**的：同一 `client_request_id` 不能绑定两条不同记录，即使它们的 `trader` 不同。客户端在相同 `symbol` 下为不同 `trader` 重放提交时，必须自行把请求 ID 作用域包含 `trader`（见 §9 的 hashed key），以避免跨标签误碰撞。全局上限仍为 **80** 个字符（UTF-16 code unit / JS `.length`）；不得把全局上限提高到 160。
- **请求指纹（v1 → v2）**：
  - **v1**（无 `trader` 时的既有实现，对应 `src/store.js` 当前十二元组）：`JSON.stringify([trade_date, trade_time, code, symbol, name, side, price, quantity, fee, tax, note, client_request_id])`。
  - **v2**（含 `trader`）：在上述十二个规范化创建字段之前，把 **trim 后的** `trader` 作为**元素 0** 前置，即 `JSON.stringify([trimmedTrader, trade_date, trade_time, code, symbol, name, side, price, quantity, fee, tax, note, client_request_id])`（共 13 个元素）。其余十二个元素的规范化口径与 v1 完全相同。
  - 指纹记录的是**创建当时**写入 `requests` 的 payload，**不是**记录被 PATCH 后的当前字段快照。
- 幂等命中规则：
  - 对某个已存在的 `client_request_id`，计算本次 POST 的 v2 指纹；若与该键绑定的**原始指纹**完全一致，返回 `200` 与该键绑定记录的**当前**完整 `TradeRecord`（可能已被 PATCH 改过价/量/`trader` 等），并返回顶层 `"meta": { "duplicate": true }`。该响应不是新建，不递增 `version`。
  - 同一键下提交与原始指纹不一致的任何 payload（含不同 `trader`、价格、数量等）→ `409 DUPLICATE_RECORD`。
  - **不得**在 PATCH 改价/改量/`trader` 之后，把“重放原始 POST”误写成 `409`；只要键未换且指纹仍是创建时写入的那份，重放**原始创建 payload**（含当时的 `trader`）必须继续 `200` + `duplicate: true`，响应体为当前记录。
- 迁移前已写入的 `requests` 条目保留原 `key` 与 `recordId`（旧键字面量不变、不按 trader 改名）；§8 只把 v1 十二元组指纹升级为 v2（前置迁移后的 `trader`），不重算经济字段。新写入一律使用 v2 指纹。
- 创建卖出记录会在同一事务内按第 6 节口径、仅在该记录的 `(trader, symbol)` 账本上预演持仓；若导致负持仓，返回 `409 INSUFFICIENT_POSITION`。

请求示例：

```json
{
  "trader": "AI选股:atr_pct",
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
  "client_request_id": "web-AI选股:atr_pct-20261012-0001"
}
```

`201` 新建响应示例：

```json
{
  "data": {
    "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
    "version": 1,
    "trader": "AI选股:atr_pct",
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
    "client_request_id": "web-AI选股:atr_pct-20261012-0001",
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
    "trader": "AI选股:atr_pct",
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
    "client_request_id": "web-AI选股:atr_pct-20261012-0001",
    "created_at": "2026-10-12T10:35:30+08:00",
    "updated_at": "2026-10-12T10:35:30+08:00"
  },
  "meta": {
    "duplicate": true
  }
}
```

缺失 `trader` 的错误示例：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段校验失败",
    "details": {
      "fields": [
        {
          "path": "trader",
          "message": "必填"
        }
      ]
    }
  }
}
```

### 3.3 查询记录列表：GET /api/records

查询交易记录列表。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `trader` | string | 否 | 精确匹配 trim 后的交易者标签；缺省表示返回全部交易者的记录 |
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

`?trader=` 非法时返回 `422`；合法但无匹配记录时返回空 `records` 与 `total: 0`。

响应示例：

```json
{
  "data": {
    "records": [
      {
        "id": "rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C",
        "version": 1,
        "trader": "AI选股:atr_pct",
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
        "client_request_id": "web-AI选股:atr_pct-20261012-0001",
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

按稳定 ID 查询交易记录。响应为完整 `TradeRecord`（含 `trader`）。不存在时返回 `404 NOT_FOUND`。

### 3.5 修改记录：PATCH /api/records/{id}

部分更新一条交易记录。至少提交一个可写字段，并必须提交 `expected_version`。`expected_version` 只用于并发前置检查，不写入资源。`id`、`version`、`symbol`、`created_at`、`updated_at` 不可由客户端直接修改。

可写字段：`trader`、`trade_date`、`trade_time`、`code`、`name`、`side`、`price`、`quantity`、`fee`、`tax`、`note`、`client_request_id`。

`trader` 若出现在请求体中，必须通过 §2.8；不得写成 `null` 或空白。

修改会在同一事务内重新计算所有受影响 `(trader, symbol)` 账本的全量持仓路径：

- 若仅改经济字段且 `trader`/`symbol` 不变：重放该账本。
- 若 `trader` 和/或 `symbol` 变化：先从旧账本移除该记录的效果，再纳入新账本，并对旧、新账本分别做 FIFO/no-short 全量校验。任一账本失败 → `409 INSUFFICIENT_POSITION`，整笔不提交。
- **`client_request_id` / `requests` 键迁移（全局唯一性与 422/409 行为不变）**：
  - **键不变**（未提交该字段，或提交值与当前键相同）：该记录已有的 `requests` 条目**保留创建时指纹**；即使本次 PATCH 改了 `price`/`quantity`/`trader`/其他经济字段，也**不得**用当前记录重算或覆盖原指纹。之后重放**原始 POST payload**（含创建时的 `trader`）→ `200` + `duplicate: true`，响应为**当前**记录；其他 payload → `409`。
  - **键从 A 改为 B**（A、B 均非空且 A ≠ B）：
    - 若全局已存在键 B 且其 `recordId` 指向**本记录**：直接**复用**该已有 `requests` 条目及其**原始指纹**；不得再写入第二条同键条目，也不得用当前快照覆盖该指纹。键 A（若仍指向本记录）及其原始指纹继续保留。之后用 A 的原始 payload 或与已复用 B 条目指纹匹配的 payload 重放均可 `200` + `duplicate: true`。典型场景：A→B→A 循环改键（与当前 `store.js`：同记录已有键则跳过 push 一致）。
    - 若全局已存在键 B 且其 `recordId` 指向**另一条记录**：`409 DUPLICATE_RECORD`，整笔不提交。
    - 若全局尚不存在键 B：**保留**键 A 及其原始指纹；**新增**键 B，B 的指纹为 PATCH **提交后当前记录快照**的 v2 指纹；两条 `requests` 的 `recordId` 都指向本记录。之后用 A 的原始 payload 或与 B 指纹匹配的 payload 重放均可 `200` + `duplicate: true`。
  - **键从空/`null` 改为 B**：
    - 若 B 已绑定本记录：复用其原始指纹（不覆盖、不重复写入）。
    - 若 B 绑定其他记录：`409 DUPLICATE_RECORD`。
    - 若 B 不存在：新增键 B，指纹为 PATCH 后当前记录快照的 v2 指纹。
  - **键改为 `null`**：删除该 `recordId` 下**全部** `requests` 条目（释放曾绑定到该记录的所有键，含历史 A/B）。
  - `client_request_id` 字段本身若出现在请求体中，须通过既有类型/长度校验（最长 80）；非法 → `422 VALIDATION_ERROR`。
- 成功后返回更新后的完整 `TradeRecord`，`version` 递增；`updated_at` 更新。记录上的 `client_request_id` 字段反映最近一次写入的键（或 `null`）；`requests` 可因首次改到新键而保留多条历史键，也可因改回已绑定本记录的旧键而复用既有条目。

请求示例（修正价格）：

```json
{
  "expected_version": 1,
  "price": 1686.2,
  "note": "修正成交均价"
}
```

请求示例（变更交易者标签，需通过旧/新账本校验）：

```json
{
  "expected_version": 2,
  "trader": "杨鹏"
}
```

### 3.6 删除记录：DELETE /api/records/{id}

删除一条交易记录。必须传入 `expected_version` 查询参数。成功返回 `204` 且无响应体。

请求示例：

```http
DELETE /api/records/rec_01HZY9K0V8J6K7Y2VQ4B6N9M3C?expected_version=1
```

删除会在同一事务内、仅在该记录所属 `(trader, symbol)` 账本上预演剩余记录的持仓路径；如果删除一笔买入会导致后续卖出无可匹配持仓，返回 `409 INSUFFICIENT_POSITION`，原记录保持不变。客户端应先删除或修改依赖该买入的卖出记录。

删除成功后的持久化效果：

- 从 `records` 硬删除该行（无 tombstone）。
- 删除所有 `recordId` 指向该记录的 `requests` 条目，从而释放其 `client_request_id`。
- `reviews` 与其他记录的 `id`/`version`/`client_request_id` 不变。删除记录不修改复盘的 `trader`。
- 若删除后该标签的 `record_count` 与 `review_count` 都为 0，后续 `GET /api/traders` 不再列出它。若该标签仍有复盘，条目保留，`record_count` 为 `0`，`review_count` ≥ 1。
- 派生当前持仓与历史收益按剩余记录重算；已删除卖出对应的历史行不再出现。

### 3.7 交易者列表：GET /api/traders

返回 `records` 与 `reviews` 中**实际出现过**的 `trader` 标签并集。同一个标签只出现一次。本接口**豁免分页**：不接受 `limit`/`offset`/`sort`、`trader` 或任何其他查询参数；传入不支持的查询参数返回 `422 VALIDATION_ERROR`。无 `meta`。

两个计数分开，都是未删除资源的条数：

- `record_count`：该标签下的交易记录条数，可以为 `0`。
- `review_count`：该标签下的每日复盘条数，可以为 `0`。

二者都是大于等于 `0` 的整数，且不能同时为 `0`。标签只来自现存记录或复盘；不预置从未出现的标签。`records` 与 `reviews` 都为空时，`traders` 为空数组。只有复盘、没有记录的标签仍然列出，此时 `record_count` 为 `0`。只有记录、没有复盘的标签仍然列出，此时 `review_count` 为 `0`。

删除效果：

- 删光某标签的记录后，若其 `review_count` 仍 ≥ 1，条目保留且 `record_count` 为 `0`。
- 删光某标签的复盘后，若其 `record_count` 仍 ≥ 1，条目保留且 `review_count` 为 `0`。
- 两个计数都变成 `0` 时，该标签从列表消失。
- 新建一条该标签此前不存在的复盘或记录后，标签出现；另一侧计数为 `0`。

响应 envelope（顺序是标签的 UTF-16 code unit 升序，不是记录数序）：

```json
{
  "data": {
    "traders": [
      {
        "trader": "AI选股:atr_pct",
        "record_count": 3,
        "review_count": 1
      },
      {
        "trader": "未指定",
        "record_count": 1,
        "review_count": 2
      },
      {
        "trader": "李四",
        "record_count": 0,
        "review_count": 1
      },
      {
        "trader": "杨鹏",
        "record_count": 2,
        "review_count": 0
      }
    ]
  }
}
```

上例里 `未指定`（U+672A）在 `李四`（U+674E）和 `杨鹏`（U+6768）之前，因为比较的是码元而不是拼音或笔画。`AI选股:atr_pct` 以 `A`（U+0041）开头，排在三者之前。

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `traders` | array | 记录与复盘标签的并集 |
| `traders[].trader` | string | 标签字面量（已 trim） |
| `traders[].record_count` | integer | 该标签下未删除的交易记录条数，`>= 0` |
| `traders[].review_count` | integer | 该标签下未删除的每日复盘条数，`>= 0` |

稳定顺序：按 `trader` 标签字符串做升序排序。比较口径为 JavaScript 字符串的**原始 UTF-16 code unit 序**：对标签数组使用默认 `.sort()`（无 compareFunction），或等价比较器 `a < b` / `a > b`。**不得**使用 `String.prototype.localeCompare`（即使不传 locale 也不等价于 code-unit 序，例如 `'a'` 与 `'Z'`）。全程同一口径，相同标签只出现一次。持仓等列表中作为排序键的字符串字段（如 §7.1 的 `symbol` / `trader` / `position_key`）采用同一 code-unit 升序规则。

本接口不按 `record_count` 或 `review_count` 排序。交易员页签若要按记录数从多到少展示，由客户端自行排序；记录数相同的次序也由客户端决定。

空结果（没有任何交易记录，也没有任何复盘）：

```json
{
  "data": {
    "traders": []
  }
}
```

不返回 `404`。

## 4. 每日复盘资源

### 4.1 DailyReview schema

| 字段 | 类型 | 必填 | 可为空 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 响应必有 | 否 | 稳定复盘 ID，例如 `rev_01HZY9QX6M5X7ER2DK2H9K6B8V` |
| `version` | integer | 响应必有 | 否 | 资源版本，从 `1` 开始，每次成功修改递增 |
| `trader` | string | 是 | 否 | 交易者标签；校验见 §2.8。持久化和响应中的值都是 trim 之后的字符串 |
| `date` | string | 是 | 否 | 复盘日期，`YYYY-MM-DD` |
| `content` | string | 是 | 否 | 复盘正文，1 到 20000 个字符 |
| `tags` | string[] | 否 | 否 | 标签列表，默认 `[]`；每个标签 1 到 30 个字符，最多 20 个 |
| `created_at` | string | 响应必有 | 否 | 创建时间戳 |
| `updated_at` | string | 响应必有 | 否 | 最近更新时间戳 |

唯一键是 `(date, trader)`，比较的 `trader` 是 trim 之后的值。同一日期、同一交易者只允许一条复盘。同一日期、不同交易者可以各有一条。复盘不参与 §6 的 FIFO 账本。修改正文、日期或交易者时使用 `PATCH /api/reviews/{id}`。

### 4.2 创建复盘：POST /api/reviews

成功创建返回 `201`。请求体必须包含 `trader`、`date`、`content`。`trader` 按 §2.8 规范化后写入。缺失、空白或非法的 `trader` 返回 `422 VALIDATION_ERROR`，不得默认为 `未指定`。

`trader` 的 `422` 字段消息与交易记录相同：缺失为 `必填`；JSON 类型不是 string 为 `必须是字符串`；trim 后长度为 0 为 `不能为空白`；trim 后长度超出 1 到 64 为 `长度必须为 1 到 64 个字符`。`null`、number、boolean、object、array 都算类型错误。

唯一性：规范化后的 `(date, trader)` 已被另一条复盘占用时返回 `409 DUPLICATE_REVIEW`，不创建。同一 `date` 配不同 `trader` 返回 `201`。本接口没有 `expected_version`，也没有 `client_request_id` 幂等。

错误优先顺序（先命中者返回，不继续）：

1. JSON 语法错误或 `Content-Type` 不支持 → `400 BAD_REQUEST`。
2. 请求体不是 JSON 对象，或含有 `date`、`content`、`tags`、`trader` 以外的字段 → `422 VALIDATION_ERROR`。
3. 缺少必填字段时按 `date`、`content`、`trader` 的顺序返回第一处 `422`。因此日期和交易者都缺时，`path` 仍是 `date`。
4. 再校验字段格式：`date`、`content`、`tags`、`trader`。
5. 与另一条复盘的 `(date, trader)` 冲突 → `409 DUPLICATE_REVIEW`。

请求示例：

```json
{
  "date": "2026-10-12",
  "trader": "  杨鹏  ",
  "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
  "tags": ["缩量", "题材分歧", "等待确认"]
}
```

响应示例（`trader` 已 trim）：

```json
{
  "data": {
    "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8V",
    "version": 1,
    "date": "2026-10-12",
    "trader": "杨鹏",
    "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
    "tags": ["缩量", "题材分歧", "等待确认"],
    "created_at": "2026-10-12T20:20:00+08:00",
    "updated_at": "2026-10-12T20:20:00+08:00"
  }
}
```

同一天为另一名交易者再创建一条，仍然 `201`：

```json
{
  "date": "2026-10-12",
  "trader": "未指定",
  "content": "迁移前的市场复盘留在未指定名下。"
}
```

再次 `POST` 日期 `2026-10-12` 且 `trader` 为 `杨鹏`（或 trim 后等于 `杨鹏`）时：

```json
{
  "error": {
    "code": "DUPLICATE_REVIEW",
    "message": "该日期下该交易者已有每日复盘"
  }
}
```

缺少 `trader` 时：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段校验失败",
    "details": {
      "fields": [
        {
          "path": "trader",
          "message": "必填"
        }
      ]
    }
  }
}
```

### 4.3 查询复盘列表：GET /api/reviews

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `trader` | string | 否 | 精确匹配 trim 后的交易者标签。参数缺省时返回全部交易者的复盘 |
| `date` | string | 否 | 等于某个复盘日期 |
| `from` | string | 否 | 起始日期，包含 |
| `to` | string | 否 | 结束日期，包含 |
| `tag` | string | 否 | 按单个标签过滤 |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `date_desc` 或 `date_asc`，默认 `date_desc` |

`trader` 与其他条件是逻辑与。过滤在排序和分页之前完成：`pagination.total` 是过滤后的条数，然后才按 `offset`/`limit` 切片。

参数校验沿用列表查询的既有顺序，命中即返回：

1. 不支持的参数，或同一个参数重复出现 → `422 VALIDATION_ERROR`。
2. `date`、`from`、`to` 格式不合法 → `422`。
3. `from > to` → `422 INVALID_DATE`。这一步早于 `trader` 长度校验。
4. `trader` 出现时按 §2.8 做 trim、空白和长度校验。`?trader=`、`?trader=%20` 以及 trim 后超过 64 个 UTF-16 code unit → `422`。通过校验但没有任何复盘使用该标签 → `200`，`reviews: []`，`total: 0`，不是 `404`。
5. 再校验 `tag`、`limit`、`offset`、`sort`。

示例：

- `GET /api/reviews`：不带 `trader`，返回全部复盘。
- `GET /api/reviews?trader=%E6%9D%A8%E9%B9%8F`：只返回 `trader === "杨鹏"` 的复盘。
- `GET /api/reviews?trader=%20%E6%9D%A8%E9%B9%8F%20`：查询值先 trim，结果与上一行相同。
- `GET /api/reviews?trader=%E6%B2%A1%E6%9C%89%E8%BF%99%E4%B8%AA%E4%BA%BA`：标签合法但没有复盘，空列表。
- `GET /api/reviews?date=2026-10-12&trader=%E6%9C%AA%E6%8C%87%E5%AE%9A`：该日期下 `未指定` 的那一条；没有则为空列表。

排序规则：

- `date_desc`：`date desc, created_at desc, id desc`。
- `date_asc`：`date asc, created_at asc, id asc`。

`GET /api/reviews?trader=杨鹏` 的响应示例：

```json
{
  "data": {
    "reviews": [
      {
        "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8V",
        "version": 1,
        "date": "2026-10-12",
        "trader": "杨鹏",
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

不带 `trader` 时，同一天的另一名交易者也会出现。下面两条的 `date` 相同，唯一键仍然不同：

```json
{
  "data": {
    "reviews": [
      {
        "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8V",
        "version": 1,
        "date": "2026-10-12",
        "trader": "杨鹏",
        "content": "指数缩量震荡，高位题材分歧加大。明日重点观察成交量能否恢复。",
        "tags": ["缩量", "题材分歧", "等待确认"],
        "created_at": "2026-10-12T20:21:00+08:00",
        "updated_at": "2026-10-12T20:21:00+08:00"
      },
      {
        "id": "rev_01HZY9QX6M5X7ER2DK2H9K6B8W",
        "version": 1,
        "date": "2026-10-12",
        "trader": "未指定",
        "content": "迁移前的市场复盘留在未指定名下。",
        "tags": [],
        "created_at": "2026-10-12T20:20:00+08:00",
        "updated_at": "2026-10-12T20:20:00+08:00"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 2,
      "has_more": false
    }
  }
}
```

合法但无匹配的标签：

```json
{
  "data": {
    "reviews": [],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "has_more": false
    }
  }
}
```

### 4.4 查询、修改和删除单条复盘

- `GET /api/reviews/{id}`：按 ID 查询完整 `DailyReview`（含 `trader`）。不存在时返回 `404 NOT_FOUND`。此路径不按 `trader` 过滤。
- `PATCH /api/reviews/{id}`：可修改 `trader`、`date`、`content`、`tags`。至少提交一个可写字段，并且必须提交 `expected_version`。`expected_version` 只做并发检查，不写入资源。`id`、`version`、`created_at`、`updated_at` 不能由客户端修改。未提交的 `trader` 保持原值。提交了 `trader` 时必须通过 §2.8，持久化为 trim 后的值，不能写成 `null` 或空白。
- `DELETE /api/reviews/{id}?expected_version=1`：删除复盘。成功返回 `204` 且无响应体。硬删除，无 tombstone。删除接口不接受 `trader`；除单个 `expected_version` 以外的查询参数仍返回 `422 VALIDATION_ERROR`。

`PATCH` 与 `DELETE` 保留现有 `expected_version` 优先顺序。先命中者返回：

1. JSON 语法错误或 `Content-Type` 不支持 → `400 BAD_REQUEST`（仅 `PATCH`）。
2. `PATCH` 请求体不是对象，或含有未知字段 → `422`。`DELETE` 的查询参数不合法或 `expected_version` 重复 → `422`。
3. 缺少 `expected_version` → `428 PRECONDITION_REQUIRED`。这一步早于 `trader`、`date`、`content`、`tags` 的格式校验，也早于 `404`。
4. `PATCH` 除 `expected_version` 外没有可写字段 → `422`。`expected_version` 不是从 `1` 开始的整数 → `422`。
5. 其余字段格式，包括 `trader`，不合法 → `422`。
6. 校验通过后才按 ID 查找。资源不存在 → `404 NOT_FOUND`。
7. 资源存在但 `expected_version` 与当前 `version` 不一致 → `409 VERSION_CONFLICT`。不得写入。此时即使修改后的 `(date, trader)` 会撞车，也仍然返回 `VERSION_CONFLICT`，不返回 `DUPLICATE_REVIEW`。
8. 版本匹配后，只拿**写入之后**的 `(date, trader)` 与其他复盘比较。未改动的那一侧沿用当前值。与自己原来的键相同不是冲突。与另一条复盘冲突 → `409 DUPLICATE_REVIEW`，整笔不提交，`version` 不递增。

成功的 `PATCH` 返回 `200` 和完整复盘，`version` 加 1，`updated_at` 更新，`created_at` 不变。

只改正文（交易者不变）：

```json
{
  "expected_version": 1,
  "content": "修订后的复盘"
}
```

把交易者改到尚未占用该日期的标签：

```json
{
  "expected_version": 2,
  "trader": "验收乙-20261013"
}
```

若 `2026-10-12` 已经有 `杨鹏` 的另一条复盘，则下面的请求在版本匹配时返回 `409 DUPLICATE_REVIEW`：

```json
{
  "expected_version": 2,
  "date": "2026-10-12",
  "trader": "杨鹏"
}
```

同一日期改给另一个还没有复盘的交易者则成功。删除成功后，该复盘的 `review_count` 减 1；若该标签因此两个计数都为 0，`GET /api/traders` 不再列出它。删除复盘不修改交易记录。

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

### 6.1 成交匹配（按交易者分账）

- **假设（待产品确认前作为实现口径）**：每个 `trader` 拥有独立的 FIFO 账本。买入、卖出、禁止做空，以及已实现/当前持仓，均按 `(trader, symbol)` 分区；不同 `trader` 之间的同名 `symbol` **不得**互相消耗 lot。
- 在同一 `(trader, symbol)` 账本内：记录排序为 `trade_date asc, trade_time asc nulls last, created_at asc, id asc`。
- 卖出按 FIFO 消耗**同一** `trader` 下该 `symbol` 最早未卖出的买入 lot。
- 不支持做空。任一卖出数量超过该账本此前未卖出数量时，创建、修改或删除操作返回 `409 INSUFFICIENT_POSITION`。
- 一笔卖出可以消耗多个买入 lot；内部可以有多段 FIFO 匹配批次，但对外历史收益列表必须按卖出记录聚合为一行，且该行的 `trader` 等于卖出记录的 `trader`。
- 未带 `?trader=` 过滤时，当前持仓与历史收益返回**所有**交易者账本的行；每一行必须带有自己的 `trader`，不得把多交易者持仓合并为单行。

### 6.2 成本、盈亏和收益率

下列公式均指内部十进制定点精确值；响应字段按 §2.4 各自精度独立舍入，不要求已舍入 JSON 值彼此可逆。公式在单个 `(trader, symbol)` 账本内计算。

定义：

- 买入 lot 初始成本金额：`buy_price * buy_quantity + buy_fee + buy_tax`。
- 部分卖出消耗成本：`lot_remaining_cost_amount * matched_quantity / lot_remaining_quantity`。
- 卖出净回收金额：`sell_price * sell_quantity - sell_fee - sell_tax`。如果一笔卖出消耗多个 lot，卖出费税按每个 matched quantity 占该卖出总数量的比例分摊；对外历史收益行再把这些内部匹配批次求和。
- 已实现盈亏：精确 `allocated_sell_net_amount - consumed_cost_amount`，再按金额精度舍入为 `realized_pnl`。
- 已实现收益率：精确 `realized_pnl_exact / consumed_cost_amount`，再按收益率精度舍入。当分母为 `0` 时返回 `null`；正常买入成本不应为 `0`。
- 当前持仓成本金额：所有未卖出 lot 的剩余成本金额之和，再按金额精度舍入为 `cost_amount`。
- 当前持仓成本价：精确 `cost_amount_exact / quantity`，再按价格精度舍入为 `cost`。当 `quantity` 为 `0` 时该 `(trader, symbol)` 不出现在当前持仓。
- 当前市值：精确 `current_price * quantity`，再按金额精度舍入。`current_price` 为 `null` 时返回 `null`。
- 未实现盈亏：精确 `market_value_exact - cost_amount_exact`，再按金额精度舍入。市值不可用时返回 `null`。
- 未实现收益率：精确 `unrealized_pnl_exact / cost_amount_exact`，再按收益率精度舍入。分母为 `0` 或价格不可用时返回 `null`。

精度示例：

- 买入 1 股 `@10.005`，卖出 1 股 `@10.014`，费税均为 `0`：响应 `cost_amount=10.01`、`exit_amount=10.01`，但精确盈亏 `0.009` 舍入为 `realized_pnl=0.01`，`return_rate=0.0009`。此时已舍入的 `exit_amount - cost_amount` 为 `0`，不等于 `realized_pnl`。
- 买入 3 股 `@10.0001`，费税 `0`：响应 `cost_amount=30.00`，但精确平均成本舍入为 `cost=10.0001`。此时已舍入的 `cost_amount / quantity` 为 `10`，不等于 `cost`。

当前持仓和历史收益必须使用同一套按 `(trader, symbol)` 分区的 FIFO、费税、分摊口径；各响应字段仍按 §2.4 独立舍入。

### 6.3 `position_key`

- `position_key` 是当前持仓行的稳定不透明键，必须在全体持仓行中唯一标识一对 `(trader, symbol)`。
- 规范构造：`position_key = trader + "\u001f" + symbol`，其中 `\u001f` 为 ASCII Unit Separator（U+001F）。示例：`trader` 为 `杨鹏`、`symbol` 为 `600519.SH` 时，`position_key` 为 `杨鹏` + U+001F + `600519.SH`。
- 客户端必须把 `position_key` 当作不透明字符串；展示与过滤应使用响应中的 `trader` 与 `symbol`/`code` 字段，不得依赖自行拆分 `position_key`。
- 历史收益行不使用 `position_key`；其稳定行 ID 仍为 `history_id = sell_record_id`。

## 7. 持仓接口

### 7.1 当前持仓：GET /api/positions/current

返回 `as_of` 截止的未平仓持仓。每一行对应一个 `(trader, symbol)` 账本上的未平仓头寸。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `as_of` | string | 否 | 截止日期，默认请求发生时的 `Asia/Shanghai` 日期 |
| `trader` | string | 否 | 只返回该交易者账本；缺省表示返回全部交易者的持仓行 |
| `code` | string | 否 | 六位代码过滤 |
| `limit` | integer | 否 | 默认 `50`，最大 `200` |
| `offset` | integer | 否 | 默认 `0` |
| `sort` | string | 否 | `symbol_asc`、`market_value_desc`、`return_rate_desc`，默认 `symbol_asc` |

`?trader=` 校验同 §2.8；合法但无持仓时返回空 `positions`。

排序规则：

- `symbol_asc`：`symbol asc, trader asc, position_key asc`。
- `market_value_desc`：`market_value desc nulls last, symbol asc, trader asc, position_key asc`。
- `return_rate_desc`：`return_rate desc nulls last, symbol asc, trader asc, position_key asc`。
- 上述字符串键（`symbol`、`trader`、`position_key`）的升序比较口径与 §3.7 相同：JavaScript 默认 `.sort()` 或原始 UTF-16 code-unit `<`/`>`，**不用** `localeCompare`。

响应字段：

| 字段 | 类型 | 可为空 | 说明 |
| --- | --- | --- | --- |
| `position_key` | string | 否 | 稳定键，见 §6.3 |
| `trader` | string | 否 | 该持仓所属交易者标签 |
| `code` | string | 否 | 六位代码 |
| `symbol` | string | 否 | 标准标的 |
| `name` | string | 否 | 该账本内最近一笔相关记录的显示名称 |
| `open_date` | string | 否 | 当前未平仓 lot 中最早买入日期 |
| `quantity` | integer | 否 | 当前持仓股数 |
| `cost` | number | 否 | 当前平均成本价；精确成本金额 ÷ 数量后按价格精度独立舍入，不等于已舍入 `cost_amount / quantity` |
| `cost_amount` | number | 否 | 当前持仓成本金额；精确剩余成本求和后按金额精度舍入 |
| `current_price` | number | 是 | 最近价格 |
| `price_source` | string | 是 | 行情来源 |
| `price_as_of` | string | 是 | 价格时间 |
| `price_status` | string | 否 | `fresh`、`stale` 或 `unavailable` |
| `market_value` | number | 是 | 当前市值；精确 `current_price * quantity` 后按金额精度舍入 |
| `unrealized_pnl` | number | 是 | 未实现盈亏；精确市值与成本差额后按金额精度舍入，不等于已舍入 `market_value - cost_amount` |
| `return_rate` | number | 是 | 未实现收益率，小数制；精确盈亏 ÷ 精确成本后按收益率精度舍入 |

响应示例：

```json
{
  "data": {
    "as_of": "2026-10-12",
    "positions": [
      {
        "position_key": "AI选股:atr_pct\u001f600519.SH",
        "trader": "AI选股:atr_pct",
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
      },
      {
        "position_key": "杨鹏\u001f600519.SH",
        "trader": "杨鹏",
        "code": "600519",
        "symbol": "600519.SH",
        "name": "贵州茅台",
        "open_date": "2026-10-10",
        "quantity": 50,
        "cost": 1670.1,
        "cost_amount": 83505,
        "current_price": 1712.3,
        "price_source": "local_daily",
        "price_as_of": "2026-10-12T15:00:00+08:00",
        "price_status": "fresh",
        "market_value": 85615,
        "unrealized_pnl": 2110,
        "return_rate": 0.025268
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 2,
      "has_more": false
    }
  }
}
```

价格不可用示例：

```json
{
  "position_key": "杨鹏\u001f600519.SH",
  "trader": "杨鹏",
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

返回由卖出记录产生的已实现收益行。部分卖出也会产生历史收益行，即使该标的在同一 `trader` 下仍有剩余持仓。对外一笔卖出记录只产生一行历史收益；内部 FIFO 匹配批次不得作为响应行 ID 暴露。匹配仅发生在卖出记录自身的 `(trader, symbol)` 账本内。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `from` | string | 否 | `close_date` 起始日期，包含 |
| `to` | string | 否 | `close_date` 结束日期，包含 |
| `trader` | string | 否 | 只返回该交易者的已实现行；缺省表示全部交易者 |
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
| `buy_record_ids` | string[] | 否 | 被该卖出消耗的买入记录 ID 去重列表，按首次被消耗顺序排列；均属于同一 `trader` |
| `trader` | string | 否 | 卖出记录的交易者标签 |
| `code` | string | 否 | 六位代码 |
| `symbol` | string | 否 | 标准标的 |
| `name` | string | 否 | 卖出记录的显示名称 |
| `open_date` | string | 否 | 被本次卖出消耗的买入 lot 中最早买入日期 |
| `close_date` | string | 否 | 卖出记录的 `trade_date` |
| `quantity` | integer | 否 | 卖出记录数量，等于该行聚合的匹配总数量 |
| `cost` | number | 否 | 聚合平均成本价；精确消耗成本 ÷ 数量后按价格精度独立舍入，不等于已舍入 `cost_amount / quantity` |
| `exit_price` | number | 否 | 卖出成交价 |
| `cost_amount` | number | 否 | 本次卖出消耗的所有买入 lot 成本金额之和；精确消耗成本按金额精度舍入 |
| `exit_amount` | number | 否 | 本次卖出净回收金额；精确净回收（成交额减费税）按金额精度舍入 |
| `realized_pnl` | number | 否 | 已实现盈亏；精确净回收减精确消耗成本后按金额精度舍入，不等于已舍入 `exit_amount - cost_amount` |
| `return_rate` | number | 是 | 已实现收益率，小数制；精确盈亏 ÷ 精确消耗成本后按收益率精度舍入；分母为 `0` 时为 `null` |
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
        "trader": "杨鹏",
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

## 8. 本地 JSON 持久化与 trader 迁移

### 8.1 磁盘状态

- 权威文件：`backend/trade-journal-node/.data/journal.json`（路径可配置，但语义不变）。
- 顶层字段：`schema_version`（integer）、`records`（array）、`reviews`（array）、`requests`（array）。没有单独的复盘表。
- 目标 `schema_version` 为 `3`。`1` 表示交易记录仍可能没有合法 `trader`。`2` 表示 §8.2 的记录迁移已完成，复盘仍可能没有 `trader`。`3` 表示复盘也已按 §8.4 处理。`requests[].fingerprint` 的「v2 十三元组」与顶层 `schema_version` 不是同一个计数。
- `requests` 元素至少包含：`key`（即 `client_request_id` 字符串）、`recordId`、`fingerprint`（规范化体序列化）。
- 写入必须原子：写入临时文件 → `fsync` → `rename` 覆盖目标（与现有 Node 实现一致）。迁移与普通业务写共享同一原子提交边界；不得出现只写了一半记录的可见中间态。

### 8.2 从无 `trader` 的 schema_version=1 迁出

启动加载或任何写路径打开状态时，若满足下列任一条件则执行一次性确定性迁移：

1. 存在至少一条 `records[]` 元素缺少 `trader` 属性，或 `trader` 为 `null`/非字符串/trim 后为空；或
2. `schema_version === 1` 且实现已切换到要求每条记录具备 `trader` 的代码路径。

迁移步骤（必须全部在同一次原子写中完成）：

1. 对每条需要修复的记录：设置 `trader` 为字面量 `未指定`（U+672A U+6307 U+5B9A）。**不**修改 `id`、`version`、`created_at`、`updated_at` 或其他业务字段（含已 PATCH 过的价格/数量等）。
2. 已具备合法非空 `trader` 的记录保持原值。
3. 本步骤不改写复盘的 `id`、`version`、`content`、`tags`、`created_at`、`updated_at`，也不在本步骤给复盘写入 `trader`。旧文「复盘原样保留」和「迁移不改变复盘」只描述记录迁移这一步，不表示复盘资源永远没有 `trader`。复盘标签由 §8.4 写入。
4. `requests`（指纹升级，键不变）：
   - **保留**每条的 `key` 与 `recordId`（旧键字面量完全不动：不改名、不加 trader 前缀、不改写成 §9 的 `seed2:` 形式）。
   - 解析已存储的 `fingerprint`：若 JSON 解析后为**长度为 12** 的数组（v1），则取该 `recordId` 对应记录在本迁移步骤中确定的 `trader`——对缺省/非法而被回填的记录为 `未指定`，对迁移前已具备合法标签的记录为**该既有标签**（例如 `杨鹏`）——将其 **prepend 为元素 0**，得到 13 元 v2 数组后再 `JSON.stringify` 写回。**不得**用当前记录的 `price`/`quantity`/其他经济字段重算这十二个元素——它们必须来自已存储的 v1 指纹本身（即创建时 payload）。幂等重放 POST 必须使用**同一前置标签**（与指纹元素 0 一致）加上原始十二个经济字段，才能命中 `200` + `duplicate: true`（响应为当前记录）。之后对该记录的 PATCH（含改 `trader`）**不得**回写或改写该创建指纹中的标签。
   - 若解析后已是**长度为 13** 的数组（已是 v2），**不再变换**。
   - **孤儿**（`recordId` 在 `records` 中无对应行）：可按既有硬删除语义删除该 `requests` 条目并释放键。
   - **损坏但指向活记录**：若 `recordId` 仍指向一条现存记录，但 `fingerprint` 无法解析为长度为 12 或 13 的数组，则**不得**删除该映射；在同一次原子迁移中原样保留其 `key`、`recordId` 与原始 `fingerprint` 字符串不变。之后任何 POST 复用该键都必须返回 `409 DUPLICATE_RECORD`，不得再创建另一笔交易。
   - 不得半写：要么整次迁移原子成功并可见，要么对外不暴露中间态。
5. 记录侧完成后，指纹按上面的规则成为 v2 十三元组。若同一次加载还要执行 §8.4，不得把 `schema_version: 2` 且复盘仍无 `trader` 的中间文件当成成功结果留下。与 §8.4 合成同一次原子写，最终 `schema_version` 为 `3`。磁盘上已经是 `2` 的文件不重做已完成的 13 元指纹升级，只执行 §8.4。
6. 成功时的那一次原子写由 §8.4 描述，顶层版本是 `3`。若写失败，内存不得对外服务半迁移状态；下次加载重试同一确定性步骤。rename 成功前，已有文件保持原字节。

迁移不重新分配记录 ID，不递增记录 `version`，不发明选股资源。本步骤不改复盘的 `id`、`version`、正文、标签和时间戳。复盘 `trader` 只在 §8.4 补齐，该步骤同样不改这些字段。迁移后 FIFO 按 `(trader, symbol)` 重放；原先按全局 `symbol` 混撮的旧口径在文档与实现上废止。仅**缺失或非法** `trader` 的记录被回填为 `未指定` 并落入该标签的账本；迁移前已具备合法标签的记录保留各自的 `(trader, symbol)` FIFO 账本、记录字段、持仓/历史过滤与幂等重放标签。若旧 v1 状态中**没有任何**记录带有合法 `trader`，则全部记录成为 `未指定`，此时原全局 FIFO 数值结果保持不变。不得据此把已有合法 `trader` 的复盘改写成 `未指定`。

### 8.3 迁移后的客户端行为

- 新建记录必须显式传 `trader`；不能省略以期望得到 `未指定`。
- 新建复盘同样必须显式传 `trader`；不能省略以期望得到 `未指定`。
- 若需继续向被回填为 `未指定` 的迁移记录追加买卖，应使用 `trader: "未指定"`；对迁移前已保留合法标签的记录，继续使用该标签。也可先 `PATCH` 改标签并接受旧/新账本重校验。
- 被回填为 `未指定` 的旧复盘仍用该标签读取和修改。`PATCH` 可以改成其他标签；目标 `(date, trader)` 已被占用时返回 `409 DUPLICATE_REVIEW`。
- `client_request_id` 仍为全局唯一、最长 80；跨 `trader` 复用同一请求 ID 会 `409`。历史键字面量在迁移中保持不变（见上）；新的跨 trader 导入键见 §9。

### 8.4 复盘 trader：schema_version 2 迁到 3

本步骤只处理 `reviews[]`。不修改 `records`，不修改 `requests` 的 `key`、`recordId` 或 `fingerprint`，不创建 SQL 表。加载 `schema_version` 为 `1`、`2` 或 `3` 时都执行下面的判定。其他 `schema_version` 拒绝加载，不改写文件，也不对外服务。

对每条复盘，用与 §2.8 相同的规则看 `trader`（trim，长度按 UTF-16 code unit）：

- 缺字段、`null`、非字符串、trim 后长度为 0，或 trim 后长度大于 64：改为字面量 `未指定`（U+672A U+6307 U+5B9A）。
- trim 后长度为 1 到 64：保留 trim 后的标签。`  杨鹏  ` 变成 `杨鹏`，不得改成 `未指定`。已经是合法标签的复盘保持该标签。

每条复盘的 `id`、`version`、`date`、`content`、`tags`、`created_at`、`updated_at` 保持原值。`reviews` 的数组顺序保持原顺序。不因为补了 `trader` 而递增 `version`。

判定之后若两条复盘的 `(date, trader)` 相同，迁移失败。常见情况是同一日期有两条都缺少合法 `trader`，回填后都会变成 `未指定`。失败时不得删掉其中一条来凑唯一键，不得写入新文件，不得把半迁移状态提供给请求。已有文件保持原字节。这是加载失败，不是 HTTP `409 DUPLICATE_REVIEW`。`DUPLICATE_REVIEW` 只用于迁移完成之后的 `POST` 和 `PATCH`。旧数据若本来就是每个日期一条复盘，则全部回填为 `未指定` 后仍然满足唯一键。同一日期上已经有合法 `trader` 的复盘，与另一条回填为 `未指定` 的复盘可以同时保留。

写入规则：

- `schema_version` 为 `1` 或 `2`：先得到 §8.2 的记录结果（`2` 且记录与指纹都已符合时，该步不改记录），再得到本节的复盘结果，然后**一次**原子写回，`schema_version` 为 `3`。`reviews` 为空也要写成 `3`。
- `schema_version` 已是 `3`，且本节与 §8.2 都没有发现需要改的字段：不写磁盘。
- `schema_version` 已是 `3`，但仍有复盘（或记录）需要按上述规则修复：修复后原子写回，`schema_version` 仍为 `3`。
- 对同一文件连续加载两次，第二次必须得到与第一次成功写回后相同的 `reviews`，并且不再改 `id`、`version` 和时间戳。无差异时第二次不写。
- 写失败时内存状态不得对外服务；下次加载从头做同一判定。

## 9. seed-picks 导入器契约（客户端约定）

本节约束 `backend/trade-journal-node/scripts/seed-picks.js`（及等价导入客户端）如何构造 `POST /api/records` 的 `trader` 与 `client_request_id`。服务端仍只执行 §2–§3 的通用校验；**不**把全局 `client_request_id` 上限从 80 提高到 160。

### 9.1 `trader` 默认值与校验

- 若命令行提供显式 `--trader <label>`：以其 trim 后的值作为最终标签（覆盖下列默认）。
- 否则：
  - `--from-tsp`：默认 `AI选股:<strategy display name>`，其中 `<strategy display name>` 为策略的展示名（已 trim）。
  - `--from-file`：默认 `AI选股:文件导入`。
- 得到最终标签后，必须按 §2.8 做 normalize/validate（trim、非空、长度 1..64），**然后**再 POST。
- 若前缀 `AI选股:` 与策略名/显式值拼接后超过 64 个 UTF-16 code unit：导入器必须**可见失败**（非零退出/明确错误），**禁止**静默截断。

### 9.2 `client_request_id`（跨 trader、仍 ≤80）

既有「`tradeDate` + `symbol`」键在不同 `trader` 之间会全局碰撞。导入器必须改用下列稳定短键（总长远低于 80）：

```text
seed2:${tradeDate}:${symbol}:${sha256(UTF8(trimmedTrader)).slice(0, 32)}
```

其中：

- `tradeDate` 为 `YYYY-MM-DD`（Asia/Shanghai 今天，与写入的 `trade_date` 一致）；
- `symbol` 为服务端规范标的（如 `600519.SH`）；
- `trimmedTrader` 为 §9.1 最终标签；`sha256` 对 UTF-8 字节摘要，再取十六进制前 32 个字符（小写）。

行为：

- 同一 `tradeDate` + `symbol` + `trader` 重跑 → 与原始指纹一致 → `200` + `duplicate: true`，不新建。
- 同一 `tradeDate` + `symbol` 但**另一** `trader` → 不同键 → 可创建独立记录（落在各自 `(trader, symbol)` 账本）。
- 同一键但价格/备注等与原始指纹不一致 → `409 DUPLICATE_RECORD`。

### 9.3 与迁移的关系

§8 迁移**不改写**已存在的 `requests[].key` 字面量。因此迁移前用旧式 `日期+symbol` 写入的键继续保留；仅指纹按 §8.2 升级为 v2。新导入统一使用 `seed2:...` 键；旧键与新键可并存于全局键空间，互不自动合并。
