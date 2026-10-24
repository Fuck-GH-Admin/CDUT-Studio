/**
 * V2 运行编排服务（M3 收尾，设计 03 §6/§11.1 M3）
 *
 * - startRunV2：创建运行（不可变输入 manifest）→ 执行运行图 → 每节点落盘（检查点持久化）
 * - 续跑：runReviewCaseV2({ resumeRunId }) 从磁盘检查点恢复，done+同 hash 跳过（A11/A18）
 * - cancelRunV2：进程内取消注册表；取消后不启动新节点（K18），落盘 cancelled
 * - 事件经 onEvent 回调（M5 IPC 接线时转发渲染层）
 */

import { createHash } from 'node:crypto'
import type { CheckpointRecord, ReviewCaseV2, ReviewRunV2, TemplateVersion } from '@profer/shared'
import { executeRunGraph, planRunGraph, type NodeArtifact, type NodeExecutor, type NodeKind, type RunEvent } from './review-run-graph'
import { getRunV2, readArtifact, saveArtifact, saveRunV2 } from './run-store-v2'

/** 进程内取消注册表（单机桌面应用：跨进程取消无需持久化标记） */
const cancelledRunIds = new Set<string>()

export function cancelRunV2(runId: string): void {
  cancelledRunIds.add(runId)
}

export function isRunCancelled(runId: string): boolean {
  return cancelledRunIds.has(runId)
}

/** 输入 manifest 哈希：模板版本 + 文档版本 + 主体/观察内容（不可变输入指纹，03 §7） */
export function computeRunInputHash(
  caseV2: ReviewCaseV2,
  observationSnapshot: Array<Record<string, unknown>>,
  evidenceSnapshot: Array<Record<string, unknown>>,
): string {
  // N2b（07 §3.4）：输入包含 caseFields、解析修订与真实观察/绑定快照（修正误判 3：旧 hash 缺 caseFields）
  const material = JSON.stringify({
    templateId: caseV2.templateId,
    templateVersion: caseV2.templateVersion,
    caseFields: caseV2.caseFields,
    documents: caseV2.documents.map((document) => ({ id: document.versionId, hash: document.contentHash, parseRevision: document.parseRevision })),
    subjects: caseV2.subjects.map((subject) => ({ id: subject.id, fields: subject.fields, status: subject.status })),
    observations: observationSnapshot,
    evidenceLinks: evidenceSnapshot,
  })
  return createHash('sha256').update(material, 'utf-8').digest('hex')
}

export interface StartRunOptions {
  runId?: string
  /** 续跑：沿用既有运行文件的检查点 */
  resumeRunId?: string
  onEvent?: (event: RunEvent) => void
  cancelled?: () => boolean
}

/**
 * 执行 V2 运行：持久化-优先（每个节点完成后整份落盘，崩溃可续）。
 * executors 由调用方装配（业务工具集 × 节点类型），本服务只管编排与持久化。
 */
