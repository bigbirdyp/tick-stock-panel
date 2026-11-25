"""Run with PYTHONPATH=src python -m unittest discover -s tests."""
import json
import unittest
from importlib import reload
from unittest.mock import patch

import httpx
from mcp.server.mcpserver.exceptions import ToolError

from tsp_mcp_server import server


class FactorToolTests(unittest.IsolatedAsyncioTestCase):
    def configure(self, scopes):
        with patch.dict("os.environ", {"TSP_TOKEN": "test", "TSP_SCOPES": scopes}):
            server._client.close()
            reload(server)

        def echo(request):
            self.assertEqual(request.headers["Authorization"], "Bearer test")
            return httpx.Response(200, json={
                "method": request.method, "path": request.url.path,
                "body": json.loads(request.content) if request.content else None,
            })

        server._client.close()
        server._client = httpx.Client(base_url="http://panel", headers={"Authorization": "Bearer test"},
                                      transport=httpx.MockTransport(echo))
        self.addCleanup(server._client.close)

    async def invoke(self, name, **arguments):
        result = await server.mcp.call_tool(name, arguments)
        self.assertFalse(result.is_error, result.content)
        return json.loads(result.content[0].text)

    async def test_tools_follow_declared_scopes(self):
        self.configure("read:analysis")
        names = {tool.name for tool in await server.mcp.list_tools()}
        self.assertTrue({"list_factor_columns", "get_mining_run", "get_mining_result"} <= names)
        self.assertFalse({"create_factor", "run_factor_backtest", "start_factor_mining",
                          "publish_mining_candidate"} & names)

    async def test_factor_research_roundtrip_contract(self):
        self.configure("read:analysis,write:factor,run:backtest,run:mining,publish:strategy")
        base = "/api/backtest/mining/runs"
        symbol_pool = ["000001.SZ", "600000.SH"]
        dates = dict(start="2024-01-02", end="2026-10-09", symbols=symbol_pool)
        factor = "uf_research"
        signature = "factor:uf_research|w:1|d:-1"
        calls = [
            ("list_factor_columns", {}, "GET", "/api/backtest/factor/columns", None),
            ("validate_factor", {"formula": "rank(close)"}, "POST", "/api/factors/validate",
             {"formula": "rank(close)"}),
            ("trial_factor", {"formula": "rank(close)", "days": 30}, "POST", "/api/factors/trial",
             {"days": 30}),
            ("create_factor", {"factor_id": factor, "label": "测试", "formula": "rank(close)"},
             "POST", "/api/factors/custom", {"id": factor, "formula": "rank(close)"}),
            ("run_factor_backtest", dict(dates, factor_name=factor,
                                         options={"fees_pct": 0.0003, "n_groups": 2}),
             "POST", "/api/backtest/factor/run", dict(dates, factor_name=factor, fees_pct=0.0003, n_groups=2)),
            ("run_factor_batch", dict(dates, factor_names=[factor]), "POST",
             "/api/backtest/factor/batch", dict(dates, factor_names=[factor])),
            ("start_factor_mining", dict(dates, factor_names=[factor]), "POST", base,
             dict(dates, factor_names=[factor])),
            ("get_mining_run", {"run_id": "r1"}, "GET", f"{base}/r1", None),
            ("get_mining_result", {"run_id": "r1"}, "GET", f"{base}/r1/result", None),
            ("publish_mining_candidate", {"run_id": "r1", "signature": signature}, "POST",
             f"{base}/r1/candidates/{signature}/publish", None),
            ("run_backtest", dict(dates, strategy_id="mined_factor_1"), "POST",
             "/api/backtest/strategy/run", dict(dates, strategy_id="mined_factor_1")),
        ]
        for name, args, method, path, expected_body in calls:
            with self.subTest(name=name):
                result = await self.invoke(name, **args)
                self.assertEqual((result["method"], result["path"]), (method, path))
                if expected_body:
                    self.assertEqual({k: result["body"][k] for k in expected_body}, expected_body)
                else:
                    self.assertIsNone(result["body"])

    async def test_invalid_inputs_do_not_issue_requests(self):
        self.configure("run:backtest,run:mining,publish:strategy")
        args = dict(symbols=["A"], start="2026-02-04", end="2026-02-01")
        for name, params in [
            ("start_factor_mining", dict(args, factor_names=["uf_x"])),
            ("run_factor_backtest", dict(args, factor_name="uf_x")),
            ("run_factor_batch", dict(args, start="2026-01-01", symbols=[], factor_names=["uf_x"])),
            ("run_backtest", {"strategy_id": "s", "symbols": ["A"], "start": "2026-02-01"}),
            ("run_backtest", dict(args, start="2026-01-01", strategy_id="s", symbols=[])),
            ("publish_mining_candidate", {"run_id": "../x", "signature": "factor:uf_x|w:1|d:1"}),
        ]:
            with self.subTest(name=name):
                with self.assertRaises(ToolError):
                    await server.mcp.call_tool(name, params)

    async def test_gateway_denial_is_a_tool_error(self):
        self.configure("write:factor")
        with patch.object(server._client, "request", return_value=httpx.Response(
            403, json={"detail": "Token 缺少 write:factor"},
            request=httpx.Request("POST", "http://panel/api/factors/custom"),
        )):
            with self.assertRaisesRegex(ToolError, "HTTP 403.*write:factor"):
                await server.mcp.call_tool("create_factor", {
                    "factor_id": "uf_test", "label": "测试", "formula": "close",
                })

    async def test_legacy_backtest_days(self):
        from datetime import date
        self.configure("run:backtest")
        body = (await self.invoke("run_backtest", strategy_id="s", symbols=["A"], days=9))["body"]
        self.assertEqual((date.fromisoformat(body["end"]) - date.fromisoformat(body["start"])).days, 9)
