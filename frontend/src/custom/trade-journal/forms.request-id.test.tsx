// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordForm } from './forms'
import type { ApiSuccess, RecordWrite, TradeRecord } from './types'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
})

function browserCrypto(hasRandomUUID: boolean) {
  let generation = 0
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(++generation)
    return bytes
  })
  vi.stubGlobal('crypto', {
    getRandomValues,
    ...(hasRandomUUID ? { randomUUID: () => `request-${++generation}` } : {}),
  })
}

type SaveRecord = (body: RecordWrite, original: TradeRecord | null) => Promise<ApiSuccess<TradeRecord>>

async function renderForm(onSave: SaveRecord) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  dispose = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await act(async () => {
    root.render(<RecordForm record={null} defaultTrader="HTTP回归" onClose={() => {}} onSave={onSave} />)
  })
  return container
}

async function setInput(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

it.each([true, false])('randomUUID 可用=%s 时均能打开并填写记交易表单', async hasRandomUUID => {
  browserCrypto(hasRandomUUID)
  const container = await renderForm(vi.fn<SaveRecord>().mockRejectedValue(new Error('网络中断')))
  expect(container.querySelector('[aria-label="新增交易记录"]')).not.toBeNull()
  await setInput(container, '股票代码', '000001')
  expect(container.querySelector<HTMLInputElement>('[aria-label="股票代码"]')!.value).toBe('000001')
})

it('HTTP 环境保持未修改草稿的重试键，修改草稿或重新打开时生成新键', async () => {
  browserCrypto(false)
  const onSave = vi.fn<SaveRecord>().mockRejectedValue(new Error('网络中断'))
  let container = await renderForm(onSave)
  await setInput(container, '股票代码', '000001')
  await setInput(container, '股票名称', '平安银行')
  await setInput(container, '成交价', '10')
  await setInput(container, '数量', '100')

  await submit(container)
  const firstId = onSave.mock.calls[0][0].client_request_id
  expect(typeof firstId).toBe('string')
  expect(firstId!.length).toBeGreaterThan(0)
  expect(firstId!.length).toBeLessThanOrEqual(80)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络中断')

  await submit(container)
  expect(onSave.mock.calls[1][0].client_request_id).toBe(firstId)

  await setInput(container, '成交价', '11')
  await submit(container)
  expect(onSave.mock.calls[2][0].client_request_id).not.toBe(firstId)

  await dispose!()
  dispose = undefined
  container = await renderForm(onSave)
  await setInput(container, '股票代码', '000001')
  await setInput(container, '股票名称', '平安银行')
  await setInput(container, '成交价', '11')
  await setInput(container, '数量', '100')
  await submit(container)
  expect(onSave.mock.calls[3][0].client_request_id).not.toBe(firstId)
  expect(onSave.mock.calls[3][0].client_request_id).not.toBe(onSave.mock.calls[2][0].client_request_id)
})
