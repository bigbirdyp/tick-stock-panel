// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { bindEchartsPointer } from './echartsPointer'

type ZoomMouseEvent = MouseEvent & { zrX?: number; zrY?: number }

const POINTER_EVENTS = [
  'mousemove',
  'pointermove',
  'mousedown',
  'pointerdown',
  'mouseup',
  'pointerup',
  'mouseout',
  'pointerout',
  'click',
  'dblclick',
  'contextmenu',
] as const

function mountScaledCanvas(scale: { width: number; height: number }) {
  const el = document.createElement('div')
  const canvas = el.appendChild(document.createElement('canvas'))
  Object.defineProperties(canvas, {
    clientWidth: { value: 600, configurable: true },
    clientHeight: { value: 400, configurable: true },
  })
  viRect(canvas, scale.width, scale.height)
  document.body.appendChild(el)
  return { el, canvas }
}

function viRect(canvas: HTMLCanvasElement, width: number, height: number) {
  canvas.getBoundingClientRect = () => ({
    left: 100,
    top: 200,
    width,
    height,
    right: 100 + width,
    bottom: 200 + height,
    x: 100,
    y: 200,
    toJSON() {},
  }) as DOMRect
}

function zoomEvent(type: string): ZoomMouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: 370, clientY: 380 }) as ZoomMouseEvent
  Object.defineProperty(event, 'offsetX', { value: 270 })
  Object.defineProperty(event, 'offsetY', { value: 180 })
  return event
}

afterEach(() => {
  document.body.replaceChildren()
})

it('90% 与 100% 按容器比例换算，且不改 offsetX/Y', () => {
  const { el, canvas } = mountScaledCanvas({ width: 540, height: 360 })
  const unbind = bindEchartsPointer(el)
  const seen: Array<number | undefined> = []
  canvas.addEventListener('mousemove', (event) => {
    seen.push((event as ZoomMouseEvent).zrX)
  })

  const scales = [
    { name: '90%', width: 540, height: 360, expected: [300, 200] },
    { name: '100%', width: 600, height: 400, expected: [270, 180] },
  ] as const

  for (const scale of scales) {
    viRect(canvas, scale.width, scale.height)
    const event = zoomEvent('mousemove')
    canvas.dispatchEvent(event)
    expect(seen.at(-1), scale.name).toBe(scale.expected[0])
    expect([event.zrX, event.zrY], scale.name).toEqual(scale.expected)
    expect([event.offsetX, event.offsetY], scale.name).toEqual([270, 180])
  }

  unbind()
})

it('列出的指针事件都会归一，wheel 与非鼠标事件保持原样', () => {
  const { el, canvas } = mountScaledCanvas({ width: 540, height: 360 })
  const unbind = bindEchartsPointer(el)

  for (const type of POINTER_EVENTS) {
    const event = zoomEvent(type)
    canvas.dispatchEvent(event)
    expect([event.zrX, event.zrY], type).toEqual([300, 200])
    expect([event.offsetX, event.offsetY], type).toEqual([270, 180])
  }

  const wheel = new WheelEvent('wheel', { bubbles: true, clientX: 370, clientY: 380, deltaY: 4 })
  Object.defineProperty(wheel, 'offsetX', { value: 270 })
  Object.defineProperty(wheel, 'offsetY', { value: 180 })
  canvas.dispatchEvent(wheel)
  expect((wheel as ZoomMouseEvent).zrX).toBeUndefined()
  expect((wheel as ZoomMouseEvent).zrY).toBeUndefined()
  expect([wheel.offsetX, wheel.offsetY]).toEqual([270, 180])

  const raw = new Event('mousemove', { bubbles: true })
  canvas.dispatchEvent(raw)
  expect((raw as ZoomMouseEvent).zrX).toBeUndefined()

  const onHost = zoomEvent('mousemove')
  el.dispatchEvent(onHost)
  expect(onHost.zrX).toBeUndefined()

  viRect(canvas, 0, 360)
  const flat = zoomEvent('mousemove')
  canvas.dispatchEvent(flat)
  expect(flat.zrX).toBeUndefined()

  viRect(canvas, 540, -1)
  const negative = zoomEvent('mousemove')
  canvas.dispatchEvent(negative)
  expect(negative.zrY).toBeUndefined()

  unbind()
})

it('cleanup 之后不再改写坐标，再次绑定才恢复', () => {
  const { el, canvas } = mountScaledCanvas({ width: 600, height: 400 })
  const unbind = bindEchartsPointer(el)
  unbind()

  const after = zoomEvent('mousemove')
  canvas.dispatchEvent(after)
  expect(after.zrX).toBeUndefined()
  expect([after.offsetX, after.offsetY]).toEqual([270, 180])

  const rebound = bindEchartsPointer(el)
  const again = zoomEvent('mousemove')
  canvas.dispatchEvent(again)
  expect([again.zrX, again.zrY]).toEqual([270, 180])
  rebound()
})
