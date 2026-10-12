/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 缺省使用同源 /api；仅设为 mock 时使用开发示例数据。 */
  readonly VITE_TRADE_JOURNAL_SOURCE?: 'api' | 'mock'
}

declare module '*.css' {
  const content: string
  export default content
}
