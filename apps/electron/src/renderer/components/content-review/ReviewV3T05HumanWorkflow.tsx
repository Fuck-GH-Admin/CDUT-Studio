/**
 * T05: Human business workflow for one existing CaseAggregateV2.
 * Renderer owns drafts and presentation only; all durable actions go through
 * existing reviewAPI commands and the Main-owned actor / revision boundary.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CaseAggregateV2, ReviewCommandResult, SupplementRequest } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'

type StageAction = 'stage-pass' | 'return-for-supplement' | 'return-to-previous-stage' | 'final-reject'
type SupplementOutcome = 'satisfied' | 'insufficient' | 'cancelled'
type AppealResolution = 'maintain-original' | 'amend-original'

export interface T05AppealSubmission {
  requestId: string
  caseId: string
  expectedRevision: number
  againstDecisionId: string
  statement: string
  newEvidenceDocumentVersionIds: string[]
}

export interface T05AppealReview {
  requestId: string
  caseId: string
  expectedRevision: number
  appealId: string
  resolution: AppealResolution
  reason: string
  amendedResult?: 'pass' | 'partial-pass' | 'reject' | 'return' | 'withdraw'
}

/** L owns the trusted Main command registration for these two missing paths. */
export interface T05AppealPorts {
  submitAppeal?: (input: T05AppealSubmission) => Promise<ReviewCommandResult | undefined>
  reviewAppeal?: (input: T05AppealReview) => Promise<ReviewCommandResult | undefined>
  withdrawAppeal?: (input: { requestId: string; caseId: string; expectedRevision: number; appealId: string }) => Promise<ReviewCommandResult | undefined>
}

/**
 * Main-issued read projection: not an authorization token. The actual command
 * must independently resolve actor, stage, and current ReviewRun in Main.
 * Enables teacher final stages without forging a renderer actor.
 */
export interface T05TrustedStageCapability {
  mode: 'local-business'
  actorLabel: string
  actorRole: 'reviewer' | 'teacher'
  eligibleTaskIds: string[]
  hasCurrentRun: boolean
}

export interface T05TrustedStageCommand {
  caseId: string
  templateId: string
  version: number
  expectedRevision: number
  taskId: string
  action: StageAction
  reason: string
  supplementRequiredElements?: string[]
  supplementReason?: string
}

export interface T05TrustedStagePorts {
  stageCapability?: T05TrustedStageCapability
  /**
   * No actor or fabricated runId from the renderer. Main verifies the
   * actual Run and decides which actor can act on the task.
   */
  recordTrustedStageDecision?: (input: T05TrustedStageCommand) => Promise<ReviewCommandResult | undefined>
}

interface Props extends T05AppealPorts, T05TrustedStagePorts {
  aggregate: CaseAggregateV2
  onResult: (result: ReviewCommandResult | undefined) => void
}

const localReviewer = { actorId: 'local-user', actorSource: 'local' as const, role: 'reviewer' as const }
const localSubmitter = { actorId: 'local-student', actorSource: 'local' as const, role: 'student' as const }
const terminalSupplement = new Set(['satisfied', 'cancelled'])
const businessStatus: Record<string, string> = {
  draft: '草稿', submitted: '已提交', reviewing: '审核中',
  'awaiting-supplement': '待补件', 'awaiting-review': '待复审',
  decided: '已有决定', archived: '已归档',
}
const decisionLabel: Record<string, string> = {
  pass: '通过', 'partial-pass': '部分通过', return: '退回', reject: '驳回', withdraw: '撤回',
}
const supplementLabel: Record<string, string> = {
  open: '待回复', responded: '待核对', insufficient: '仍不满足', satisfied: '已满足', cancelled: '已取消',
}
const appealLabel: Record<string, string> = {
  submitted: '已提交', 'in-review': '复审中', upheld: '维持原决定',
  overturned: '已更正', withdrawn: '已撤回',
}

const newRequestId = (prefix: string): string =>
  prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

const parseElements = (raw: string): string[] =>
  [...new Set(raw.split(/[\n,，;；]+/).map((value) => value.trim()).filter(Boolean))]