export async function runReviewCaseV2(
  caseV2: ReviewCaseV2,
  template: TemplateVersion,
  executors: Record<NodeKind, NodeExecutor>,
  options: StartRunOptions = {},
): Promise<ReviewRunV2> {
  // 续跑必须产生新运行文件：只给 resumeRunId 时不能拿它当新 runId（saveRunV2 会覆盖旧运行）
  const runId = options.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const inputHash = computeRunInputHash(caseV2, [], [])
  const nodes = planRunGraph(template)
  for (const node of nodes) {
    node.inputHash = createHash('sha256').update(JSON.stringify({ inputHash, nodeId: node.id, dependencies: node.dependsOn })).digest('hex')
  }
  let checkpoints: CheckpointRecord[] = nodes.map((node) => ({ nodeId: node.id, inputHash: node.inputHash!, status: 'pending' as const, attempts: 0 }))

  // 续跑：恢复检查点（done+同 hash 跳过）
  if (options.resumeRunId) {
    const previous = getRunV2(caseV2.id, options.resumeRunId)
    if (!previous) throw new Error(`续跑目标运行不存在: ${options.resumeRunId}`)
    // 输入指纹一致性：manifest 变了就不允许在旧运行上续（结果混版，K06）
    if (previous.inputManifest.hash !== inputHash && previous.checkpoints.some((checkpoint) => checkpoint.status === 'done')) {
      throw new Error('案卷输入在运行后已变化，不能在旧运行上续跑（请发起新运行）')
    }
    const previousById = new Map(previous.checkpoints.map((checkpoint) => [checkpoint.nodeId, checkpoint]))
    const reusableIds = new Set<string>()
    // 校验真实产物和依赖；任一产物失效后，其下游必须重新执行。
    for (const node of nodes) {
      const checkpoint = previousById.get(node.id)
      if (!checkpoint) continue
      node.attempts = checkpoint.attempts
      const artifact = checkpoint.outputRef ? readArtifact<NodeArtifact>(caseV2.id, previous.id, node.id) : undefined
      const validArtifact = !checkpoint.outputRef || !!(artifact && artifact.schemaRevision === 2 && artifact.runId === previous.id && artifact.nodeId === node.id && artifact.dependencyHash === node.inputHash)
      const reusable = checkpoint.status === 'done' && checkpoint.inputHash === node.inputHash && validArtifact && node.dependsOn.every(id => reusableIds.has(id))
      if (reusable) {
        node.status = 'done'
        reusableIds.add(node.id)
        if (artifact && runId !== previous.id) saveArtifact(caseV2.id, runId, node.id, { ...artifact, runId })
      }
      checkpoints = checkpoints.map(current => current.nodeId === node.id
        ? (reusable ? { ...checkpoint } : { ...current, attempts: checkpoint.attempts })
        : current)
    }
  }

  const run: ReviewRunV2 = {
    id: runId,
    caseId: caseV2.id,
    templateId: template.templateId,
    templateVersion: template.version,
    inputManifest: {
      hash: inputHash,
      templateVersion: template.version,
      policyVersions: (template.policyRefs?.map((ref) => ({ policyVersionId: ref.policyId, version: ref.version })) ?? template.policyVersionIds.map((policyVersionId) => ({ policyVersionId, version: 1 }))),
      documentVersions: caseV2.documents.map((document) => ({ documentId: document.documentId, versionId: document.versionId, contentHash: document.contentHash })),
      observationIds: [],
      evidenceLinkIds: [],
    },
    status: 'running',
    checkpoints,
    checks: [],
    opinions: [],
    coverage: { documents: [], plannedChecks: 0, completedChecks: 0, effectiveVerdicts: 0, pendingChecks: 0 },
    diagnostics: [],
    startedAt: new Date().toISOString(),
  }
  saveRunV2(run)

  const outcome = await executeRunGraph(
    nodes,
    executors,
    {
      cancelled: options.cancelled ?? (() => isRunCancelled(runId)),
      now: () => new Date().toISOString(),
      runId,
      onEvent: options.onEvent, // N2b：即时事件（不再等整图结束——修正误判 1）
      writeArtifact: (nodeId, artifact) => {
        // 每节点产物即时落盘（崩溃可续，R03）
        saveArtifact(caseV2.id, runId, nodeId, artifact)
      },
      writeCheckpoint: (checkpoint) => {
        // 先保存产物，再保存完成/等待/失败检查点，最后广播事件。
        run.checkpoints = run.checkpoints.map(current => current.nodeId === checkpoint.nodeId ? checkpoint : current)
        saveRunV2(run)
      },
    },
  )

  run.status = outcome.status
  // checks/opinions/coverage 由节点产物装配（07 §4.2：不从工具内存数组推测——修正误判 1）
  const artifacts = run.checkpoints
    .filter((checkpoint) => checkpoint.outputRef)
    .map((checkpoint) => readArtifact<Record<string, unknown>>(caseV2.id, runId, checkpoint.nodeId))
    .filter((artifact): artifact is Record<string, unknown> => !!artifact)
  run.checks = artifacts.flatMap((artifact) => (artifact.checks as Array<never>) ?? [])
  run.opinions = artifacts.flatMap((artifact) => (artifact.opinions as Array<never>) ?? [])
  // G12：coverage 由真实产物账本装配（材料账本 + 检查账本含组展开；分母 = 政策 compiledRules）
  {
    const { combineCoverage } = await import('./coverage-ledger')
    const { getPolicy } = await import('./policy-store')
    const { getTemplate } = await import('./template-store')
    const template = getTemplate(caseV2.templateId, caseV2.templateVersion)
    const policyRules: never[] = []
    for (const ref of template?.policyRefs ?? []) {
      const policy = getPolicy(ref.policyId, ref.version)
      for (const rule of policy?.compiledRules ?? []) policyRules.push(rule as never)
    }
    const groupValues: Record<string, string[]> = {}
    for (const artifact of artifacts) {
      const groups = artifact.groups as Record<string, string[]> | undefined
      if (groups) for (const [ruleId, values] of Object.entries(groups)) groupValues[ruleId] = values
    }
    const summary = combineCoverage(caseV2.documents, policyRules, caseV2.subjects.map((subject) => subject.id), run.checks as never, groupValues)
    run.coverage = {
      documents: summary.documents,
      plannedChecks: summary.plannedChecks,
      completedChecks: summary.completedChecks,
      effectiveVerdicts: summary.effectiveVerdicts,
      pendingChecks: summary.pendingChecks,
    }
    if (!summary.allClearVerdictAllowed) run.diagnostics = [...run.diagnostics, ...summary.blockers.map((blocker) => `coverage: ${blocker}`)]
  }
  run.completedAt = outcome.status === 'completed' ? new Date().toISOString() : undefined
  saveRunV2(run)
  cancelledRunIds.delete(runId)
  return run
}
