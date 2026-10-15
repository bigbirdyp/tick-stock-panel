"""真实主应用认证链与日志代理边界；不运行 lifespan，不访问本机服务。"""
from __future__ import annotations

import importlib
import logging
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app.api import auth as auth_api
from app.api import trade_journal
from app.config import settings
from app.services import api_gateway, api_tokens
from app.services import auth as auth_service

_REAL_CLIENT_IP = auth_api._client_ip


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>frontend test</html>")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("TICKFLOW_ENV_FILE", str(tmp_path / "absent.env"))
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "static_dir", static)
    # 导入时的日志文件也只落在临时目录，ASGITransport 不启动调度器。
    previous_handlers = set(logging.getLogger().handlers)
    from app import main
    application = importlib.reload(main).app
    monkeypatch.setattr(auth_service, "is_configured", lambda: False)
    monkeypatch.setattr(auth_api, "_client_ip", lambda request: "127.0.0.1")
    monkeypatch.delenv("API_TOKEN_LOCAL_ONLY", raising=False)
    try:
        yield application
    finally:
        for handler in set(logging.getLogger().handlers) - previous_handlers:
            logging.getLogger().removeHandler(handler)
            handler.close()


@pytest.fixture
def proxy(monkeypatch: pytest.MonkeyPatch) -> Callable:
    original = httpx.AsyncClient
    def install(handler: Callable) -> None:
        monkeypatch.setattr(trade_journal.httpx, "AsyncClient", lambda **kwargs: original(
            transport=httpx.MockTransport(handler), **kwargs))
    return install


@pytest.mark.parametrize("path", ["/api/records", "/api/reviews/id", "/api/positions/current", "/api/traders", "/api/records/unknown/child"])
async def test_missing_session_rejected_before_proxy(app: FastAPI, proxy: Callable,
        monkeypatch: pytest.MonkeyPatch, path: str) -> None:
    monkeypatch.setattr(auth_service, "is_configured", lambda: True)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    proxy(lambda request: pytest.fail("Rejected authentication reached Node"))
    async with client:
        response = await client.get(path)
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "UNAUTHENTICATED", "message": "未登录或会话已过期"}}


async def test_unconfigured_public_ip_rejected_before_proxy(app: FastAPI, proxy: Callable,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_api, "_client_ip", lambda request: "203.0.113.7")
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    proxy(lambda request: pytest.fail("Public unauthenticated request reached Node"))
    async with client:
        response = await client.get("/api/records")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


@pytest.mark.parametrize("session", [False, True])
async def test_local_or_valid_session_forwards_json(app: FastAPI, proxy: Callable,
        monkeypatch: pytest.MonkeyPatch, session: bool) -> None:
    monkeypatch.setattr(auth_service, "is_configured", lambda: session)
    monkeypatch.setattr(auth_service, "is_valid_session", lambda token: token == "valid")
    if session:
        monkeypatch.setattr(auth_api, "_client_ip", lambda request: "203.0.113.7")
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                              cookies={auth_api.COOKIE_NAME: "valid"})
    proxy(lambda request: httpx.Response(200, json={"data": [{"trader": "甲", "review_count": 2}]}))
    async with client:
        response = await client.get("/api/records")
    assert response.status_code == 200
    assert response.json() == {"data": [{"trader": "甲", "review_count": 2}]}


@pytest.mark.parametrize(("public", "valid", "status", "code"), [
    (True, False, 403, "FORBIDDEN"), (False, False, 401, "UNAUTHENTICATED"),
    (False, True, 403, "FORBIDDEN"),
])
async def test_bearer_policy_no_new_scope(app: FastAPI, proxy: Callable,
        monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
        public: bool, valid: bool, status: int, code: str) -> None:
    if public:
        monkeypatch.setattr(auth_api, "_client_ip", lambda request: "203.0.113.7")
    _, token = api_tokens.create_token(tmp_path, "test", ["read:market"])
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    proxy(lambda request: pytest.fail("Rejected Bearer reached Node"))
    async with client:
        response = await client.get("/api/traders", headers={"Authorization": "Bearer " + (token if valid else "invalid")})
    assert api_gateway.required_scope("GET", "/api/traders") is None
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


