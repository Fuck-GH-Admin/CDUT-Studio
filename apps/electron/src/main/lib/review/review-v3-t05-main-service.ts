/**
 * T05 可信阶段事务（Local-L04 R02 桥接层，CR-T05-04）。
 *
 * 边界：
 * - **只读投影** `readT05StageCapability`：Main 从真实任务指派与有效 Run 推导
 *   能力，渲染层只展示，不构成授权。
 * - **写入** `recordT05StageDecision`：Main 重核身份/角色/模板版本/expectedRevision/
 *   真实任务/当前 Run/规则准备度，再调用 T05 的纯领域函数
 *   `planT05LocalStageAction` + `applyT05LocalStageProposal` 生成追加式状态，
 *   最后由 `submitCommand` 在**唯一 CaseAggregate 事务**中原子写入。
 *
 * 不做的事：
 * - 不自造 `run@rev` 伪 Run ID；
 * - 不接受渲染层声称的 actor.role / runId / isRunCurrent；
 * - 不把「Run 已完成」当成「业务检查全部通过」；
 * - 不冒充学校审批：D2 技术预审与 CanonicalPlan 案卷走原有限制。
 */
import type { Actor, CaseAggregateV2, ReviewRunV2, SourceDocument, TemplateVersion } from '@profer/shared'
import { CommandValidationError, readAggregate, submitCommand } from './case-store-v2'
import { getTemplate } from './template-store'
import { listRunsV2 } from './run-store-v2'
import {
  applyT05LocalStageProposal, planT05LocalStageAction,
  type T05LocalStageAction, type T05StageProposal, type T05VerifiedRun,
} from './review-v3-t05-local-stage-plan'

/** 本地可信身份：本机只有审核员与本地模拟教师两个具名角色。 */
export type T05LocalRole = 'reviewer' | 'teacher'

const LOCAL_ACTORS: Record<T05LocalRole, Actor> = {
  reviewer: { actorId: 'local-reviewer', actorSource: 'local', role: 'reviewer' },
  teacher: { actorId: 'local-teacher', actorSource: 'local', role: 'teacher' },
}

/** Main 侧会话声明：渲染层只能请求角色，不能自带 actor。 */
export interface T05RoleClaim { role?: string }

/**
 * 派生可信 actor。
 *
 * 允许本地模拟 teacher，但**仅供本机业务阶段办理**，不代表学校授权，
 * 也不会让案卷获得任何校方审批效力。
 */
export function deriveT05LocalActor(claim: T05RoleClaim | undefined): Actor {
  if (claim?.role === 'teacher') return LOCAL_ACTORS.teacher
  return LOCAL_ACTORS.reviewer
}

export interface T05StageCapability {
  mode: 'local-business'
  actorLabel: string
  actorRole: T05LocalRole
  eligibleTaskIds: string[]
  hasCurrentRun: boolean
}

/** 业务阶段可办理性：技术预审与 CanonicalPlan 案卷不得走正式业务决定。 */
export function isLocalBusinessCase(aggregate: CaseAggregateV2): boolean {
  if (aggregate.d2RuntimePlan) return false
  if (aggregate.canonicalPlan) return false
  return true
}

/** 当前有效 Run：状态为 completed/partially-completed 且输入未被后续原件改变。 */
export function currentT05Run(aggregate: CaseAggregateV2): ReviewRunV2 | undefined {
  // Run 不在 CaseAggregate 里，走既有 run store（唯一权威）
  const runs = listRunsV2(aggregate.caseV2.id)
  const activeDocuments = aggregate.caseV2.documents.filter((document) => document.active !== false)
  const versionIds = new Set(activeDocuments.map((document) => document.versionId))
  // 从新到旧找第一个「输入仍与当前原件一致」的 Run
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!
    if (run.status !== 'completed' && run.status !== 'partially-completed') continue
    const manifest = run.inputManifest as { documents?: Array<{ versionId?: string }> } | undefined
    const listed = manifest?.documents
    if (Array.isArray(listed) && listed.length > 0) {
      const everyCurrent = listed.every((item) => typeof item.versionId !== 'string' || versionIds.has(item.versionId))
      if (!everyCurrent) continue
    }
    return run
  }
  return undefined
}

