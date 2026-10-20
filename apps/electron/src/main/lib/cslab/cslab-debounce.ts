/**
 * CSLab 轻量防抖器（零依赖）
 *
 * 与 lodash.debounce 的差异：
 * - 额外支持 maxWait，避免持续 WAL 追加导致同步永远不触发；
 * - 计时器统一 unref，不阻塞 Electron 进程退出。
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
  let timer: NodeJS.Timeout | null = null
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
    timer.unref?.()
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
