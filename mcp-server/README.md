# tick-stock-panel MCP 服务器

把面板的开放接口包装成 **MCP (Model Context Protocol)** 工具, 让 Claude / ZCode / Cursor 等 AI 客户端直接查询行情、市场环境、策略与告警, 触发回测。

```
AI 客户端 ⇄ MCP stdio (本服务器) ⇄ HTTP + Bearer Token ⇄ 面板开放网关
```

权限、限流、契约全部复用面板的开放接口层 — 本服务器只是一层薄桥, 面板侧的 Token scope 是最终权威。

## 准备

1. 面板 → **设置 → 开放接口** → 新建 Token, 勾选所需 scope
2. 记下 `tsp_` 开头的明文 (只显示一次)

## 配置到 MCP 客户端

以 Claude Desktop (`claude_desktop_config.json`) / 任何支持 stdio MCP 的客户端为例:

```json
{
  "mcpServers": {
    "tick-stock-panel": {
      "command": "uv",
      "args": ["--directory", "E:/tick-stock-panel/mcp-server", "run", "tsp-mcp-server"],
      "env": {
        "TSP_BASE": "http://127.0.0.1:3018",
        "TSP_TOKEN": "tsp_xxxx",
        "TSP_SCOPES": "read:market,read:ext,read:analysis"
      }
    }
  }
}
```

- `TSP_BASE`: 面板地址 (默认 `http://127.0.0.1:3018`)
- `TSP_TOKEN`: API Token
- `TSP_SCOPES`: 逗号分隔, 决定暴露哪些工具 (默认只读三档)。**真正的权限裁决在面板网关** — 声明了没授权的 scope, 调用会得到 403, AI 能看到错误并停止

手动验证:

```bash
cd mcp-server
TSP_TOKEN=tsp_xxx uv run tsp-mcp-server   # stdio JSON-RPC, 供客户端拉起
```

## 工具清单 (按 scope)

| scope | 工具 | 说明 |
| :--- | :--- | :--- |
| `read:market` | `search_instrument` | 代码/名称/拼音搜标的 |
| | `get_kline` | 标的日K (前复权) |
| | `get_index_kline` | 指数日K |
| | `get_market_overview` | 涨跌家数/成交额/涨停连板/情绪 |
| `read:analysis` | `get_regime_state` | 最新市场环境阶段 |
| | `list_strategies` / `get_strategy_detail` | 策略清单与定义 |
| | `get_recent_alerts` | 最近告警 |
| `read:ext` | `list_ext_tables` / `query_ext_table` | 自有数据表查询 |
| `write:ext` | `write_ext_rows` | 写入扩展表 (进入策略数据面, 慎授) |
| `read:analysis` | `list_factor_columns` / `get_mining_run` / `get_mining_result` | 查询因子目录、任务进度与候选的样本外表现 |
| `write:factor` | `validate_factor` / `trial_factor` / `create_factor` | 校验、试算 DSL 公式并创建因子 |
| `run:backtest` | `run_factor_backtest` / `run_factor_batch` | 指定标的、起止日期、分组、调仓和交易成本 |
| `run:mining` | `start_factor_mining` | 为指定因子提交挖掘任务 |
| `publish:strategy` | `publish_mining_candidate` | 发布通过面板门槛的候选 |
| `run:backtest` | `run_backtest` | 策略回测，支持原有 `days` 或明确的 `start` 和 `end` |

未包含: 模拟盘交易类端点 — 不建议把下单能力交给 AI, 需要时可自行在 `server.py` 里按同样模式补。

## 外部 Agent 的因子研究流程

完整流程在面板签发 Token 时勾选五项权限，并为 MCP 客户端设置
`TSP_SCOPES=read:analysis,write:factor,run:backtest,run:mining,publish:strategy`。
单独评估已注册因子只需要 `read:analysis,run:backtest`。

| 步骤 | MCP 调用 | 对应 REST 契约 |
| --- | --- | --- |
| 查目录 | `list_factor_columns()`，从 `columns[].id` 选输入 | `GET /api/backtest/factor/columns` |
| 设计公式 | 依次把同一个 `formula` 交给 `validate_factor`、`trial_factor`，检查 `ok` 和覆盖情况 | `POST /api/factors/validate`、`POST /api/factors/trial` |
| 保存 | `create_factor(factor_id, label, formula)`，记下返回的 `id` 和 `version` | `POST /api/factors/custom`，请求字段为 `id`。Token 创建时 ID 冲突返回 409 |
| 检验 | 对该 ID 调用 `run_factor_backtest`，比较多个 ID 用 `run_factor_batch` | `POST /api/backtest/factor/run` 或 `/api/backtest/factor/batch` |
| 挖掘 | `start_factor_mining(factor_names, symbols, start, end)`，记录 `run_id` | `POST /api/backtest/mining/runs` |
| 选候选 | 用 `get_mining_run` 轮询；状态为 `succeeded` 或 `succeeded_with_budget_exhausted` 后调用 `get_mining_result` | `GET /api/backtest/mining/runs/{run_id}` 和其 `/result` |
| 发布 | 从 `candidates` 中选出 `factor_names` 包含目标 ID 且 `gate.qualified` 为真的候选，传原始 `signature` 给 `publish_mining_candidate` | `POST /api/backtest/mining/runs/{run_id}/candidates/{signature}/publish`，REST 客户端须对签名做路径段编码 |
| 复测 | 用发布返回的 `strategy_id` 调用 `run_backtest`，明确传入标的池、资产类别、日期和成本 | `POST /api/backtest/strategy/run` |

单因子检验的 MCP 参数示例（日期仅用于说明请求格式）：

```json
{"factor_name":"uf_momentum","symbols":["600000.SH","000001.SZ","000002.SZ"],
 "start":"2025-01-02","end":"2025-12-31","asset_type":"stock",
 "options":{"n_groups":2,"rebalance":"weekly","weight":"equal","fees_pct":0.0002,"slippage_bps":5}}
```

保存 DSL 因子前，面板还会用最近 40 个股票交易日验证非空输出。因子回测结果可能带有
`error` 或空统计，Agent 应先检查结果再解读 IC/IR。只研究新因子时挖掘请求传
`factor_names=[新因子ID]`。挖掘对历史长度和市场环境数据有要求；具体以面板返回的校验原因为准。
`exploratory` 用于初筛，需发布时使用 `balanced` 或 `strict`。没有合格候选时结束本次研究。
任务运行中读取结果返回 409，失败或取消后读取返回 422。网关的 403 表示 Token 缺少授权
或该操作未开放。在发布响应丢失时可用同一任务和签名重试，策略 ID 由服务端确定。

本次扩展基于 `online@5cb0e2cd`。合入上游版本时，先核对 Tier A 开放契约快照、
Token 权限清单及挖掘结果中的 `gate` 和 `signature`。在 `mcp-server/` 运行
`PYTHONPATH=src uv run python -m unittest discover -s tests` 可验证工具到 REST 的参数映射。

## 设计说明

- **薄桥原则**: 所有权限/限流/契约由面板网关裁决, 本服务器不持有任何业务逻辑, 面板升级自动受益
- 工具返回原文 JSON, 错误以可读文本返回 — LLM 可据此自行纠正参数
- 更底层的 REST 契约与示例见 [examples/open-api](../examples/open-api/README.md) 与 [docs/features.md → 开放接口](../docs/features.md)
