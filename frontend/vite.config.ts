import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { BlockList, isIP } from 'node:net'

// 交易日记路径直连 Node，不经过 FastAPI 认证。只认内核填的 socket 对端，
// 不读 Host、Origin、X-Forwarded-For。127/8、::1 和 IPv4-mapped ::ffff:127/8 放行；
// 没有地址或任何其他地址时返回 false，Vite 的 bypass 会直接回 404，不转发。
const loopbackPeers = new BlockList()
loopbackPeers.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackPeers.addAddress('::1', 'ipv6')

export function isLoopbackPeerAddress(address: string | undefined): boolean {
  if (!address) return false
  const bare = address.split('%', 1)[0]?.trim() ?? ''
  const kind = isIP(bare)
  if (kind === 4) return loopbackPeers.check(bare, 'ipv4')
  if (kind === 6) return loopbackPeers.check(bare, 'ipv6')
  return false
}

export function tradeJournalProxyBypass(req: IncomingMessage): false | undefined {
  return isLoopbackPeerAddress(req.socket?.remoteAddress) ? undefined : false
}

const backendHost = process.env.BACKEND_HOST || '127.0.0.1'
const proxyHost = ['0.0.0.0', '::'].includes(backendHost) ? '127.0.0.1' : backendHost
const backendPort = process.env.BACKEND_PORT || '3018'
const backendTarget = `http://${proxyHost}:${backendPort}`
const tradeJournalTarget = 'http://127.0.0.1:3022'

// Vite 正则代理优先于通用 /api；仅 docs/api.md §1.1 的路径进 Node。
const tradeJournalPaths = '^/api/(?:records(?:[/?]|$)|reviews(?:[/?]|$)|positions/(?:current|history)(?:\\?|$))'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',   // dev.sh / dev.ps1 会用 CLI --host 覆盖
    port: 3011,
    proxy: {
      [tradeJournalPaths]: {
        target: tradeJournalTarget,
        bypass: tradeJournalProxyBypass,
      },
      // dev 时 /api 转发到与启动脚本相同的 FastAPI 地址
      '/api': {
        target: backendTarget,
        // SSE 端点需要禁用缓冲
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, req) => {
            if (req.url?.includes('/stream')) {
              _proxyReq.setHeader('Accept', 'text/event-stream')
              _proxyReq.setHeader('Cache-Control', 'no-cache')
              _proxyReq.setHeader('Connection', 'keep-alive')
            }
          })
        },
      },
      '/health': backendTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 把重型图表库拆到独立 chunk, 避免打进主包 + 让页面按需加载。
        // 用函数形式按 node_modules 路径匹配, 比对象形式更可靠。
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('echarts')) return 'echarts'
            if (id.includes('lightweight-charts')) return 'lightweight-charts'
          }
        },
      },
    },
  },
})