async def test_gateway_rejection_preserves_headers(app: FastAPI, proxy: Callable,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_gateway, "evaluate", lambda *args: {
        "status": 403, "detail": "denied", "headers": {"X-RateLimit-Limit": "120"}})
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    proxy(lambda request: pytest.fail("Denied gateway reached Node"))
    async with client:
        response = await client.get("/api/records", headers={"Authorization": "Bearer invalid"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"
    assert response.headers["x-ratelimit-limit"] == "120"


async def test_gateway_non_auth_error_preserves_original_envelope(app: FastAPI,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_gateway, "evaluate", lambda *args: {
        "status": 429, "detail": "限流", "headers": {"Retry-After": "7"}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/records", headers={"Authorization": "Bearer invalid"})
    assert response.status_code == 429
    assert response.json() == {"detail": "限流"}
    assert response.headers["retry-after"] == "7"


@pytest.mark.parametrize("path", ["/api/records/", "/api/records/id/child", "/api/positions/unknown", "/api/traders/id"])
async def test_unknown_journal_never_spa(app: FastAPI, proxy: Callable, path: str) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    proxy(lambda request: pytest.fail("Unknown journal path reached Node"))
    async with client:
        response = await client.get(path)
        frontend = await client.get("/traders")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    assert frontend.status_code == 200
    assert frontend.text == "<html>frontend test</html>"


async def test_core_health_and_auth_contract_unchanged(app: FastAPI,
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_service, "is_configured", lambda: True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        health = await client.get("/health")
        core = await client.get("/api/capabilities")
        boundary = await client.get("/api/records-other")
        events = await client.get("/api/events")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert core.status_code == boundary.status_code == 401
    assert core.json() == boundary.json() == {"detail": "未登录或会话已过期"}
    # SSE 的票据认证仍由原端点返回 detail，不被日志响应映射覆盖。
    assert events.status_code == 401
    assert "detail" in events.json()


@pytest.mark.parametrize("path", [
    "/api/records", "/api/reviews", "/api/positions/current", "/api/traders",
])
@pytest.mark.parametrize(("peer", "forwarded"), [
    ("127.0.0.1", "203.0.113.7"),
    ("127.0.0.1", "unknown"),
    ("127.0.0.1", "not-an-ip"),
    # 非可信直连客户端即使伪造回环地址，也不能绕过认证。
    ("203.0.113.7", "127.0.0.1"),
])
async def test_real_forwarded_client_rejected_before_node(
    app: FastAPI, proxy: Callable, monkeypatch: pytest.MonkeyPatch,
    path: str, peer: str, forwarded: str,
) -> None:
    monkeypatch.setattr(auth_api, "_client_ip", _REAL_CLIENT_IP)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=(peer, 43210)), base_url="http://test",
    )
    proxy(lambda request: pytest.fail("Untrusted forwarded peer reached Node"))
    async with client:
        response = await client.get(path, headers={"X-Forwarded-For": forwarded})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


@pytest.mark.parametrize(("forwarded", "configured"), [
    ("192.168.10.11", False),
    ("10.1.2.3", False),
    ("203.0.113.7", True),
])
async def test_real_forwarded_lan_or_valid_public_session_allowed(
    app: FastAPI, proxy: Callable, monkeypatch: pytest.MonkeyPatch,
    forwarded: str, configured: bool,
) -> None:
    monkeypatch.setattr(auth_api, "_client_ip", _REAL_CLIENT_IP)
    monkeypatch.setattr(auth_service, "is_configured", lambda: configured)
    monkeypatch.setattr(auth_service, "is_valid_session", lambda token: token == "valid")
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 43210)), base_url="http://test",
        cookies={auth_api.COOKIE_NAME: "valid"},
    )
    proxy(lambda request: httpx.Response(200, json={"data": []}))
    async with client:
        response = await client.get("/api/traders", headers={"X-Forwarded-For": forwarded})
    assert response.status_code == 200
    assert response.json() == {"data": []}
