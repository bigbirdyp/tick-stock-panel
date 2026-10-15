"""交易日志 HTTP 边界：认证由主应用执行，账本仍由单个本机 Node 进程管理。"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.requests import ClientDisconnect

from app.config import settings

MAX_BODY_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_PREFIXES = ("/api/records", "/api/reviews", "/api/positions", "/api/traders")
_METHODS = ["GET", "POST", "PATCH", "DELETE", "PUT", "HEAD", "OPTIONS", "TRACE", "CONNECT"]
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
router = APIRouter(include_in_schema=False)


def is_trade_journal_path(path: str) -> bool:
    """只占用完整日志命名空间，避免影响 records-other 等其他接口。"""
    return any(path == prefix or path.startswith(prefix + "/") for prefix in _PREFIXES)


def journal_error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}},
        headers={"X-Content-Type-Options": "nosniff"},
    )


def _headers(headers: httpx.Headers | Iterable[tuple[str, str]], *, incoming: bool) -> dict[str, str]:
    values = httpx.Headers(headers)
    excluded = _HOP_HEADERS | {
        name.strip().lower() for name in values.get("connection", "").split(",")
    }
    # HTTPX 会解压响应，长度与编码必须重新由 ASGI 生成；浏览器凭证止于认证层。
    excluded |= {"content-length", "content-encoding"} if not incoming else {
        "host", "cookie", "authorization", "content-length",
    }
    if not incoming:
        excluded |= {"set-cookie"}
    return {key: value for key, value in values.items() if key.lower() not in excluded}


def _supported(path: str, method: str) -> bool:
    if path in {"/api/records", "/api/reviews"}:
        return method in {"GET", "POST"}
    if re.fullmatch(r"/api/(records|reviews)/[^/\\]+", path):
        return path.rsplit("/", 1)[1] not in {".", ".."} and method in {"GET", "PATCH", "DELETE"}
    return path in {"/api/traders", "/api/positions/current", "/api/positions/history"} and method == "GET"


async def proxy_trade_journal(request: Request) -> Response:
    path = request.scope["path"]
    raw_path = request.scope.get("raw_path", path.encode("utf-8"))
    if not _supported(path, request.method) or re.search(br"%2f|%5c", raw_path, re.IGNORECASE):
        return journal_error(404, "NOT_FOUND", "指定接口不存在")
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                return journal_error(400, "BAD_REQUEST", "请求体超过大小限制")
            body.extend(chunk)
    except ClientDisconnect:
        return journal_error(400, "BAD_REQUEST", "请求已断开")
    raw_query = request.scope.get("query_string", b"")
    target = httpx.URL(
        scheme="http", host="127.0.0.1", port=settings.trade_journal_port,
        raw_path=raw_path + (b"?" + raw_query if raw_query else b""),
    )
    try:
        # 每次请求独立关闭连接，无写请求重试，也不跟随上游重定向。
        async with httpx.AsyncClient(
            timeout=settings.trade_journal_timeout_s, trust_env=False, follow_redirects=False,
        ) as client, client.stream(
            request.method, target, headers=_headers(request.headers.items(), incoming=True),
            content=bytes(body),
        ) as upstream:
            if 300 <= upstream.status_code < 400:
                return journal_error(502, "BAD_GATEWAY", "交易日志服务响应无效")
            if upstream.status_code == 204:
                return Response(status_code=204, headers=_headers(upstream.headers, incoming=False))
            media_type = upstream.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                return journal_error(502, "BAD_GATEWAY", "交易日志服务响应无效")
            response_body = bytearray()
            async for chunk in upstream.aiter_bytes():
                if len(response_body) + len(chunk) > MAX_RESPONSE_BYTES:
                    return journal_error(502, "BAD_GATEWAY", "交易日志服务响应超过大小限制")
                response_body.extend(chunk)
            try:
                json.loads(response_body)
            except (ValueError, UnicodeDecodeError):
                return journal_error(502, "BAD_GATEWAY", "交易日志服务响应无效")
            response_headers = _headers(upstream.headers, incoming=False)
            response_headers["content-type"] = "application/json; charset=utf-8"
            response_headers["x-content-type-options"] = "nosniff"
            return Response(
                content=bytes(response_body), status_code=upstream.status_code,
                headers=response_headers,
            )
    except httpx.TimeoutException:
        return journal_error(504, "GATEWAY_TIMEOUT", "交易日志服务请求超时，请先核对写入结果")
    except httpx.HTTPError:
        return journal_error(502, "BAD_GATEWAY", "交易日志服务暂不可用")


for _prefix in _PREFIXES:
    router.add_api_route(_prefix, proxy_trade_journal, methods=_METHODS)
    router.add_api_route(_prefix + "/{rest:path}", proxy_trade_journal, methods=_METHODS)
