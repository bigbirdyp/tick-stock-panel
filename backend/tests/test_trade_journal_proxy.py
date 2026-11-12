"""代理测试只使用 ASGI/MockTransport，不访问开发服务或真实账本。"""
from __future__ import annotations

import gzip
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from app.api import trade_journal
from app.config import Settings


@pytest.fixture
def app() -> FastAPI:
    application = FastAPI()
    application.include_router(trade_journal.router)
    return application


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Callable:
    original = httpx.AsyncClient

    def install(handler: Callable) -> None:
        def client(**kwargs: object) -> httpx.AsyncClient:
            assert kwargs["trust_env"] is False
            assert kwargs["follow_redirects"] is False
            return original(transport=httpx.MockTransport(handler), **kwargs)
        monkeypatch.setattr(trade_journal.httpx, "AsyncClient", client)

    return install


@pytest.mark.parametrize(("method", "path", "status"), [
    ("GET", "/api/records", 200), ("POST", "/api/records", 201),
    ("GET", "/api/records/id", 200), ("PATCH", "/api/records/id", 200),
    ("DELETE", "/api/records/id", 204),
    ("GET", "/api/reviews", 200), ("POST", "/api/reviews", 201),
    ("GET", "/api/reviews/id", 200), ("PATCH", "/api/reviews/id", 200),
    ("DELETE", "/api/reviews/id", 204), ("GET", "/api/traders", 200),
    ("GET", "/api/positions/current", 200), ("GET", "/api/positions/history", 200),
])
async def test_forward_methods_query_utf8_and_status(app: FastAPI, upstream: Callable,
                                                   method: str, path: str, status: int) -> None:
    body = '{"trader":"交易人","review_count":3}'.encode()
    query = b"trader=%E4%BA%A4%E6%98%93%E4%BA%BA&x=&x=2"
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == method
        assert request.url.host == "127.0.0.1"
        assert request.url.port == 3022
        assert request.url.raw_path == path.encode() + b"?" + query
        assert request.content == body
        assert "authorization" not in request.headers
        assert "cookie" not in request.headers
        assert "x-secret" not in request.headers
        return httpx.Response(status, json={"data": {"trader": "交易人"}},
                              headers={"X-Content-Type-Options": "nosniff"})
    # 创建测试客户端后再替换仅上游使用的构造器。
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    upstream(handler)
    async with client:
        response = await client.request(method, path + "?" + query.decode(), content=body,
            headers={"content-type": "application/json", "authorization": "Bearer secret",
                     "cookie": "session=secret", "connection": "x-secret", "x-secret": "secret"})
    assert response.status_code == status
    assert response.content == b"" if status == 204 else response.json() == {"data": {"trader": "交易人"}}


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422, 428])
async def test_preserves_business_error(app: FastAPI, upstream: Callable, status: int) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    payload = {"error": {"code": "VALIDATION_ERROR", "message": "原始消息", "details": ["trader"]}}
    upstream(lambda request: httpx.Response(status, json=payload))
    async with client:
        response = await client.get("/api/records")
    assert response.status_code == status
    assert response.json() == payload


@pytest.mark.parametrize(("path", "method"), [
    ("/api/records/", "GET"), ("/api/reviews/id/child", "GET"),
    ("/api/positions/unknown", "GET"), ("/api/traders/", "GET"),
    ("/api/records", "PUT"), ("/api/positions/current", "POST"),
    ("/api/records/a%2Fb", "GET"), ("/api/records/a%5Cb", "GET"),
])
async def test_unknown_boundary_returns_json_without_upstream(app: FastAPI, upstream: Callable,
                                                             path: str, method: str) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    def unexpected(request: httpx.Request) -> httpx.Response:
        pytest.fail("Unknown journal request reached upstream")
    upstream(unexpected)
    async with client:
        response = await client.request(method, path)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_chunked_body_limit_without_content_length(app: FastAPI, upstream: Callable) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    async def chunks() -> AsyncIterator[bytes]:
        yield b"x" * trade_journal.MAX_BODY_BYTES
        yield b"x"
    def unexpected(request: httpx.Request) -> httpx.Response:
        pytest.fail("Oversized request reached upstream")
    upstream(unexpected)
    async with client:
        response = await client.post("/api/records", content=chunks())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_REQUEST"


@pytest.mark.parametrize(("kind", "status", "code"), [
    ("timeout", 504, "GATEWAY_TIMEOUT"), ("connect", 502, "BAD_GATEWAY"),
    ("html", 502, "BAD_GATEWAY"), ("invalid_json", 502, "BAD_GATEWAY"),
    ("json_redirect", 502, "BAD_GATEWAY"),
    ("large", 502, "BAD_GATEWAY"),
])
async def test_safe_failure_no_retry(app: FastAPI, upstream: Callable, monkeypatch: pytest.MonkeyPatch,
                                   kind: str, status: int, code: str) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    calls = []
    monkeypatch.setattr(trade_journal, "MAX_RESPONSE_BYTES", 10)
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if kind == "timeout":
            raise httpx.ReadTimeout("secret server details", request=request)
        if kind == "connect":
            raise httpx.ConnectError("secret server details", request=request)
        if kind == "html":
            return httpx.Response(302, text="<html>", headers={"Location": "http://evil"})
        if kind == "json_redirect":
            return httpx.Response(302, json={}, headers={"Location": "http://evil"})
        return httpx.Response(200, content=b"x" * (20 if kind == "large" else 1),
                              headers={"Content-Type": "application/json"})
    upstream(handler)
    async with client:
        response = await client.post("/api/reviews", content=b"{}")
    assert len(calls) == 1
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert "secret" not in response.text


async def test_decoded_response_removes_stale_and_hop_headers(app: FastAPI, upstream: Callable) -> None:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    payload = b'{"data":[]}'
    upstream(lambda request: httpx.Response(200, content=gzip.compress(payload), headers={
        "Content-Type": "application/json", "Content-Encoding": "gzip", "Connection": "x-internal",
        "x-internal": "secret", "Set-Cookie": "secret=1", "Content-Length": "31"}))
    async with client:
        response = await client.get("/api/traders")
    assert response.content == payload
    assert response.headers["content-length"] == str(len(payload))
    assert not {"content-encoding", "connection", "x-internal", "set-cookie"} & response.headers.keys()


@pytest.mark.parametrize("path", ["/api/records", "/api/reviews/id", "/api/positions/unknown", "/api/traders/"])
def test_auth_boundary(path: str) -> None:
    assert trade_journal.is_trade_journal_path(path)


@pytest.mark.parametrize("path", ["/api/records-other", "/api/reviews2", "/api/paper/positions", "//evil/api/records"])
def test_other_routes_do_not_match(path: str) -> None:
    assert not trade_journal.is_trade_journal_path(path)


@pytest.mark.parametrize("port", [0, 65536, 3018])
def test_invalid_or_self_proxy_port_rejected(port: int) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, port=3018, trade_journal_port=port)
