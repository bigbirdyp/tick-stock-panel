# 项目共识：二次开发基线

本页记录 2026-10-12 对提交 `3027188` 的前端、后端和文档静态审阅结论，供后续新增功能时快速定位边界。它不是接口清单的永久快照；动手前仍须核对当前代码和测试。

## 依据与分工

- 先读根目录 [`AGENTS.md`](../AGENTS.md)、[`CONTRIBUTING.md`](../CONTRIBUTING.md) 和 [`secondary-development.md`](secondary-development.md)。前者是开发入口；`CONTRIBUTING.md` 规定架构、金融数据口径、缓存、验证和审查要求；二开指南规定扩展级别、已实现接口和升级方式。
- 业务细节按需求读专门文档：YAML 数据源看 [`custom-data-source.md`](custom-data-source.md)，Python 插件看 [`plugin-development.md`](plugin-development.md)，策略看 [`strategy.md`](strategy.md)，因子现状看 [`factor-platform-plan.md`](factor-platform-plan.md) 和当前代码、技术设计看 [`factor-system-design.md`](factor-system-design.md)，挖掘看 [`mining.md`](mining.md)，运行配置与部署看 [`configuration.md`](configuration.md) 和 [`deployment.md`](deployment.md)。不要在本页复制这些文档的完整规则。
- 文档中的“按需扩展”和示例只是设计方向。判断接口是否可用，要在当前代码中找到定义、接线、调用方和测试；冲突时先核实实现与数据契约，再修正文档。

## 系统边界

主链路是数据源/插件 -> 标准化与服务 -> 仓库/Parquet -> enriched 指标 -> 策略、监控、回测、分析 -> FastAPI REST/SSE -> 前端 API 类型、TanStack Query -> 页面。层级职责以 [`CONTRIBUTING.md` 的架构表](../CONTRIBUTING.md#23-模块边界)为准：API 层做参数和响应，服务层编排业务，provider 处理供应商差异；页面不直读供应商或数据文件。

按已有能力选择最小接入方式（[`secondary-development.md` 第 2 节](secondary-development.md#2-二次开发分级)）：

| 级别 | 当前可选方式 | 使用前核实 |
| --- | --- | --- |
| L1 | 配置、策略文件、扩展数据与声明式分析页面 | 现有契约能否表达需求；数据单位、权限和旧配置兼容 |
| L2 | 前端源码扩展注册的路由、导航和**已开放**插槽；后端源码扩展的路由、启动钩子和 `NotificationFormatter`；数据源 Provider/插件 | 注册入口、版本、异常隔离和实际调用点存在；补契约测试 |
| L3 | 修改核心源码 | 扩展无法表达核心行为时缩小改动，覆盖上下游和升级冲突 |

截至上述提交，前端插槽只有 `layout.navigation.extra`、`stock-preview.footer`、`watchlist.toolbar`（[`secondary-development.md` 第 3.2 节](secondary-development.md#32-当前插槽契约)，`frontend/src/extensions/types.ts`）。后端已实现的小粒度继承点是 `NotificationFormatter`；候选过滤、评分、仓位、风控、回测成本等接口以及更多页面插槽、配置迁移注册表均尚未实现。文档中 `strategy.monitor.filters` 等片段不能直接当作现成插槽使用。

## 跨层约定

新增功能先把这些会改变结果或状态的维度写清楚，并在相关边界和测试中保持一致：

1. **金融数据口径**：`change_pct`、`turnover_rate` 的小数/百分数边界；原始价与前复权价；五档量的“手/股”；实际交易日、北京时间和分钟 K 时间；股票、ETF、指数的资产类型；历史股本的公告日。具体值以 [`CONTRIBUTING.md` 第 3 节](../CONTRIBUTING.md#3-不可混用的数据契约)为准，不按字段名猜单位。
2. **数据能力**：通用流程通过 provider 和能力矩阵选源，页面能力门控看 `usable`。新增数据集应同步 provider 标准化、preferences 路由、能力矩阵、API 类型、文档和缺能力/空数据测试；不能把某家 SDK 依赖带入通用策略或页面。`depth5` 当前可由 Python 插件声明，YAML 自定义源没有该数据集契约。
3. **前后端契约**：后端模型/API 响应变化时同步 `frontend/src/lib/api.ts` 类型和调用方；请求复用该入口，查询键在 `frontend/src/lib/queryKeys.ts` 集中定义，包含标的、资产类型、日期、周期及其他结果维度。SSE 更新还要核对相应 query 的精确失效范围。
4. **写入与刷新**：列出持久化、内存缓存、generation/version、SSE、前端 Query 的完整路径。并发读写优先不可变快照或原子替换；刷新期间保留上一份有效数据，避免短暂空结果。历史配置、策略和存储格式默认兼容读取。
5. **失败边界**：缺少 provider 能力、插件加载失败、空数据、请求中断、扩展冲突和权限不足都有明确结果。外部/插件数据进入 HTML、SQL、Shell 或文件路径时审查信任边界。

## 本次审阅发现的待处理点

下列是静态审阅线索，不代表已完成运行时复现；实现新功能若碰到对应链路，先补定向验证并处理。

| 范围 | 当前证据 | 二开时的影响 |
| --- | --- | --- |
| 自定义数据源 | `backend/app/data_providers/custom/config.py:105` 的 YAML 解析白名单未含 `full_minute`，但能力注册表和 provider 支持它 | 声明式数据源的配置可能被忽略；增加/修改数据集时核对“声明、解析、路由、测试”全链 |
| 数据源偏好 | `backend/app/api/settings.py:411` 列出七种偏好，而卸载和删除路径在 `:690`、`:743` 只处理部分字段 | 删除或卸载正在使用的数据源后，持久化偏好与有效路由可能不一致；检查所有能力及回退时序 |
| 前端缓存 | `frontend/src/pages/Dashboard.tsx:109` 等仍有组件内查询键，和集中管理约定不一致 | 新功能使用 `QK` 并验证 SSE、切换上下文后的失效范围 |
| K 线展示 | `frontend/src/components/EChartsCandlestick.tsx:995` 将日期插入 HTML，随后在 `:1072` 写入 `innerHTML` | 自定义源字段可能扩大输入边界；确认标准化/转义后再复用这一渲染方式 |

## 新功能的完成标准

1. 记录基线提交、需求影响的主链路、L1/L2/L3 选择以及现有实现/测试证据；不要仅依据路线图或示例判断能力已交付。
2. 明确数据单位、资产和时间口径、API/类型、能力路由、缓存与 SSE、旧数据兼容及失败行为。修改共享契约时同时更新上下游和对应专门文档。
3. 按 [`CONTRIBUTING.md` 验证矩阵](../CONTRIBUTING.md#9-验证矩阵)执行受影响模块测试：后端定向 `uv run pytest`、相关 `ruff check`，前端 TS/组件/API 改动执行 `pnpm build`；跨层改动还需联调成功、空数据、错误和实时刷新。提交前执行 `git diff --check`，报告未运行项和剩余风险。

本次代码与原有文档的审阅阶段为只读静态检查；仅整理和修正文档，未安装依赖，也未运行构建、测试或联调。上述待处理点的行为结论需由后续定向测试确认。
