/**
 * 审核操作可信指派（08 设计 §2.2：显式指派是 Agent 写权限的唯一来源）
 *
 * - 指派由 UI 按钮（或 IPC）创建：绑定 sessionId/turnId/案卷或模板/动作范围/工作角色
 * - Agent 工具每次调用携带 assignmentId；服务端校验存在、未撤销、范围匹配、案卷绑定
 * - 建案型指派在建案成功后绑定 caseId（一次指派只服务一个案卷）
 * - 撤销后新写入被拒；已完成动作保留时间线
 * - 轮次校验：仅用户发起轮（triggeredBy='user'）可创建指派；automation/goal/delegation 不获写权限
 * - 落盘：review-agent-assignments.json（轻量 JSON，无数据库）
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'

/** 指派允许的动作范围（C1：操作类全量；C2 增加决定类动作受代批开关二次约束） */
export type ReviewAssignmentAction =
  | 'list' | 'create-case' | 'register-material' | 'submit-case' | 'start-run' | 'get-run-status' | 'cancel-run' | 'export-report'
  | 'submit-result' | 'decide-stage' | 'resolve-supplement' | 'respond-supplement'

/** 可信指派（落盘形态） */
export interface ReviewAgentAssignment {
  id: string
  /** 发起会话完整 ID（显示短码由 UI 派生；校验用完整值） */
  sessionId: string
  /** 用户发起指派的轮次消息 ID（归属到轮，审计可溯） */
  turnId: string
  /** 指派的目标案卷（建案型指派初始缺省，建案成功后绑定） */
  caseId?: string
  /** 建案型指派允许的模板（模板+版本锁定；防止拿指派开任意模板的案） */
  templateId?: string
  templateVersion?: number
  /** 允许的动作范围（工具调用动作必须在此范围内） */
  actions: ReviewAssignmentAction[]
  /** 当前 Pi 会话直接审核的运行；由宿主创建与绑定，模型不能指定。 */
  activeRunId?: string
  /** 被授权的工作角色（工具 actor.role 由此决定，不由模型自由声明） */
  workRole: 'reviewer' | 'student'
  /** 指派发起者（人工授权人，与代操作 AI 分开记录） */
  grantedBy: { actorId: string; sessionId: string }
  createdAt: string
  revokedAt?: string
}

const ASSIGNMENTS_FILE = 'review-agent-assignments.json'

function assignmentsPath(): string {
  return join(getConfigDir(), ASSIGNMENTS_FILE)
}

function readAll(): ReviewAgentAssignment[] {
  const path = assignmentsPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { assignments?: ReviewAgentAssignment[] }
    return Array.isArray(parsed.assignments) ? parsed.assignments : []
  } catch {
    return []
  }
}

function writeAll(assignments: ReviewAgentAssignment[]): void {
  writeFileSync(assignmentsPath(), `${JSON.stringify({ assignments }, null, 2)}\n`, 'utf-8')
}

export interface CreateAssignmentInput {
  sessionId: string
  turnId: string
  /** 案卷型指派：直接绑定已有案卷 */
  caseId?: string
  /** 建案型指派：锁定模板与版本（建案后绑定 caseId） */
  templateId?: string
  templateVersion?: number
  actions: ReviewAssignmentAction[]
  workRole?: 'reviewer' | 'student'
  grantedByActorId?: string
}