function SupplementCard({
  request, aggregate, onResult,
}: {
  request: SupplementRequest
  aggregate: CaseAggregateV2
  onResult: Props['onResult']
}): JSX.Element {
  const [reply, setReply] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const caseId = aggregate.caseV2.id
  const activeDocuments = aggregate.caseV2.documents.filter((document) => document.active !== false)
  const alreadyAtRequest = new Set(request.documentVersionIdsAtRequest ?? [])
  const newDocuments = activeDocuments.filter((document) => !alreadyAtRequest.has(document.versionId))
  const canReply = ['open', 'responded', 'insufficient'].includes(request.status)
  const canResolve = request.status === 'responded' || request.status === 'open'

  const execute = async (action: () => Promise<ReviewCommandResult | undefined>): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const result = await action()
      if (result && !result.ok) setError(result.message)
      onResult(result)
      if (result?.ok) {
        setReply('')
        setAttachments([])
        setReason('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const resolve = (outcome: SupplementOutcome): void => {
    void execute(() => window.reviewAPI.resolveSupplementV2({
      caseId,
      command: {
        requestId: newRequestId('t05-resolve'),
        target: { kind: 'case', id: caseId },
        expectedRevision: aggregate.caseV2.revision,
        actor: localReviewer,
        type: 'ResolveSupplement',
        payload: { supplementId: request.id, outcome, reason: reason.trim() },
      },
    }))
  }

  return (
    <section className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>补件请求 · {supplementLabel[request.status] ?? request.status}</strong>
        <code className="text-muted-foreground">{request.id}</code>
      </div>
      <p>原因：{request.reason}</p>
      <p>所需要素：{request.requiredElements.join('、')}</p>
      {request.originFindingKeys.length > 0 && <p className="text-muted-foreground">关联检查：{request.originFindingKeys.join('、')}</p>}
      {request.responses.map((response) => (
        <div key={response.id} className="rounded bg-muted/40 px-2 py-1">
          <p>{new Date(response.at).toLocaleString()} · {response.actor}：{response.note || '附材料'}</p>
          <p className="text-muted-foreground">提交版本：{response.documentVersionIds.length
            ? response.documentVersionIds.map((id) => activeDocuments.find((doc) => doc.versionId === id)?.fileName ?? id).join('、')
            : '无'}</p>
        </div>
      ))}
      {canReply && (
        <div className="space-y-1 border-t pt-2">
          <p className="font-medium">提交方回复（本地模式：说明或补交材料）</p>
          <textarea className="w-full rounded border bg-background p-2" rows={2} placeholder="写明补交内容和材料变更" value={reply} onChange={(event) => setReply(event.target.value)} />
          <div className="flex flex-wrap gap-2">
            {newDocuments.map((document) => (
              <label key={document.versionId} className="flex items-center gap-1">
                <input type="checkbox" checked={attachments.includes(document.versionId)}
                  onChange={(event) => setAttachments((current) => event.target.checked
                    ? [...current, document.versionId] : current.filter((id) => id !== document.versionId))} />
                {document.fileName}
              </label>
            ))}
          </div>
          {!request.documentVersionIdsAtRequest && <p className="text-muted-foreground">历史阶段补件未记录请求时的材料版本清单，以下展示案卷当前有效材料；请核对版本是否真正为新补材料。</p>}
          {newDocuments.length === 0 && <p className="text-muted-foreground">没有新登记的材料版本；可以先说明情况，或先在材料区上传清晰原件。</p>}
          <Button size="sm" variant="outline" disabled={busy || (!reply.trim() && attachments.length === 0)}
            onClick={() => void execute(() => window.reviewAPI.respondSupplementV2({
              caseId,
              command: {
                requestId: newRequestId('t05-reply'),
                target: { kind: 'case', id: caseId },
                expectedRevision: aggregate.caseV2.revision,
                actor: localSubmitter,
                type: 'RespondSupplement',
                payload: { supplementId: request.id, note: reply.trim(), documentVersionIds: attachments },
              },
            }))}>提交回复</Button>
        </div>
      )}
      {canResolve && (
        <div className="space-y-1 border-t pt-2">
          <p className="font-medium">审核员核对（回复不自动等于满足）</p>
          <textarea className="w-full rounded border bg-background p-2" rows={2} placeholder="说明已满足的依据，或指出仍缺什么" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={busy || !reason.trim() || request.status !== 'responded'} onClick={() => resolve('satisfied')}>核对满足</Button>
            <Button size="sm" variant="outline" disabled={busy || !reason.trim() || request.status !== 'responded'} onClick={() => resolve('insufficient')}>仍然不足</Button>
            <Button size="sm" variant="outline" disabled={busy || !reason.trim()} onClick={() => resolve('cancelled')}>有理由取消</Button>
          </div>
          {request.status === 'insufficient' && <p className="text-muted-foreground">本次回复仍不足，请提交方再次补充，之后重新核对。</p>}
        </div>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </section>
  )
}

export function ReviewV3T05HumanWorkflow({
  aggregate, onResult, submitAppeal, reviewAppeal, withdrawAppeal,
  stageCapability, recordTrustedStageDecision,
}: Props): JSX.Element {
  const caseId = aggregate.caseV2.id
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [action, setAction] = useState<StageAction>('stage-pass')
  const [reason, setReason] = useState('')
  const [elements, setElements] = useState('')
  const [supplementReason, setSupplementReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [appealDecisionId, setAppealDecisionId] = useState('')
  const [appealStatement, setAppealStatement] = useState('')
  const [appealDocuments, setAppealDocuments] = useState<string[]>([])
  const [appealReviewId, setAppealReviewId] = useState('')
  const [appealResolution, setAppealResolution] = useState<AppealResolution>('maintain-original')
  const [appealReason, setAppealReason] = useState('')
  const [amendedResult, setAmendedResult] = useState<T05AppealReview['amendedResult']>('pass')

  const openTasks = aggregate.tasks.filter((task) => task.status === 'open')
  // Stage capabilities come from trusted Main, not a role picker in Renderer.
  // Legacy reviewer controls remain available for pre-existing local cases
  // until L replaces them with the stage command backed by a real ReviewRun.
  const eligibleTasks = stageCapability
    ? openTasks.filter((task) => stageCapability.eligibleTaskIds.includes(task.id)
      && task.assigneeRole === stageCapability.actorRole)
    : openTasks.filter((task) => task.assigneeRole === 'reviewer'
      && (!task.assigneeActorId || task.assigneeActorId === 'local-reviewer'))
  const task = eligibleTasks.find((current) => current.id === selectedTaskId) ?? eligibleTasks[0]
  const unresolvedSupplements = aggregate.supplements.filter((request) => !terminalSupplement.has(request.status))
  const effectiveDecisions = useMemo(() => {
    const overwritten = new Set(aggregate.decisions.map((decision) => decision.amendsDecisionId).filter(Boolean))
    return aggregate.decisions.filter((decision) => !overwritten.has(decision.id))
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [aggregate.decisions])
  const latestFinal = effectiveDecisions.find((decision) => decision.finality === 'final')
  const activeDocuments = aggregate.caseV2.documents.filter((document) => document.active !== false)
  const pendingAppeals = aggregate.appeals.filter((appeal) => appeal.status === 'submitted' || appeal.status === 'in-review')
  const chosenAppeal = pendingAppeals.find((appeal) => appeal.id === appealReviewId) ?? pendingAppeals[0]
  // CanonicalPlan alone is not proof of technical-only semantics: the new
  // local-business path may also own an executable Plan. Main must explicitly
  // attest that the case supports local-business stage decisions.
  const technicalPreReview = Boolean(aggregate.d2RuntimePlan
    || (aggregate.canonicalPlan && stageCapability?.mode !== 'local-business'))
  const runRequired = action !== 'return-for-supplement'
  const missingCurrentRun = Boolean(stageCapability && runRequired && !stageCapability.hasCurrentRun)
  const stageDisabled = technicalPreReview || unresolvedSupplements.length > 0 || !task
    || Boolean(stageCapability && !recordTrustedStageDecision) || missingCurrentRun

  useEffect(() => {
    setSelectedTaskId('')
    setReason('')
    setElements('')
    setSupplementReason('')
    setError('')
    setAppealStatement('')
    setAppealDocuments([])
  }, [caseId])

  const execute = async (run: () => Promise<ReviewCommandResult | undefined>): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      const result = await run()
      onResult(result)
      if (result && !result.ok) setError(result.message)
      return Boolean(result?.ok)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const decideStage = async (): Promise<void> => {
    if (!task || !reason.trim()) return
    const required = parseElements(elements)
    if (action === 'return-for-supplement' && (required.length === 0 || !supplementReason.trim())) return
    const succeeded = await execute(() => stageCapability && recordTrustedStageDecision
      ? recordTrustedStageDecision({
          caseId,
          templateId: aggregate.caseV2.templateId,
          version: aggregate.caseV2.templateVersion,
          expectedRevision: aggregate.caseV2.revision,
          taskId: task.id,
          action,
          reason: reason.trim(),
          ...(action === 'return-for-supplement'
            ? { supplementRequiredElements: required, supplementReason: supplementReason.trim() }
            : {}),
        })
      : window.reviewAPI.recordStageDecisionV2({
          caseId,
          templateId: aggregate.caseV2.templateId,
          version: aggregate.caseV2.templateVersion,
          command: {
            requestId: newRequestId('t05-stage'),
            target: { kind: 'case', id: caseId },
            expectedRevision: aggregate.caseV2.revision,
            actor: localReviewer,
            type: 'RecordStageDecision',
            payload: {
              taskId: task.id, action, reason: reason.trim(),
              ...(action === 'return-for-supplement'
                ? { supplementRequiredElements: required, supplementReason: supplementReason.trim() }
                : {}),
            },
          },
        }))
    if (succeeded) { setReason(''); setElements(''); setSupplementReason('') }
  }

  return (
    <section className="space-y-3 rounded-lg border-t pt-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">本地人工业务流程</h3>
          <p className="text-muted-foreground">案卷：{businessStatus[aggregate.caseV2.stage] ?? aggregate.caseV2.stage}
            {' · '}开放任务 {openTasks.length} · 未结补件 {unresolvedSupplements.length}</p>
        </div>
        <span className="rounded bg-muted px-2 py-1">仅代表本地业务操作，不代表校方正式审批</span>
      </div>
      {technicalPreReview && (
        <p className="rounded border px-2 py-1 text-amber-700 dark:text-amber-300">
          当前案卷绑定技术预审 Plan；不能据此直接进行正式阶段决定。需要本地 Agent 接入合法的本地业务阶段及受控 Run。
        </p>
      )}

      <section className="space-y-2 rounded-md bg-muted/30 p-2">
        <h4 className="font-medium">阶段待办与人工决定</h4>
        {openTasks.length > 0 && <p className="text-muted-foreground">当前任务：{openTasks.map((entry) => entry.stageId + '（第 ' + entry.round + ' 轮，' + entry.assigneeRole + '）').join('、')}</p>}
        {stageCapability && <p className="text-muted-foreground">
          当前本地操作者：{stageCapability.actorLabel}（{stageCapability.actorRole === 'teacher' ? '终审' : '初审'}），
          由 Main 判定可处理任务与审核运行。
        </p>}
        {eligibleTasks.length === 0 ? (
          <p className="text-muted-foreground">当前身份没有可操作的阶段任务。终审请切换至 Main 确认的本地终审身份；不能在界面伪造教师或校方授权。</p>
        ) : (
          <>
            <select className="w-full rounded border bg-background px-2 py-1" value={task?.id ?? ''}
              onChange={(event) => setSelectedTaskId(event.target.value)}>
              {eligibleTasks.map((entry) => <option key={entry.id} value={entry.id}>{entry.stageId} · 第 {entry.round} 轮</option>)} 
            </select>
            <select className="w-full rounded border bg-background px-2 py-1" value={action}
              onChange={(event) => setAction(event.target.value as StageAction)}>
              <option value="stage-pass">本阶段通过（非最终阶段则推进下一阶段）</option>
              <option value="return-for-supplement">退回合并补件清单</option>
              <option value="return-to-previous-stage">退回前一阶段</option>
              <option value="final-reject">最终驳回（不自动要求补件）</option>
            </select>
            <textarea className="w-full rounded border bg-background p-2" rows={2} value={reason}
              onChange={(event) => setReason(event.target.value)} placeholder="本次决定的理由（必填）" />
            {action === 'return-for-supplement' && (
              <>
                <textarea className="w-full rounded border bg-background p-2" rows={2} value={elements}
                  onChange={(event) => setElements(event.target.value)} placeholder="需要补齐的要素，每行一项（合并为一份补件清单）" />
                <textarea className="w-full rounded border bg-background p-2" rows={2} value={supplementReason}
                  onChange={(event) => setSupplementReason(event.target.value)} placeholder="向提交方公开的补件说明" />
              </>
            )}
            {unresolvedSupplements.length > 0 && <p className="text-muted-foreground">仍有未结束的补件请求，应先逐项核对；当前不会提前放行阶段决定。</p>}
            {missingCurrentRun && <p className="text-muted-foreground">当前尚无经 Main 核实且未过期的真实 ReviewRun。必须先完成审核，或先选择“退回合并补件清单”处理缺少材料。</p>}
            {stageCapability && !recordTrustedStageDecision && <p className="text-muted-foreground">业务阶段写入尚未接入 Main；不可在 Renderer 用模拟身份代写。</p>}
            <Button size="sm" disabled={busy || stageDisabled || !reason.trim()
              || (action === 'return-for-supplement' && (!parseElements(elements).length || !supplementReason.trim()))}
              onClick={() => void decideStage()}>记录当前阶段决定</Button>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="font-medium">补件与复核（{aggregate.supplements.length} 条）</h4>
        {aggregate.supplements.length === 0 && <p className="text-muted-foreground">目前没有补件请求。</p>}
        {aggregate.supplements.map((request) => (
          <SupplementCard key={request.id} request={request} aggregate={aggregate} onResult={onResult} />
        ))}
      </section>

      <section className="space-y-2 rounded-md bg-muted/30 p-2">
        <h4 className="font-medium">业务决定历史（追加记录，不覆盖旧结论）</h4>
        {aggregate.decisions.length === 0 && <p className="text-muted-foreground">尚无人工业务决定。</p>}
        {[...aggregate.decisions].sort((a, b) => b.at.localeCompare(a.at)).map((decision) => (
          <div key={decision.id} className="rounded border bg-background p-2">
            <p className="font-medium">{decisionLabel[decision.result] ?? decision.result}
              {decision.finality === 'final' ? ' · 最终决定' : ' · 阶段意见'}
              {effectiveDecisions.some((current) => current.id === decision.id) ? '' : ' · 已被更正'}</p>
            <p>{decision.reason}</p>
            <p className="text-muted-foreground">{decision.actor.actorId}（{decision.actor.actorSource}）
              {' · '}{new Date(decision.at).toLocaleString()} · 阶段 {decision.stageId}
              {' · '}依据运行 {decision.basedOnRunId}</p>
          </div>
        ))}
        {latestFinal && <p>当前有效最终结论：{decisionLabel[latestFinal.result] ?? latestFinal.result}</p>}
      </section>

      <section className="space-y-2 rounded-md bg-muted/30 p-2">
        <h4 className="font-medium">异议与申诉</h4>
        {aggregate.appeals.map((appeal) => (
          <div key={appeal.id} className="rounded border bg-background p-2">
            <p className="font-medium">{appealLabel[appeal.status] ?? appeal.status} · 针对决定 {appeal.againstDecisionId}</p>
            <p>{appeal.statement}</p>
            <p className="text-muted-foreground">{appeal.appellant.actorId} · {new Date(appeal.createdAt).toLocaleString()}
              {appeal.reviewDecisionId ? ' · 复核决定 ' + appeal.reviewDecisionId : ''}</p>
          </div>
        ))}
        {aggregate.appeals.length === 0 && <p className="text-muted-foreground">暂无申诉。</p>}
        <p className="font-medium">提交方申请复审</p>
        <select className="w-full rounded border bg-background px-2 py-1" value={appealDecisionId}
          onChange={(event) => setAppealDecisionId(event.target.value)}>
          <option value="">选择要申诉的业务决定</option>
          {effectiveDecisions.filter((decision) => decision.finality === 'final').map((decision) => (
            <option key={decision.id} value={decision.id}>{decisionLabel[decision.result] ?? decision.result} · {decision.id}</option>
          ))}
        </select>
        <textarea rows={2} className="w-full rounded border bg-background p-2" value={appealStatement}
          onChange={(event) => setAppealStatement(event.target.value)} placeholder="说明不同意原决定的理由" />
        <div className="flex flex-wrap gap-2">
          {activeDocuments.map((document) => (
            <label key={document.versionId} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={appealDocuments.includes(document.versionId)}
                onChange={(event) => setAppealDocuments((current) => event.target.checked
                  ? [...current, document.versionId] : current.filter((id) => id !== document.versionId))} />
              {document.fileName}
            </label>
          ))}
        </div>
        <Button size="sm" variant="outline" disabled={busy || !submitAppeal || !appealDecisionId || !appealStatement.trim()}
          onClick={() => void (async () => {
            if (!submitAppeal) return
            const ok = await execute(() => submitAppeal({
              requestId: newRequestId('t05-appeal'), caseId, expectedRevision: aggregate.caseV2.revision, againstDecisionId: appealDecisionId,
              statement: appealStatement.trim(), newEvidenceDocumentVersionIds: appealDocuments,
            }))
            if (ok) { setAppealStatement(''); setAppealDocuments([]) }
          })()}>提交申诉</Button>
        {!submitAppeal && <p className="text-muted-foreground">申诉提交端口尚未接入可信 Main，填写内容只保存在当前表单，不会假称已提交。</p>}
        {chosenAppeal && (
          <div className="space-y-1 border-t pt-2">
            <h4 className="font-medium">独立复核人处理</h4>
            <select className="w-full rounded border bg-background px-2 py-1" value={chosenAppeal.id}
              onChange={(event) => setAppealReviewId(event.target.value)}>
              {aggregate.appeals.filter((appeal) => appeal.status === 'submitted' || appeal.status === 'in-review').map((appeal) => (
                <option key={appeal.id} value={appeal.id}>{appeal.id} · {appeal.statement.slice(0, 40)}</option>
              ))}
            </select>
            <select className="w-full rounded border bg-background px-2 py-1" value={appealResolution}
              onChange={(event) => setAppealResolution(event.target.value as AppealResolution)}>
              <option value="maintain-original">维持原决定</option>
              <option value="amend-original">更正原决定（追加关联决定）</option>
            </select>
            {appealResolution === 'amend-original' && (
              <select className="w-full rounded border bg-background px-2 py-1" value={amendedResult}
                onChange={(event) => setAmendedResult(event.target.value as T05AppealReview['amendedResult'])}>
                <option value="pass">改为通过</option>
                <option value="partial-pass">改为部分通过</option>
                <option value="reject">改为驳回</option>
                <option value="return">改为退回</option>
                <option value="withdraw">改为撤回</option>
              </select>
            )}
            <textarea rows={2} className="w-full rounded border bg-background p-2" value={appealReason}
              onChange={(event) => setAppealReason(event.target.value)} placeholder="复核人的明确结论及依据" />
            <Button size="sm" variant="outline" disabled={busy || !reviewAppeal || !appealReason.trim()}
              onClick={() => void (async () => {
                if (!reviewAppeal) return
                const ok = await execute(() => reviewAppeal({
                  requestId: newRequestId('t05-appeal-review'), caseId, expectedRevision: aggregate.caseV2.revision, appealId: chosenAppeal.id,
                  resolution: appealResolution, reason: appealReason.trim(),
                  ...(appealResolution === 'amend-original' ? { amendedResult } : {}),
                }))
                if (ok) setAppealReason('')
              })()}>保存复核结论</Button>
            {!reviewAppeal && <p className="text-muted-foreground">复核端口需要可信教师/独立复核人身份；本地审核员不会伪装该角色。</p>}
            <Button size="sm" variant="outline" disabled={busy || !withdrawAppeal}
              onClick={() => void execute(() => withdrawAppeal!({
                requestId: newRequestId('t05-appeal-withdraw'), caseId,
                expectedRevision: aggregate.caseV2.revision, appealId: chosenAppeal.id,
              }))}>由原申诉人撤回</Button>
            {!withdrawAppeal && <p className="text-muted-foreground">撤回须由可信 Main 识别原申诉人，不允许复审人代撤回。</p>}
          </div>
        )}
      </section>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </section>
  )
}
