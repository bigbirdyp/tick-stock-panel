"""面向外部 Agent 的因子研究工具；计算、鉴权和发布门槛由面板负责。"""
from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Annotated, Literal
from urllib.parse import quote

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, ConfigDict, Field

AssetType = Literal["stock", "etf"]
SymbolPool = Annotated[list[Annotated[str, Field(min_length=1)]], Field(min_length=1)]
RunId = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")]


class FactorBacktestOptions(BaseModel):
    """手续费按小数比例、滑点按基点；缺省字段使用面板默认值。"""

    model_config = ConfigDict(extra="forbid")
    n_groups: int = Field(5, ge=2, le=10)
    rebalance: Literal["daily", "weekly", "monthly"] = "monthly"
    weight: Literal["equal", "factor_weight"] = "equal"
    fees_pct: float = Field(0.0002, ge=0)
    slippage_bps: float = Field(5, ge=0)


def date_range(start: date, end: date) -> dict[str, str]:
    if start > end:
        raise ToolError("start 不能晚于 end")
    return {"start": start.isoformat(), "end": end.isoformat()}


def register_factor_tools(mcp: MCPServer, scopes: set[str], call: Callable[..., str]) -> None:
    runs = "/api/backtest/mining/runs"

    if "read:analysis" in scopes:
        @mcp.tool()
        def list_factor_columns() -> str:
            """查询可用于回测和挖掘的因子目录，含运行期注册因子的 id。"""
            return call("GET", "/api/backtest/factor/columns")

        @mcp.tool()
        def get_mining_run(run_id: RunId) -> str:
            """按提交返回的 run_id 查询进度、状态及失败原因。"""
            return call("GET", f"{runs}/{run_id}")

        @mcp.tool()
        def get_mining_result(run_id: RunId) -> str:
            """读取成功任务的候选、factor_names、折外表现、gate、signature。运行中返回 409。"""
            return call("GET", f"{runs}/{run_id}/result")

    if "write:factor" in scopes:
        @mcp.tool()
        def validate_factor(formula: str) -> str:
            """校验 DSL 公式，检查返回的 ok、errors、依赖及预热窗口。"""
            return call("POST", "/api/factors/validate", json={"formula": formula})

        @mcp.tool()
        def trial_factor(formula: str, asset_type: AssetType = "stock",
                         days: Annotated[int, Field(ge=20, le=120)] = 40) -> str:
            """用最近 20–120 个交易日试算 DSL 公式，返回 IC 和覆盖情况。"""
            return call("POST", "/api/factors/trial", json={
                "formula": formula, "asset_type": asset_type, "days": days,
            })

        @mcp.tool()
        def create_factor(factor_id: Annotated[str, Field(pattern=r"^uf_[a-z0-9_]{1,40}$")],
                          label: str, formula: str, direction: Literal["high", "low", "none"] = "none",
                          group: str = "自定义", description: str = "") -> str:
            """保存新 DSL 因子，返回 id/version。同 ID 返回 409。保存前面板在股票数据上试算。"""
            return call("POST", "/api/factors/custom", json={
                "id": factor_id, "label": label, "formula": formula, "direction": direction,
                "group": group, "description": description,
            })

    if "run:backtest" in scopes:
        def backtest(path, factors, symbols, start, end, asset_type, options):
            payload = {**factors, **date_range(start, end), "symbols": symbols, "asset_type": asset_type}
            if options:
                payload.update(options.model_dump(exclude_unset=True))
            return call("POST", f"/api/backtest/factor/{path}", json=payload)

        @mcp.tool()
        def run_factor_backtest(factor_name: str, symbols: SymbolPool, start: date, end: date,
                                asset_type: AssetType = "stock",
                                options: FactorBacktestOptions | None = None) -> str:
            """在指定股票池或 ETF 池、起止日期检验一个因子，返回 IC/IR、分组和多空表现。"""
            return backtest("run", {"factor_name": factor_name}, symbols, start, end, asset_type, options)

        @mcp.tool()
        def run_factor_batch(factor_names: list[str], symbols: SymbolPool, start: date, end: date,
                             asset_type: AssetType = "stock",
                             options: FactorBacktestOptions | None = None) -> str:
            """在同一标的池和日期区间批量比较多个已注册因子。"""
            return backtest("batch", {"factor_names": factor_names}, symbols, start, end, asset_type, options)

    if "run:mining" in scopes:
        @mcp.tool()
        def start_factor_mining(factor_names: list[str], symbols: SymbolPool, start: date, end: date,
                                asset_type: AssetType = "stock",
                                budget_profile: Literal["exploratory", "balanced", "strict"] = "balanced",
                                commission_pct: float = 0.0002, stamp_tax_pct: float = 0.0005,
                                slippage_bps: float = 5.0) -> str:
            """提交指定因子挖掘，返回 run_id。单因子传一个 ID；exploratory 的候选不能发布。"""
            return call("POST", runs, json={
                "factor_names": factor_names, "symbols": symbols, **date_range(start, end),
                "asset_type": asset_type, "budget_profile": budget_profile, "commission_pct": commission_pct,
                "stamp_tax_pct": stamp_tax_pct, "slippage_bps": slippage_bps,
            })

    if "publish:strategy" in scopes:
        @mcp.tool()
        def publish_mining_candidate(run_id: RunId, signature: str) -> str:
            """发布结果中包含目标因子且 gate.qualified 为真的候选；原样传 signature，返回 strategy_id。"""
            if not signature.startswith("factor:") or "/" in signature or "\\" in signature:
                raise ToolError("请传入因子候选的原始 signature")
            return call("POST", f"{runs}/{run_id}/candidates/{quote(signature, safe='')}/publish")
