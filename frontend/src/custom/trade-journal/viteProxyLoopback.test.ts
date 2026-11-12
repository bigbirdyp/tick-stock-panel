import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo, Server } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ProxyOptions, type UserConfig, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import viteConfig from '../../../vite.config'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const source = (viteConfig as UserConfig).server?.proxy ?? {}
type ObservedRequest = { method: string, url: string, body: string, headers: http.IncomingHttpHeaders }
type ObservedResponse = { status: number, body: string, headers: http.IncomingHttpHeaders }

describe('Vite 的全部 API 统一经过 FastAPI', () => {
  let backend: Server
  let vite: ViteDevServer
  let origin: string
  const received: ObservedRequest[] = []

  beforeAll(async () => {
    backend = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const observation = {
        method: req.method ?? '', url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'), headers: req.headers,
      }
      received.push(observation)
      if (req.method === 'DELETE') {
        res.writeHead(204)
        res.end()
      } else if (req.url?.startsWith('/api/events/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('event: update\ndata: {"ok":true}\n\n')
      } else {
        const status = Number(req.headers['x-test-status'] ?? (req.method === 'POST' ? 201 : 200))
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(status >= 400
          ? { error: { code: `TEST_${status}`, message: '后端返回错误' } }
          : { backend: 'fastapi', ...observation }))
      }
    })
    const backendPort = await listen(backend)
    const proxy: Record<string, string | ProxyOptions> = {}
    for (const [key, value] of Object.entries(source)) {
      proxy[key] = typeof value === 'string'
        ? `http://127.0.0.1:${backendPort}`
        : { ...value, target: `http://127.0.0.1:${backendPort}` }
    }
    vite = await createServer({
      configFile: false, root: frontendRoot, logLevel: 'silent', appType: 'custom',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, proxy },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite did not bind an ephemeral TCP port')
    origin = `http://127.0.0.1:${address.port}`
  }, 20_000)

  afterAll(async () => {
    if (vite) await vite.close()
    if (backend) await closeServer(backend)
  })

  it('没有交易日记直连分支，/api 和 /health 都以 3018 为目标', () => {
    expect(Object.keys(source).sort()).toEqual(['/api', '/health'])
    const target = typeof source['/api'] === 'string' ? source['/api'] : source['/api'].target
    expect(new URL(String(target)).port).toBe('3018')
    expect(source['/health']).toBe(target)
    expect(typeof source['/api'] === 'object' && source['/api'].bypass).toBeFalsy()
  })

  it.each([undefined, '203.0.113.7', '127.0.0.1, 203.0.113.7'])('真实代理覆盖客户端 XFF=%s', async (forwarded) => {
    const response = await request(`${origin}/api/records`, {
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).headers['x-forwarded-for']).toBe('127.0.0.1')
  })

  it.each([
    ['203.0.113.7', '203.0.113.7'], ['192.168.1.20', '192.168.1.20'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'], [undefined, 'unknown'], ['', 'unknown'],
  ])('转发可信 socket 对端 %s，缺失地址不退回本机', (peer, expected) => {
    const api = source['/api']
    if (typeof api !== 'object' || !api.configure) throw new Error('API proxy has no configure handler')
    const proxy = new EventEmitter()
    api.configure(proxy as Parameters<NonNullable<ProxyOptions['configure']>>[0], api)
    const headers: Record<string, string> = {}
    proxy.emit('proxyReq', {
      setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
    }, {
      url: '/api/records', socket: { remoteAddress: peer },
      headers: { 'x-forwarded-for': '127.0.0.1', host: 'localhost', origin: 'http://localhost' },
    })
    expect(headers['x-forwarded-for']).toBe(expected)
  })

  it.each([
    '/api/records', '/api/records/record-1', '/api/reviews', '/api/reviews/review-1',
    '/api/positions/current', '/api/positions/history', '/api/traders',
  ])('读接口 %s 到同一个后端并返回 JSON', async (pathname) => {
    const response = await request(`${origin}${pathname}`)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body)).toMatchObject({ backend: 'fastapi', url: pathname, method: 'GET' })
  })

  it('保留重复、空值和中文查询参数的原始编码', async () => {
    const pathname = '/api/records?trader=AI&trader=&name=%E4%BA%A4%E6%98%93%E4%BA%BA&empty&plus=a+b'
    const response = await request(`${origin}${pathname}`)
    expect(JSON.parse(response.body).url).toBe(pathname)
  })

  it.each(['/api/records', '/api/reviews'])('POST %s 保留 UTF-8 请求和认证/幂等头、201 响应', async (pathname) => {
    const body = JSON.stringify({ trader: '交易员甲', symbol: '600000.SH' })
    const response = await request(`${origin}${pathname}`, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/json', cookie: 'session=test-session',
        authorization: 'Bearer test-token', 'idempotency-key': 'test-request',
      },
    })
    expect(response.status).toBe(201)
    expect(JSON.parse(response.body)).toMatchObject({
      backend: 'fastapi', method: 'POST', url: pathname, body,
      headers: { cookie: 'session=test-session', authorization: 'Bearer test-token', 'idempotency-key': 'test-request' },
    })
  })

  it.each(['/api/records/record-1', '/api/reviews/review-1'])('PATCH 和 DELETE %s 保留方法、JSON 和 204 空体', async (pathname) => {
    const body = JSON.stringify({ trader: '复盘交易员' })
    const patched = await request(`${origin}${pathname}`, { method: 'PATCH', body, headers: { 'content-type': 'application/json' } })
    expect(patched.status).toBe(200)
    expect(JSON.parse(patched.body)).toMatchObject({ backend: 'fastapi', method: 'PATCH', body })
    const deleted = await request(`${origin}${pathname}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(deleted.body).toBe('')
    expect(received.at(-1)).toMatchObject({ method: 'DELETE', url: pathname })
  })

  it.each([400, 401, 403, 404, 409, 422, 428, 502, 504])('保留后端 %s 和错误 JSON', async (status) => {
    const response = await request(`${origin}/api/reviews`, { headers: { 'x-test-status': String(status) } })
    expect(response.status).toBe(status)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body)).toEqual({ error: { code: `TEST_${status}`, message: '后端返回错误' } })
  })

  it.each(['/api/settings', '/health'])('普通接口 %s 仍经过后端', async (pathname) => {
    const response = await request(`${origin}${pathname}`)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ backend: 'fastapi', url: pathname })
  })

  it('保留 SSE 请求头、响应类型和事件内容', async () => {
    const response = await request(`${origin}/api/events/stream`)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.body).toBe('event: update\ndata: {"ok":true}\n\n')
    expect(received.at(-1)?.headers).toMatchObject({
      accept: 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    })
  })
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      if (!address) return reject(new Error('Missing backend listen address'))
      resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function request(url: string, options: { method?: string, body?: string, headers?: http.OutgoingHttpHeaders } = {}): Promise<ObservedResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.setTimeout(2000, () => req.destroy(new Error(`Timeout ${url}`)))
    req.on('error', reject)
    req.end(options.body)
  })
}
