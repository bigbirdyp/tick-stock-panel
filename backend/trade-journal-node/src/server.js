import { createServer } from 'node:http';
import { ApiError, listQuery, recordInput, reviewInput, tradersQuery, versionQuery } from './validation.js';

const MAX_BODY_BYTES = 1024 * 1024;

function reply(response, status, value) {
  response.statusCode = status;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (status === 204) return response.end();
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function jsonBody(request) {
  const parts = request.headers['content-type']?.split(';').map((part) => part.trim().toLowerCase());
  const contentType = parts?.[0];
  if (contentType !== 'application/json') throw new ApiError(400, 'BAD_REQUEST', 'Content-Type 必须是 application/json');
  const charset = parts.slice(1).find((part) => part.startsWith('charset='));
  if (charset && charset !== 'charset=utf-8') throw new ApiError(400, 'BAD_REQUEST', 'JSON 请求体必须使用 UTF-8');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(400, 'BAD_REQUEST', '请求体超过大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, 'BAD_REQUEST', 'JSON 语法错误'); }
}

function deleteVersion(params) {
  if ([...params.keys()].some((key) => key !== 'expected_version') || params.getAll('expected_version').length > 1) {
    throw new ApiError(422, 'VALIDATION_ERROR', '删除请求只接受一个 expected_version');
  }
  return versionQuery(params);
}

async function route(request, response, store) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const { pathname, searchParams } = url;
  const method = request.method;

  if (pathname === '/api/records') {
    if (method === 'GET') return reply(response, 200, { data: store.listRecords(listQuery(searchParams, 'records')) });
    if (method === 'POST') {
      const result = store.createRecord(recordInput(await jsonBody(request)));
      return reply(response, result.duplicate ? 200 : 201,
        result.duplicate ? { data: result.record, meta: { duplicate: true } } : { data: result.record });
    }
  }

  const recordId = /^\/api\/records\/([^/]+)$/.exec(pathname)?.[1];
  if (recordId) {
    if (method === 'GET') return reply(response, 200, { data: store.getRecord(recordId) });
    if (method === 'PATCH') return reply(response, 200, { data: store.patchRecord(recordId, recordInput(await jsonBody(request), true)) });
    if (method === 'DELETE') {
      store.deleteRecord(recordId, deleteVersion(searchParams));
      return reply(response, 204);
    }
  }

  if (pathname === '/api/reviews') {
    if (method === 'GET') return reply(response, 200, { data: store.listReviews(listQuery(searchParams, 'reviews')) });
    if (method === 'POST') return reply(response, 201, { data: store.createReview(reviewInput(await jsonBody(request))) });
  }

  const reviewId = /^\/api\/reviews\/([^/]+)$/.exec(pathname)?.[1];
  if (reviewId) {
    if (method === 'GET') return reply(response, 200, { data: store.getReview(reviewId) });
    if (method === 'PATCH') return reply(response, 200, { data: store.patchReview(reviewId, reviewInput(await jsonBody(request), true)) });
    if (method === 'DELETE') {
      store.deleteReview(reviewId, deleteVersion(searchParams));
      return reply(response, 204);
    }
  }

  if (pathname === '/api/traders' && method === 'GET') {
    tradersQuery(searchParams);
    return reply(response, 200, { data: store.listTraders() });
  }

  if (pathname === '/api/positions/current' && method === 'GET') {
    return reply(response, 200, { data: store.current(listQuery(searchParams, 'current')) });
  }
  if (pathname === '/api/positions/history' && method === 'GET') {
    return reply(response, 200, { data: store.history(listQuery(searchParams, 'history')) });
  }
  throw new ApiError(404, 'NOT_FOUND', '指定接口不存在');
}

export function createApp(store) {
  const server = createServer((request, response) => {
    route(request, response, store).catch((error) => {
      if (error instanceof ApiError) {
        const payload = { code: error.code, message: error.message };
        if (error.details) payload.details = error.details;
        reply(response, error.status, { error: payload });
      } else {
        console.error('[trade-journal-node] request failed', error);
        reply(response, 500, { error: { code: 'INTERNAL_ERROR', message: '服务端处理请求失败' } });
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