/**
 * 业务决定准备度：只有该项为 ready 才允许 stage-pass。
 *
 * 判定依据（全部来自真实 Run，不看模型建议）：
 * - 每条确定性检查都不得停在 awaiting-confirmation / awaiting-supplement；
 * - 不得存在未关闭的补件请求；
 * - 不得存在 execution-failed。
 * 未知值一律按 blocked 处理，绝不把 null 当 0 或当通过。
 */
export function t05DecisionReadiness(
  aggregate: CaseAggregateV2, run: ReviewRunV2 | undefined,
): { readiness: 'ready' | 'blocked'; blockers: string[] } {
  const blockers: string[] = []
  if (!run) return { readiness: 'blocked', blockers: ['没有与当前原件一致的有效审核运行'] }
  const checks = run.checks ?? []
  const pending = checks.filter((check) => check.status === 'awaiting-confirmation' || check.status === 'awaiting-supplement')
  if (pending.length > 0) blockers.push(`${pending.length} 项检查仍待确认或待补件`)
  const failed = checks.filter((check) => check.status === 'execution-failed')
  if (failed.length > 0) blockers.push(`${failed.length} 项检查执行失败`)
  const openSupplements = (aggregate.supplements ?? []).filter((item) =>
    item.status === 'open' || item.status === 'responded' || item.status === 'insufficient')
  if (openSupplements.length > 0) blockers.push(`${openSupplements.length} 个补件请求尚未结束`)
  return { readiness: blockers.length === 0 ? 'ready' : 'blocked', blockers }
}

/** 只读能力投影。 */
export function readT05StageCapability(caseId: string, claim?: T05RoleClaim): T05StageCapability {
  const aggregate = readAggregate(caseId)
  if (!aggregate) throw new CommandValidationError('NOT_FOUND', '案卷不存在')
  if (!isLocalBusinessCase(aggregate)) {
    throw new CommandValidationError('INVALID_TRANSITION', '技术预审案卷不得进入正式业务阶段办理')
  }
  const actor = deriveT05LocalActor(claim)
  const eligible = (aggregate.tasks ?? [])
    .filter((task) => task.status === 'open' && task.assigneeRole === actor.role
      && (!task.assigneeActorId || task.assigneeActorId === actor.actorId))
    .map((task) => task.id)
  return {
    mode: 'local-business',
    actorLabel: actor.role === 'teacher' ? '本地终审教师（模拟，非学校授权）' : '本地审核员',
    actorRole: actor.role as T05LocalRole,
    eligibleTaskIds: eligible,
    hasCurrentRun: Boolean(currentT05Run(aggregate)),
  }
}

export interface T05StageCommandInput {
  caseId: string
  templateId: string
  version: number
  expectedRevision: number
  taskId: string
  action: T05LocalStageAction
  reason: string
  supplementRequiredElements?: string[]
  supplementReason?: string
  requestId: string
  claim?: T05RoleClaim
}

/**
 * 记录一次可信阶段决定。
 *
 * 事务内顺序：读聚合 → 校验模板/任务/角色/Run/准备度 → 纯领域 plan →
 * 追加式 apply → submitCommand 原子落盘（Main 提供唯一 ID 与时间）。
 */
