/**
 * CDUT 专区统一门禁拦截器（Gatekeeper）
 *
 * 职责：
 *   - 拦截 CDUT 工具集（8 大教务业务域 + 第 9 个反代工具）的调用入口；
 *   - 特区账户未处于 `active` 时，向渲染端派发 `cdut-zone:gatekeeper-blocked` 事件，
 *     拉起用户专属门禁引导弹窗（校徽 Logo + 前往登录 / 稍后再说 + 雫窝中央实验室版权声明）；
 *   - 挂起等待用户抉择，渲染端回传 `cdut-zone:gatekeeper-respond` 后精准唤醒对应 Promise；
 *   - 向大模型返回结构化的阻断状态响应，明确区分「已前往登录」与「用户拒绝登录」。
 *
 * 安全红线：未取得特区账户有效登录态前，绝不向青果教务系统提交任何请求；超时一律按拒绝处理。
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type {
  CdutGatekeeperDecision,
  CdutGatekeeperNoticeEvent,
  CdutDomainToolResult,
} from '@profer/shared'
import { CDUT_ZONE_IPC_CHANNELS } from '@profer/shared'
import { cdutAuthManager } from './cdut-auth-manager'

/** 门禁判定结果：allowed 为 true 时放行，否则携带面向大模型的阻断结果 */
export interface CdutGatekeeperResult {
  allowed: boolean
  rejectionResult?: CdutDomainToolResult
}

interface PendingDecision {
  resolve: (action: CdutGatekeeperDecision['action']) => void
  timer: NodeJS.Timeout
}

/** 进行中的门禁抉择（requestId -> 挂起 Promise 与超时定时器） */
const pendingDecisions = new Map<string, PendingDecision>()

/** 用户未在 30 秒内抉择则自适应超时，视为拒绝登录 */
const GATEKEEPER_TIMEOUT_MS = 30_000

/** 构造面向大模型的阻断返回：双模（Markdown + 结构化 JSON），并区分拒绝原因 */
function buildRejection(reason: 'navigated_to_login' | 'user_declined_login' | 'no_window'): CdutDomainToolResult {
  if (reason === 'navigated_to_login') {
    return {
      success: false,
      mutated: false,
      markdown:
        '⚠️ 特区账户尚未登录，已在界面弹出 CDUT 专区门禁引导。用户选择了【前往登录】，正前往 CDUT 专区完成登录。\n请在用户完成登录后再重新调用本工具，本次调用未对教务系统做任何请求。',
      json: { status: 'blocked', reason: 'navigated_to_login' },
    }
  }
  if (reason === 'no_window') {
    return {
      success: false,
      mutated: false,
      markdown:
        '⚠️ 当前无可用界面窗口，无法拉起 CDUT 专区门禁引导。请提示用户打开 CDUT 专区并登录特区账户后重试。',
      json: { status: 'blocked', reason: 'no_window' },
    }
  }
  return {
    success: false,
    mutated: false,
    markdown:
      '⚠️ 用户在门禁弹窗中选择了【稍后再说】，明确暂不登录特区账户。\n请尊重用户意图，停止调用 CDUT 教务工具，可改用公开资料解答或先完成无需内网数据的部分，不要再重复发起同类登录请求。',
    json: { status: 'blocked', reason: 'user_declined_login' },
  }
}

/**
 * 统一门禁检查：CDUT 工具调用前的必经切面。
 *
 * @param toolName 触发调用的工具名（用于审计与展示）
 * @param toolLabel 工具中文名（弹窗展示）
 * @returns 放行时 `{ allowed: true }`；拦截时 `{ allowed: false, rejectionResult }`
 */
export async function checkCdutGatekeeper(
  toolName: string,
  toolLabel: string,
): Promise<CdutGatekeeperResult> {
  const profile = cdutAuthManager.getProfile()
  if (profile.status === 'active') {
    return { allowed: true }
  }

  const targets = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  if (targets.length === 0) {
    console.warn(`[CdutGatekeeper] 无可用渲染窗口，直接拦截 CDUT 工具调用: ${toolName}`)
    return { allowed: false, rejectionResult: buildRejection('no_window') }
  }

  const requestId = randomUUID()
  const event: CdutGatekeeperNoticeEvent = { requestId, toolName, toolLabel }

  const action = await new Promise<CdutGatekeeperDecision['action']>((resolve) => {
    const timer = setTimeout(() => {
      pendingDecisions.delete(requestId)
      console.warn('[CdutGatekeeper] 门禁抉择超时，按拒绝登录处理:', requestId)
      resolve('decline')
    }, GATEKEEPER_TIMEOUT_MS)
    timer.unref?.()

    pendingDecisions.set(requestId, { resolve, timer })

    for (const win of targets) {
      win.webContents.send(CDUT_ZONE_IPC_CHANNELS.GATEKEEPER_BLOCKED, event)
    }
  })

  console.log(`[CdutGatekeeper] CDUT 工具 ${toolName} 被门禁拦截，用户抉择: ${action}`)
  return {
    allowed: false,
    rejectionResult: buildRejection(action === 'navigate_login' ? 'navigated_to_login' : 'user_declined_login'),
  }
}

/**
 * 渲染端回传门禁决策，唤醒对应挂起请求。
 *
 * @returns 命中并处理了挂起请求则返回 true。
 */
export function resolveCdutGatekeeper(decision: CdutGatekeeperDecision): boolean {
  const entry = pendingDecisions.get(decision.requestId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pendingDecisions.delete(decision.requestId)
  entry.resolve(decision.action === 'navigate_login' ? 'navigate_login' : 'decline')
  return true
}