/** 创建指派（UI「交给 Agent」按钮走这里；sessionId/turnId 必须来自用户真实轮次） */
export function createAssignment(input: CreateAssignmentInput): ReviewAgentAssignment {
  if (!input.sessionId || !input.turnId) throw new Error('指派必须绑定会话与用户轮次（显式指派）')
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new Error('指派动作范围不能为空')
  if (!input.caseId && !input.templateId) throw new Error('指派必须指定案卷或模板（二选一）')
  if (input.workRole && input.workRole !== 'reviewer' && input.workRole !== 'student') throw new Error('工作角色仅限 reviewer/student（teacher/judge 等决定角色不开放 Agent 代操作）')
  const assignment: ReviewAgentAssignment = {
    id: `asg-${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.templateId ? { templateId: input.templateId, templateVersion: input.templateVersion ?? 1 } : {}),
    actions: [...new Set(input.actions)],
    workRole: input.workRole ?? 'reviewer',
    grantedBy: { actorId: input.grantedByActorId ?? 'local-user', sessionId: input.sessionId },
    createdAt: new Date().toISOString(),
  }
  const all = readAll()
  all.push(assignment)
  writeAll(all)
  return assignment
}

/** 撤销指派：撤销后新写入被拒（已完成动作保留时间线） */
export function revokeAssignment(assignmentId: string): boolean {
  const all = readAll()
  const target = all.find((item) => item.id === assignmentId)
  if (!target || target.revokedAt) return false
  target.revokedAt = new Date().toISOString()
  writeAll(all)
  return true
}

/** 建案后绑定 caseId（建案型指派转成案卷型；一次指派不能开多案） */
export function bindCaseToAssignment(assignmentId: string, caseId: string): ReviewAgentAssignment {
  const all = readAll()
  const target = all.find((item) => item.id === assignmentId)
  if (!target) throw new Error(`指派不存在: ${assignmentId}`)
  if (target.revokedAt) throw new Error('指派已撤销，不能绑定案卷')
  if (target.caseId && target.caseId !== caseId) throw new Error('该指派已绑定其他案卷，不能复用建案')
  target.caseId = caseId
  writeAll(all)
  return target
}

/** 将宿主创建的直接 Pi 审核运行绑定到指派；每个指派只能绑定一个运行。 */
export function bindRunToAssignment(assignmentId: string, runId: string): ReviewAgentAssignment {
  if (!runId) throw new Error('审核运行 ID 不能为空')
  const all = readAll()
  const target = all.find((item) => item.id === assignmentId)
  if (!target) throw new Error(`指派不存在: ${assignmentId}`)
  if (target.revokedAt) throw new Error('指派已撤销，不能绑定审核运行')
  if (target.activeRunId && target.activeRunId !== runId) throw new Error('该指派已绑定其他审核运行')
  target.activeRunId = runId
  writeAll(all)
  return target
}

/** 指派校验结果 */
export interface AssignmentCheck {
  ok: boolean
  code?: 'ASSIGNMENT_NOT_FOUND' | 'ASSIGNMENT_REVOKED' | 'ACTION_NOT_ALLOWED' | 'CASE_MISMATCH' | 'TURN_NOT_USER'
  message?: string
  assignment?: ReviewAgentAssignment
}

/**
 * 工具调用前校验：指派存在、未撤销、动作在范围内、案卷匹配。
 * sessionId 必须与指派一致（其他会话不能冒用指派 ID）。
 * turnTriggeredBy 必须是 'user'（automation/goal/delegation 轮次不获写权限）。
 */
export function checkAssignment(input: {
  assignmentId: string
  sessionId: string
  action: ReviewAssignmentAction
  turnTriggeredBy?: 'user' | 'automation' | 'delegation' | 'goal'
}): AssignmentCheck {
  const assignment = readAll().find((item) => item.id === input.assignmentId)
  if (!assignment) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', message: `指派不存在: ${input.assignmentId}` }
  if (assignment.sessionId !== input.sessionId) return { ok: false, code: 'ASSIGNMENT_NOT_FOUND', message: '指派不属于当前会话' }
  if (assignment.revokedAt) return { ok: false, code: 'ASSIGNMENT_REVOKED', message: `指派已被撤销（${assignment.revokedAt}）；已完成动作保留在时间线` }
  if (input.turnTriggeredBy && input.turnTriggeredBy !== 'user') {
    return { ok: false, code: 'TURN_NOT_USER', message: `仅用户发起的轮次可执行审核写操作（当前轮次来源: ${input.turnTriggeredBy}）` }
  }
  if (!assignment.actions.includes(input.action)) {
    return { ok: false, code: 'ACTION_NOT_ALLOWED', message: `指派未授权动作: ${input.action}（授权范围: ${assignment.actions.join('、')}）` }
  }
  return { ok: true, assignment }
}

/** 列出会话的有效指派（UI 展示 + 工具发现） */
export function listAssignments(sessionId?: string): ReviewAgentAssignment[] {
  const all = readAll()
  const filtered = sessionId ? all.filter((item) => item.sessionId === sessionId) : all
  return filtered.map((item) => ({ ...item }))
}

/** 读取会话最近一条有效的直接审核指派。 */
export function findActivePiReviewAssignment(sessionId: string): ReviewAgentAssignment | undefined {
  return readAll()
    .filter((item) => item.sessionId === sessionId
      && !item.revokedAt
      && item.caseId
      && item.activeRunId
      && item.actions.includes('submit-result'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

/** 由指派构造工具 actor（role 来自指派工作角色，不由模型声明；actorId 保留完整会话身份） */
export function actorOfAssignment(assignment: ReviewAgentAssignment): { actorId: string; actorSource: 'agent'; role: 'reviewer' | 'student' } {
  return { actorId: `agent-${assignment.sessionId}`, actorSource: 'agent', role: assignment.workRole }
}
