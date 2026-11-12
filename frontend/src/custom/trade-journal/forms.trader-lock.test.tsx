// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordForm, ReviewForm } from './forms'
import type { ApiSuccess, DailyReview, RecordWrite, ReviewWrite, TradeRecord } from './types'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

type SaveRecord = (body: RecordWrite, original: TradeRecord | null) => Promise<ApiSuccess<TradeRecord>>
type SaveReview = (body: ReviewWrite, original: DailyReview | null) => Promise<ApiSuccess<DailyReview>>

// 非空 defaultTrader 只读，提交固定为该名称；空字符串才允许填写新交易员。
const forms = [
  ['记交易', '交易者', 'record'],
  ['写复盘', '复盘交易者', 'review'],
] as const

async function renderForm(node: ReactElement) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  dispose = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  await act(async () => {
    root.render(node)
  })
  return container
}

function traderField(container: HTMLElement, label: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
  expect(input).not.toBeNull()
  return input!
}

async function rename(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function openForm(kind: 'record' | 'review', defaultTrader: string) {
  if (kind === 'record') {
    const onSave = vi.fn<SaveRecord>().mockRejectedValue('记录请求')
    const container = await renderForm(<RecordForm record={null} defaultTrader={defaultTrader} onClose={() => {}} onSave={onSave} />)
    return { container, calls: () => onSave.mock.calls.length, trader: () => onSave.mock.calls[0]?.[0].trader }
  }
  const onSave = vi.fn<SaveReview>().mockRejectedValue('记录请求')
  const container = await renderForm(<ReviewForm review={null} defaultTrader={defaultTrader} onClose={() => {}} onSave={onSave} />)
  return { container, calls: () => onSave.mock.calls.length, trader: () => onSave.mock.calls[0]?.[0].trader }
}

it.each(forms)('%s：defaultTrader 为当前甲时只读，改名后提交仍是当前甲', async (formName, label, kind) => {
  const opened = formName === '记交易' ? '新增交易记录' : '新增每日复盘'
  const { container, calls, trader } = await openForm(kind, '当前甲')
  expect(container.querySelector(`[aria-label="${opened}"]`)).not.toBeNull()
  const input = traderField(container, label)
  expect(input.value).toBe('当前甲')
  expect(input.readOnly).toBe(true)
  await rename(input, '被改名')
  await submit(container)
  expect(calls()).toBe(1)
  expect(trader()).toBe('当前甲')
})

it.each(forms)('%s：defaultTrader 为空时可以填写新交易员乙', async (formName, label, kind) => {
  const opened = formName === '记交易' ? '新增交易记录' : '新增每日复盘'
  const { container, calls, trader } = await openForm(kind, '')
  expect(container.querySelector(`[aria-label="${opened}"]`)).not.toBeNull()
  const input = traderField(container, label)
  expect(input.readOnly).toBe(false)
  await rename(input, '新交易员乙')
  expect(input.value).toBe('新交易员乙')
  await submit(container)
  expect(calls()).toBe(1)
  expect(trader()).toBe('新交易员乙')
})
