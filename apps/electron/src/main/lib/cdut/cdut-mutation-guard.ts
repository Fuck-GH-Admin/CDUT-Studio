/**
 * CDUT 专区写操作二次确认守卫
 *
 * 职责：
 *   - 承接 Pi 工具层对高危写操作（选退课、报名、缓考、改密等）的拦截诉求；
 *   - 通过主进程向渲染端派发 `cdut-zone:on-mutation-request` 确认请求，并挂起等待用户抉择；
 *   - 渲染端回传 `cdut-zone:confirm-mutation` 后精准唤醒对应 Promise。
 *
 * 安全红线：未取得用户显式确认前，绝不向教务系统提交任何写操作；超时一律按「拒绝」处理。
 */

import { BrowserWindow } from 'electron'
import type { CdutMutationConfirmRequest, CdutMutationConfirmResult } from '@profer/shared'
import { CDUT_ZONE_IPC_CHANNELS } from '@profer/shared'

interface PendingConfirm {
  resolve: (confirmed: boolean) => void
  timer: NodeJS.Timeout
}

/** 进行中的确认请求（requestId -> 挂起 Promise 与超时定时器） */
const pendingConfirms = new Map<string, PendingConfirm>()

/** 用户未在 30 秒内抉择则自适应超时，视为拒绝 */
const CONFIRM_TIMEOUT_MS = 30_000

/**
 * 派发一次写操作确认请求，并等待用户在界面上确认或拒绝。
 * @returns 用户点击「确认执行」返回 true，取消 / 超时 / 无可用窗口返回 false。
 */
export function requestCdutMutationConfirm(request: CdutMutationConfirmRequest): Promise<boolean> {
  const targets = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  if (targets.length === 0) {
    console.warn('[CdutMutationGuard] 无可用渲染窗口，写操作确认直接拒绝')
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(request.requestId)
      console.warn('[CdutMutationGuard] 写操作确认超时，按拒绝处理:', request.requestId)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)
    timer.unref?.()

    pendingConfirms.set(request.requestId, { resolve, timer })

    for (const win of targets) {
      win.webContents.send(CDUT_ZONE_IPC_CHANNELS.ON_MUTATION_REQUEST, request)
    }
  })
}

/**
 * 渲染端回传确认结果，唤醒对应挂起请求。
 * @returns 命中并处理了挂起请求则返回 true。
 */
export function resolveCdutMutationConfirm(result: CdutMutationConfirmResult): boolean {
  const entry = pendingConfirms.get(result.requestId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pendingConfirms.delete(result.requestId)
  entry.resolve(!!result.confirmed)
  return true
}
