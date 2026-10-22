// html zoom 下 zrender 直接抄 offsetX/Y，会和 canvas 像素错位。
// capture 先于 zrender 写入 zrX/zrY；已有值会被保留。不含 wheel，避免漏掉 zrDelta。

const ZOOM_POINTER_EVENTS = [
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

type ZoomMouseEvent = MouseEvent & { zrX?: number; zrY?: number }

function correctZoomPointer(event: Event): void {
  if (!(event instanceof MouseEvent)) return
  const target = event.target
  if (!(target instanceof HTMLCanvasElement)) return
  const rect = target.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return
  const patched = event as ZoomMouseEvent
  patched.zrX = (event.clientX - rect.left) * target.clientWidth / rect.width
  patched.zrY = (event.clientY - rect.top) * target.clientHeight / rect.height
}

/** 在容器上以捕获阶段绑定坐标归一，返回卸载函数。须早于 echarts.init。 */
export function bindEchartsPointer(el: HTMLElement): () => void {
  for (const type of ZOOM_POINTER_EVENTS) {
    el.addEventListener(type, correctZoomPointer, true)
  }
  return () => {
    for (const type of ZOOM_POINTER_EVENTS) {
      el.removeEventListener(type, correctZoomPointer, true)
    }
  }
}
