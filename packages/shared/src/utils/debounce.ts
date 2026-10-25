/**
 * 共享轻量防抖器（主进程 / 渲染进程通用，零依赖）
 *
 * 与 lodash.debounce 的差异：
 * - 额外支持 maxWait，避免持续 WAL 追加导致同步永远不触发；
 * - 计时器统一 unref（Node 环境不阻塞 Electron 进程退出；浏览器环境 timer 无 unref，
 *   通过可选链安全跳过）。
 *
 * 跨环境说明：
 * - 使用 `ReturnType<typeof setTimeout>` 适配 Node（NodeJS.Timeout）与浏览器（number）；
 * - `Date.now()` / `setTimeout` / `clearTimeout` 在两端均原生可用。
 */

export interface CsLabDebounced {
  (): void
  cancel(): void
  flush(): void
}

export function createDebouncer(
  callback: () => void,
  waitMs: number,
  maxWaitMs = waitMs * 4,
): CsLabDebounced {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstCallAt = 0

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const invoke = (): void => {
    clear()
    firstCallAt = 0
    callback()
  }

  const debounced = (() => {
    const now = Date.now()
    if (firstCallAt === 0) firstCallAt = now
    clear()
    const elapsed = now - firstCallAt
    const delay = Math.max(0, Math.min(waitMs, maxWaitMs - elapsed))
    timer = setTimeout(invoke, delay)
    // Node 环境：unref 避免计时器阻塞进程退出；浏览器环境无此方法，可选链安全跳过。
    ;(timer as { unref?: () => void }).unref?.()
  }) as CsLabDebounced

  debounced.cancel = (): void => {
    clear()
    firstCallAt = 0
  }

  debounced.flush = (): void => {
    if (!timer) return
    invoke()
  }

  return debounced
}