export function recordT05StageDecision(input: T05StageCommandInput):
Promise<{ ok: true; revision: number; proposal: T05StageProposal; decisionId?: string; nextTaskId?: string; supplementId?: string }> {
  const actor = deriveT05LocalActor(input.claim)
  return submitCommand<
    T05StageCommandInput,
    { proposal: T05StageProposal; decisionId?: string; nextTaskId?: string; supplementId?: string }
  >(input.caseId, {
    requestId: input.requestId,
    actor,
    expectedRevision: input.expectedRevision,
    type: 'RecordTrustedStageDecision',
    payload: input,
  }, (aggregate, payload) => {
    if (!isLocalBusinessCase(aggregate)) {
      throw new CommandValidationError('INVALID_TRANSITION', '技术预审案卷不得进入正式业务阶段办理')
    }
    if (aggregate.caseV2.templateId !== payload.templateId || aggregate.caseV2.templateVersion !== payload.version) {
      throw new CommandValidationError('INVALID_TRANSITION', '案卷与模板版本不一致')
    }
    const template: TemplateVersion | undefined = getTemplate(payload.templateId, payload.version)
    if (!template || template.status !== 'published') {
      throw new CommandValidationError('DEPENDENCY_UNRESOLVED', '模板不存在或未发布')
    }
    const run = currentT05Run(aggregate)
    const readiness = t05DecisionReadiness(aggregate, run)
    const verifiedRun: T05VerifiedRun | undefined = run
      ? {
        id: run.id,
        caseId: aggregate.caseV2.id,
        status: run.status === 'completed' ? 'completed' : 'partially-completed',
        current: true,
        decisionReadiness: readiness.readiness,
      }
      : undefined

    // 纯领域判断：全部在 T05 既有函数内，不在此处重写规则
    const proposal = planT05LocalStageAction({
      aggregate,
      template,
      actor,
      businessMode: 'local-business',
      taskId: payload.taskId,
      action: payload.action,
      reason: payload.reason,
      ...(payload.supplementRequiredElements ? { requiredElements: payload.supplementRequiredElements } : {}),
      ...(payload.supplementReason ? { supplementReason: payload.supplementReason } : {}),
      ...(verifiedRun ? { verifiedRun } : {}),
    })

    const at = new Date().toISOString()
    const ids = {
      decisionId: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nextTaskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      supplementId: `sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at,
    }
    const mutation = applyT05LocalStageProposal(aggregate, proposal, actor, ids)

    return {
      summary: `可信阶段决定：${proposal.action}（${proposal.decisionFinality ?? 'stage'}）`,
      mutate: (draft) => {
        draft.caseV2.stage = mutation.caseStage
        draft.tasks = mutation.tasks
        draft.decisions = mutation.decisions
        draft.supplements = mutation.supplements
        return {
          proposal,
          ...(mutation.addedDecision ? { decisionId: mutation.addedDecision.id } : {}),
          ...(mutation.addedTask ? { nextTaskId: mutation.addedTask.id } : {}),
          ...(mutation.addedSupplement ? { supplementId: mutation.addedSupplement.id } : {}),
        }
      },
    }
  }).then((result) => {
    if (!result.ok) throw new CommandValidationError(result.code, result.message)
    const entity = result.entity
    if (!entity) throw new CommandValidationError('INVALID_TRANSITION', '阶段决定已写入但未返回提案，请重新读取案卷')
    return {
      ok: true as const,
      revision: result.aggregate.caseV2.revision,
      proposal: entity.proposal,
      ...(entity.decisionId ? { decisionId: entity.decisionId } : {}),
      ...(entity.nextTaskId ? { nextTaskId: entity.nextTaskId } : {}),
      ...(entity.supplementId ? { supplementId: entity.supplementId } : {}),
    }
  })
}

/** 供 Main 内部消费者：当前案卷的开放任务与角色。 */
export function readT05TaskSummary(caseId: string): Array<{ id: string; stageId: string; role: string; status: string }> {
  const aggregate = readAggregate(caseId)
  if (!aggregate) return []
  return (aggregate.tasks ?? []).map((task) => ({
    id: task.id, stageId: task.stageId, role: task.assigneeRole, status: task.status,
  }))
}

/** 类型导出，避免渲染层重复定义。 */
export type { T05LocalStageAction, T05StageProposal }
export type T05ActiveDocument = SourceDocument
