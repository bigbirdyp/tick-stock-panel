/**
 * 代码与名称的共享展示。
 *
 * 只负责把 code、name 和调用方塞进来的 children（板块标、实时圆点）按原顺序画出来。
 * 能不能打开、打开哪一只，都由 onClick 交给调用方；这里不校验 symbol，也不发请求。
 * 没有 onClick 时用同外观的 span，避免不可点的代码被当成按钮。
 * Enter/Space 留给原生 button，组件不另行监听或拦截。
 */
import type { ReactElement, ReactNode } from 'react'

const SHELL_CLASS = 'flex items-center gap-1 text-left min-w-0'
const CODE_CLASS = 'font-mono text-foreground text-xs group-hover:text-accent transition-colors duration-150'
const NAME_CLASS = 'text-xs text-secondary truncate group-hover:text-foreground transition-colors duration-150'

export type StockCellProps = {
  code: string
  /** 空字符串、null、undefined 不渲染名称。纯空白仍显示，沿用自选原来的 truthy 判断。 */
  name?: string | null
  children?: ReactNode
  onClick?: () => void
  'aria-label'?: string
}

export function StockCell({
  code,
  name,
  children,
  onClick,
  'aria-label': ariaLabel,
}: StockCellProps): ReactElement {
  const content = (
    <>
      <span className={CODE_CLASS}>{code}</span>
      {name ? <span className={NAME_CLASS}>{name}</span> : null}
      {children}
    </>
  )

  if (onClick) {
    return (
      <button type="button" className={SHELL_CLASS} aria-label={ariaLabel} onClick={() => { onClick() }}>
        {content}
      </button>
    )
  }

  return (
    <span className={SHELL_CLASS} aria-label={ariaLabel}>
      {content}
    </span>
  )
}
