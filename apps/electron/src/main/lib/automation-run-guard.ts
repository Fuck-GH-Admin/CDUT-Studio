/**
 * 定时任务错误分类与忙碌跳过节流。
 *
 * 保持纯函数，避免测试引入 Electron / Agent runtime。
 */

const BUSY_ERROR_CODE = 'AGENT_RUN_ALREADY_ACTIVE'
const BUSY_SKIP_INTERVAL_MS = 5 * 60_000

export function isAgentBusyError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(BUSY_ERROR_CODE)
}

export interface AutomationFailureClassification {
  status: 'skipped' | 'error'
  reason: string
}

export function classifyAutomationFailure(error: unknown): AutomationFailureClassification {
  if (isAgentBusyError(error)) {
    return { status: 'skipped', reason: '目标会话当前正在与用户交互' }
  }
  const message = error instanceof Error ? error.message : String(error || '未知错误')
  return { status: 'error', reason: message }
}

/** 同一任务的“忙碌跳过”最多每 5 分钟写一条，避免 30s tick 灌满运行历史。 */
export function shouldRecordBusySkip(
  lastRecordedAt: number | undefined,
  now: number,
  windowMs = BUSY_SKIP_INTERVAL_MS,
): boolean {
  if (lastRecordedAt === undefined) return true
  return now - lastRecordedAt >= windowMs
}
