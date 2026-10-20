/**
 * CSLab 自定义 Python 工具的会话级内存信任层
 *
 * 设计红线：
 * 1. 信任状态只存在于主进程内存，绝不写入会话 meta 或配置文件；应用重启即清空；
 * 2. 信任只能由用户显式激活 bypassPermissions 时授予，子代理不允许自行提权；
 * 3. 子代理通过根会话继承信任，切换实验室时全部失效；
 * 4. 判定逻辑保持为纯函数，便于单元测试覆盖全部模式组合。
 */

import type { ProferPermissionMode } from '@profer/shared'
import { getAgentSessionMeta } from '../agent-session-manager'

const MAX_LINEAGE_DEPTH = 5

/** 已获得 CSLab 工具免审批信任的会话（根会话 ID）及其绑定的实验室。 */
const trustedLabBySession = new Map<string, string>()
/** 当前打开的实验室；授予信任时未显式指定实验室则绑定到它。 */
let activeLabId: string | undefined

/** 记录用户显式开启 bypassPermissions 的会话信任。 */
export function grantCsLabToolTrust(sessionId: string, labId?: string): void {
  if (!sessionId) return
  const boundLabId = labId || activeLabId
  if (!boundLabId) return
  trustedLabBySession.set(sessionId, boundLabId)
}

/** 撤销单个会话的信任（切换到 auto/plan 时调用）。 */
export function revokeCsLabToolTrust(sessionId: string): void {
  trustedLabBySession.delete(sessionId)
}

/**
 * 判断会话是否持有信任。
 * 传入 labId 时要求该会话的信任绑定在同一实验室，避免跨实验室放行。
 */
export function isCsLabToolTrusted(sessionId: string, labId?: string): boolean {
  const boundLabId = trustedLabBySession.get(sessionId)
  if (!boundLabId) return false
  if (!labId) return true
  return boundLabId === labId
}

/** 打开实验室：切换实验室时吊销其他实验室的全部信任。 */
export function onCsLabOpened(labId: string): void {
  for (const [sessionId, boundLabId] of trustedLabBySession) {
    if (boundLabId !== labId) trustedLabBySession.delete(sessionId)
  }
  activeLabId = labId
}

/** 测试辅助：重置全部内存信任。 */
export function resetCsLabToolTrustForTest(): void {
  trustedLabBySession.clear()
  activeLabId = undefined
}

/** 沿 parentSessionId 上溯到根会话，最多 5 层，避免异常数据成环。 */
export function resolveRootSessionId(sessionId: string): string {
  let current = sessionId
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const parent = getAgentSessionMeta(current)?.parentSessionId
    if (!parent || parent === current) break
    current = parent
  }
  return current
}

export type CsLabToolGateDecision = 'allow' | 'prompt' | 'deny'

/**
 * CSLab 执行工具门禁判定（纯函数）。
 *
 * - plan：沿用计划模式拒绝；
 * - bypass + 已信任：直接执行（子代理同样放行）；
 * - 无交互通道：硬阻断；
 * - 其余：单次人工审批。
 */
export function decideCsLabToolGate(input: {
  mode: ProferPermissionMode
  trusted: boolean
  nonInteractive: boolean
}): CsLabToolGateDecision {
  if (input.mode === 'plan') return 'deny'
  if (input.mode === 'bypassPermissions' && input.trusted) return 'allow'
  if (input.nonInteractive) return 'deny'
  return 'prompt'
}
