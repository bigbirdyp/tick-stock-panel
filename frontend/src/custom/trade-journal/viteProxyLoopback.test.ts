import http from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { createServer, type ProxyOptions, type UserConfig, type ViteDevServer } from 'vite'
import { describe, expect, it } from 'vitest'
import viteConfig, { isLoopbackPeerAddress, tradeJournalProxyBypass } from '../../../vite.config'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function peer(address: string | undefined, headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as IncomingMessage
}

describe('交易日记代理只认回环对端', () => {
  it('放行 127/8、::1 和 IPv4-mapped ::ffff:127/8，其余包括缺地址一律拒绝', () => {
    const allowed = [
      '127.0.0.1',
      '127.0.0.0',
      '127.255.255.255',
      '::1',
      '::1%lo0',
      '::ffff:127.0.0.1',
      '::ffff:127.8.8.8',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
    ]
    for (const address of allowed) {
      expect(isLoopbackPeerAddress(address), address).toBe(true)
      expect(tradeJournalProxyBypass(peer(address)), address).toBeUndefined()
    }

    const denied = [
      undefined,
      '',
      '10.1.2.3',
      '192.168.1.20',
      '8.8.8.8',
      '0.0.0.0',
      '::',
      '::ffff:10.1.2.3',
      '::ffff:8.8.8.8',
      'localhost',
    ]
    for (const address of denied) {
      expect(isLoopbackPeerAddress(address), String(address)).toBe(false)
      expect(tradeJournalProxyBypass(peer(address)), String(address)).toBe(false)
    }

    expect(tradeJournalProxyBypass({ headers: { 'x-forwarded-for': '127.0.0.1', host: '127.0.0.1' } } as unknown as IncomingMessage)).toBe(false)
    expect(tradeJournalProxyBypass(peer('192.168.1.20', {
      host: '127.0.0.1:3011',
      origin: 'http://127.0.0.1:3011',
      'x-forwarded-for': '127.0.0.1',
    }))).toBe(false)
    expect(tradeJournalProxyBypass(peer('127.0.0.1', {
      host: '10.0.0.8',
      origin: 'http://10.0.0.8',
      'x-forwarded-for': '8.8.8.8',
    }))).toBeUndefined()
  })

  it('0.0.0.0 上的 Vite：非回环连接被拒绝，回环仍到 Node，其他 /api 仍到 FastAPI', async () => {
    const source = (viteConfig as UserConfig).server?.proxy ?? {}
    const tradeEntry = Object.entries(source).find(([key]) => key.startsWith('^'))
    expect(tradeEntry, 'trade-journal proxy key').toBeDefined()
    const tradeRoute = tradeEntry?.[1]
    if (typeof tradeRoute !== 'object' || tradeRoute == null || tradeRoute.bypass !== tradeJournalProxyBypass) {
      throw new Error('refusing to listen: trade-journal proxy has no loopback bypass')
    }
    const genericApi = source['/api']
    expect(typeof genericApi === 'object' && genericApi != null && genericApi.bypass).toBeFalsy()

    const trade = await startMarker('trade-node')
    const api = await startMarker('fastapi')
    let vite: ViteDevServer | undefined
    try {
      const proxy = retargetProxy(source, trade.origin, api.origin)
      vite = await createServer({
        configFile: false,
        root: frontendRoot,
        logLevel: 'silent',
        appType: 'custom',
        server: {
          host: '0.0.0.0',
          port: 0,
          strictPort: false,
          hmr: false,
          watch: null,
          proxy,
        },
      })
      await vite.listen()
      const bound = vite.httpServer?.address()
      if (!bound || typeof bound === 'string') throw new Error('vite did not bind a tcp port')
      const port = bound.port

      const loopRecords = await request(`http://127.0.0.1:${port}/api/records?limit=1`)
      const lan = await firstLanResponse(port, '/api/records')
      const loopSettings = await request(`http://127.0.0.1:${port}/api/settings`)
      const lanSettings = lan
        ? await request(`http://${lan.host}:${port}/api/settings`)
        : undefined
      const spoofed = lan
        ? await request(`http://${lan.host}:${port}/api/records`, {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-forwarded-for': '127.0.0.1',
        })
        : undefined

      const observed = {
        loopbackRecords: loopRecords.status,
        lanRecords: lan?.response.status ?? null,
        lanHost: lan?.host ?? null,
        spoofedLanRecords: spoofed?.status ?? null,
        loopbackSettings: loopSettings.status,
        lanSettings: lanSettings?.status ?? null,
        tradeHits: trade.hits,
        apiHits: api.hits,
      }
      console.info(`trade-journal proxy statuses ${JSON.stringify(observed)}`)

      expect(loopRecords.status).toBe(200)
      expect(loopRecords.body).toContain('trade-node')
      expect(loopSettings.status).toBe(200)
      expect(loopSettings.body).toContain('fastapi')
      expect(loopSettings.body).not.toContain('trade-node')

      if (!lan || !lanSettings || !spoofed) {
        throw new Error(`no non-loopback interface accepted a connection; synthetic socket cases still ran. candidates=${JSON.stringify(lanCandidates())}`)
      }
      expect(lan.response.status).toBe(404)
      expect(lan.response.body).not.toContain('trade-node')
      expect(spoofed.status).toBe(404)
      expect(spoofed.body).not.toContain('trade-node')
      expect(lanSettings.status).toBe(200)
      expect(lanSettings.body).toContain('fastapi')
      expect(trade.hits).toBe(1)
      expect(api.hits).toBe(2)
    } finally {
      if (vite) await vite.close()
      await trade.close()
      await api.close()
    }
  }, 40_000)
})

function lanCandidates(): string[] {
  const found: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      found.push(entry.address)
    }
  }
  return found
}

function retargetProxy(
  source: NonNullable<UserConfig['server']>['proxy'],
  tradeOrigin: string,
  apiOrigin: string,
): Record<string, string | ProxyOptions> {
  const next: Record<string, string | ProxyOptions> = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'string') {
      next[key] = apiOrigin
      continue
    }
    const target = String(value.target ?? '')
    next[key] = {
      ...value,
      target: target === 'http://127.0.0.1:3022' ? tradeOrigin : apiOrigin,
    }
  }
  return next
}

function startMarker(marker: string): Promise<{ origin: string, hits: number, close: () => Promise<void> }> {
  const state = { hits: 0 }
  const server = http.createServer((req, res) => {
    state.hits += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${marker} ${req.url ?? ''}`)
  })
  return listen(server, '127.0.0.1').then((port) => ({
    origin: `http://127.0.0.1:${port}`,
    get hits() {
      return state.hits
    },
    close: () => closeServer(server),
  }))
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo | null
      if (!address) {
        reject(new Error('missing listen address'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function request(url: string, headers?: http.OutgoingHttpHeaders): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.setTimeout(2000, () => req.destroy(new Error(`timeout ${url}`)))
    req.on('error', reject)
  })
}

async function firstLanResponse(port: number, pathname: string): Promise<{ host: string, response: { status: number, body: string } } | undefined> {
  for (const host of lanCandidates()) {
    try {
      const response = await request(`http://${host}:${port}${pathname}`)
      return { host, response }
    } catch {
      continue
    }
  }
  return undefined
}
