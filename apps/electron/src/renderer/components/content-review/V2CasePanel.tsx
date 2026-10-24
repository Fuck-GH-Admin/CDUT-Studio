/**
 * V2 案卷原子与面板（N1d，05 §5.1 第 3 条：V2 命令可操作入口）
 *
 * Jotai 状态：当前 V2 聚合（按 caseId 缓存）+ 动作回调；组件只做展示与触发命令，
 * 不散落 IPC 调用（仓库四层约定）。U01 部分走通：seed 样例 → 创建案卷 → 改字段 → 重启保留。
 */

import { atom, useAtomValue, useStore, useSetAtom } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import type { Actor, CaseAggregateV2, ReviewCommandResult } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { toast } from 'sonner'

/** 当前 V2 聚合（单案；N3 扩展为按案映射） */
export const reviewV2AggregateAtom = atom<CaseAggregateV2 | null>(null)
export const reviewV2BusyAtom = atom(false)
export const reviewV2NoticeAtom = atom<string | null>(null)

const localActor: Actor = { actorId: 'local-user', actorSource: 'local', role: 'reviewer' }

/** V2 命令面板：演示样例种子 → 创建案卷 → 更新字段（07 §3.2 首批命令的 UI 面） */
export function V2CasePanel(): JSX.Element {
  const store = useStore()
  const aggregate = useAtomValue(reviewV2AggregateAtom)
  const setNotice = useSetAtom(reviewV2NoticeAtom)

interface CaseListEntry { caseId: string; title: string; stage: string; revision: number; templateId: string; templateVersion: number; updatedAt: string }
interface TemplateLite { templateId: string; version: number; name: string; status: string; fields: Array<{ key: string; label: string; kind: string; required: boolean; scope?: string }> }
type TemplateFieldInput = { key: string; label: string; kind: string; required: boolean }

  const [caseList, setCaseList] = useState<CaseListEntry[]>([])
  const [templates, setTemplates] = useState<TemplateLite[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateLite | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [newTitle, setNewTitle] = useState('')


  const refreshList = useCallback(async (): Promise<void> => {
    try {
      setCaseList(await window.reviewAPI.listCasesV2())
    } catch (error) {
      console.error('[V2] 案卷列表加载失败', error)
    }
  }, [])
  useEffect(() => { void refreshList() }, [refreshList])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    store.set(reviewV2BusyAtom, true)
    try {
      await action()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(message)
      toast.error(`操作失败：${message}`)
    } finally {
      store.set(reviewV2BusyAtom, false)
    }
  }, [store, setNotice, toast])

  const applyResult = useCallback((result: ReviewCommandResult | undefined): void => {
    if (!result) return
    if (result.ok) {
      store.set(reviewV2AggregateAtom, result.aggregate)
      toast.success(`已保存：${result.receipt.summary}`)
    } else {
      // 冲突/校验错误如实呈现（不静默重试，07 §3.1）
      setNotice(`${result.code}: ${result.message}`)
      toast.error(`${result.code}：${result.message}`)
    }
  }, [store, setNotice, toast])

  const openCase = useCallback((caseId: string) => run(async () => {
    const loaded = await window.reviewAPI.openAggregateV2(caseId)
    if (!loaded) { toast.error(`案卷不存在: ${caseId}`); return }
    store.set(reviewV2AggregateAtom, loaded)
    toast.success(`已打开案卷：${loaded.caseV2.title}`)
  }), [run, store])

  const loadTemplates = useCallback(async (): Promise<void> => {
    try {
      const all = await window.reviewAPI.listTemplatesV2()
      const published = all.filter((template: { status: string }) => template.status === 'published')
      setTemplates(published as TemplateLite[])
    } catch (error) {
      console.error('[V2] 模板列表加载失败', error)
    }
  }, [])
  useEffect(() => { void loadTemplates() }, [loadTemplates])

  const createFromTemplate = useCallback(() => run(async () => {
    if (!selectedTemplate) { toast.error('请先选择已发布模板'); return }
    if (!newTitle.trim()) { toast.error('请填写案卷标题'); return }
    const caseId = `case-${Date.now().toString(36)}`
    await window.reviewAPI.createCaseV2({
      caseId,
      templateId: selectedTemplate.templateId,
      version: selectedTemplate.version,
      payload: { title: newTitle.trim(), fieldValues, subjects: [] },
      actor: localActor,
    })
    const aggregate = await window.reviewAPI.getAggregateV2(caseId)
    store.set(reviewV2AggregateAtom, aggregate ?? null)
    await refreshList()
    setNewTitle(''); setFieldValues({})
    toast.success(`案卷已创建：${caseId}（${selectedTemplate.name}）`)
  }), [selectedTemplate, newTitle, fieldValues, run, store, refreshList])
  const seedAndCreate = useCallback(() => run(async () => {
    await window.reviewAPI.seedFixtureV2()
    const caseId = `v2-demo-${Date.now().toString(36)}`
    const result = await window.reviewAPI.createCaseV2({
      caseId,
      templateId: 'comprehensive-assessment-v2',
      version: 2,
      payload: {
        title: 'V2 演示案卷（综测样例）',
        fieldValues: { studentName: '张三', studentId: '20260101', academicYear: '2025-2026', applicant: '张三' },
        subjects: [{ id: 's1', title: '省级竞赛一等奖', type: 'item', fieldValues: { category: 'competition', level: 'national-1', declaredScore: 8, eventId: 'E1' } }],
      },
      actor: localActor,
    })
    const aggregate = await window.reviewAPI.getAggregateV2(caseId)
    store.set(reviewV2AggregateAtom, aggregate ?? null)
    await refreshList()
    if (result) toast.success(`V2 案卷已创建：${caseId}`)
  }), [run, store, toast, refreshList])

  const current = aggregate

  const [slotId, setSlotId] = useState('')
  const currentTemplate = templates.find((template) => template.templateId === current?.caseV2.templateId && template.version === current?.caseV2.templateVersion)

  const registerMaterials = useCallback(() => run(async () => {
    if (!current) return
    const versionIds = await window.reviewAPI.pickRegisterMaterialV2({ caseId: current.caseV2.id, role: 'evidence', materialSlotId: slotId || undefined })
    if (versionIds.length === 0) { toast.info('未选择文件'); return }
    const loaded = await window.reviewAPI.openAggregateV2(current.caseV2.id)
    if (loaded) store.set(reviewV2AggregateAtom, loaded)
    await refreshList()
    toast.success(`已登记 ${versionIds.length} 份材料${slotId ? `至槽位 ${slotId}` : ''}`)
  }), [current, run, store, refreshList, slotId])

  const submitCase = useCallback(() => run(async () => {
    if (!current) return
    const result = await window.reviewAPI.submitCaseV2(current.caseV2.id)
    if (result && !result.ok) { toast.error(result.message ?? '提交失败'); return }
    const loaded = await window.reviewAPI.openAggregateV2(current.caseV2.id)
    if (loaded) store.set(reviewV2AggregateAtom, loaded)
    await refreshList()
    toast.success('案卷已提交，进入审核')
  }), [current, run, store, refreshList])
  const runCaseReview = useCallback(() => run(async () => {
    if (!current) return
    const { status } = await window.reviewAPI.runReviewV2(current.caseV2.id)
    toast.success(`审核运行结束：${status}`)
  }), [current, run])
  const resumeCaseReview = useCallback(() => run(async () => {
    if (!current) return
    const { status } = await window.reviewAPI.resumeRunV2(current.caseV2.id)
    toast.success(`已续跑：${status}`)
  }), [current, run])
  const updateTitle = useCallback(() => {
    if (!current) return
    return run(async () => {
      const result = await window.reviewAPI.updateFieldsV2({
        caseId: current.caseV2.id,
        command: {
          requestId: `upd-${Date.now().toString(36)}`,
          target: { kind: 'case', id: current.caseV2.id },
          expectedRevision: current.caseV2.revision,
          actor: localActor,
          type: 'UpdateFields',
          payload: { caseFieldValues: { studentName: `张三-${Math.floor(Math.random() * 90) + 10}` } },
        },
      })
      applyResult(result)
    })
  }, [current, run, applyResult])

  return (
    <div className="mx-3 mb-3 rounded-xl border bg-card p-3 shadow-sm">
      <p className="mb-2 text-sm font-semibold">V2 案卷（通用审核）</p>
      <div className="mb-2 space-y-1.5 rounded-lg border-t pt-2">
        <p className="text-xs font-medium text-muted-foreground">从已发布模板建案（G10 使用入口）</p>
        <select className="w-full rounded-md border bg-background px-2 py-1 text-xs" value={selectedTemplate?.templateId ?? ''} onChange={(event) => { setSelectedTemplate(templates.find((template) => template.templateId === event.target.value) ?? null); setFieldValues({}) }}>
          <option value="">选择已发布模板…</option>
          {templates.map((template) => (
            <option key={template.templateId} value={template.templateId}>{template.name}（{template.templateId}@v{template.version}）</option>
          ))}
        </select>
        {selectedTemplate && (
          <>
            <input className="w-full rounded-md border bg-background px-2 py-1 text-xs" placeholder="案卷标题" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} />
            {selectedTemplate.fields.filter((field) => (field.scope ?? 'case') === 'case').map((field) => (
              <div key={field.key} className="flex items-center gap-1.5">
                <span className="w-24 shrink-0 truncate text-xs">{field.label}{field.required ? ' *' : ''}</span>
                <input
                  className="flex-1 rounded border px-1 py-0.5 text-xs"
                  type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
                  value={fieldValues[field.key] ?? ''}
                  onChange={(event) => setFieldValues({ ...fieldValues, [field.key]: event.target.value })}
                />
              </div>
            ))}
            <Button size="sm" disabled={!newTitle.trim()} onClick={() => void createFromTemplate()}>用该模板创建案卷</Button>
          </>
        )}
      </div>
      {caseList.length > 0 && (
        <div className="mb-2 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">已保存案卷（重启可恢复）</p>
          {caseList.map((entry: CaseListEntry) => (
            <div key={entry.caseId} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <span className="truncate text-xs">{entry.title} · {entry.stage} · r{entry.revision}</span>
              <Button size="sm" variant="outline" onClick={() => void openCase(entry.caseId)}>打开</Button>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {!current && (
          <Button size="sm" disabled={store.get(reviewV2BusyAtom)} onClick={seedAndCreate}>
            载入综测样例并创建 V2 案卷
          </Button>
        )}
        {current && (
          <div className="space-y-1.5 text-xs">
            {currentTemplate && currentTemplate.fields.length >= 0 && (current as unknown as { caseV2: { templateId: string } }).caseV2.templateId && (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-muted-foreground">材料槽：</span>
                <select className="rounded border bg-background px-1 py-0.5" value={slotId} onChange={(event) => setSlotId(event.target.value)}>
                  <option value="">未指定</option>
                  {(currentTemplate as unknown as { materialSlots?: Array<{ id: string; name: string }> }).materialSlots?.map((slot) => (
                    <option key={slot.id} value={slot.id}>{slot.name}</option>
                  ))}
                </select>
              </div>
            )}
            {current.caseV2.documents.length > 0 && (
              <ul className="list-disc pl-4 text-muted-foreground">
                {current.caseV2.documents.map((doc) => (
                  <li key={doc.versionId}>{doc.fileName} · {doc.versionId.slice(-8)}{doc.active === false ? '（旧版）' : ''}{doc.materialSlotId ? ` · ${doc.materialSlotId}` : ''}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={registerMaterials}>登记材料</Button>
              {(current.caseV2.stage === 'draft' || (current.caseV2.stage === 'submitted' && current.tasks.length === 0)) && (
                <Button size="sm" onClick={submitCase}>{current.caseV2.stage === 'draft' ? '提交案卷' : '恢复审核任务'}</Button>
              )}
              <Button size="sm" variant="outline" disabled={!current} onClick={runCaseReview}>运行审核</Button>
              <Button size="sm" variant="outline" disabled={!current} onClick={resumeCaseReview}>继续运行</Button>
            </div>
            <BusinessFlowSection aggregate={current} onResult={applyResult} />
            <p className="font-medium">{current.caseV2.title}</p>
            <p className="text-muted-foreground">
              阶段 {current.caseV2.stage} · revision {current.caseV2.revision} · 回执 {current.receiptLog.length} 条
            </p>
            <div className="flex items-center gap-1.5">
              <input key={current.caseV2.id} id="v2-student-name" className="h-7 w-32 rounded-md border bg-background px-2 text-xs" placeholder="学生姓名" defaultValue={String((current.caseV2.caseFields.studentName as { value?: string })?.value ?? '')} />
              <Button size="sm" variant="outline" onClick={() => {
                const input = document.getElementById('v2-student-name') as HTMLInputElement | null
                if (!input?.value) return
                void run(async () => {
                  const result = await window.reviewAPI.updateFieldsV2({
                    caseId: current.caseV2.id,
                    command: {
                      requestId: `upd-${Date.now().toString(36)}`,
                      target: { kind: 'case', id: current.caseV2.id },
                      expectedRevision: current.caseV2.revision,
                      actor: localActor,
                      type: 'UpdateFields',
                      payload: { caseFieldValues: { studentName: input.value } },
                    },
                  })
                  applyResult(result)
                })
              }}>保存姓名</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 业务流程操作区（N3b，06 §5.2 动作表；U03-U05 入口） */
function BusinessFlowSection({ aggregate, onResult }: { aggregate: CaseAggregateV2; onResult: (result: ReviewCommandResult | undefined) => void }): JSX.Element {
  const [replyText, setReplyText] = useState('')
  const [replyAttachments, setReplyAttachments] = useState<string[]>([])
  const openTasks = aggregate.tasks.filter((task) => task.status === 'open')
  const projection = resolveFinalDecisionProjectionPublic(aggregate.decisions)
  const templateId = aggregate.caseV2.templateId
  const version = aggregate.caseV2.templateVersion
  const caseId = aggregate.caseV2.id

  const act = async (action: string, extra: Record<string, unknown>): Promise<void> => {
    const task = openTasks[0]
    if (!task) {
      return
    }
    const result = await window.reviewAPI.recordStageDecisionV2({
      caseId,
      templateId,
      version,
      command: { requestId: `dec-${Date.now().toString(36)}`, target: { kind: 'case', id: caseId }, expectedRevision: aggregate.caseV2.revision, actor: localActor, type: 'RecordStageDecision', payload: { action, taskId: task.id, reason: String((extra as { reason?: string }).reason ?? '面板操作'), ...extra } },
    })
    onResult(result)
  }

  return (
    <div className="rounded-lg border-t pt-2">
      <p className="mb-1 font-medium">业务流程（{templateId}@{version}）</p>
      <p className="text-muted-foreground">
        开放任务：{openTasks.length > 0 ? openTasks.map((task) => `${task.stageId}(R${task.round})`).join('、') : '无'}
        {' · '}最终决定：{projection.decision ? `${projection.decision.result}${projection.isFinal ? '（终审）' : '（阶段）'}` : '未形成'}
      </p>
      {openTasks.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void act('stage-pass', { reason: `${openTasks[0]?.stageId ?? ''} 通过` })}>阶段通过</Button>
          <Button size="sm" variant="outline" onClick={() => void act('return-for-supplement', { reason: '缺证明', supplementRequiredElements: ['等级', '日期'], supplementReason: '请补交含等级与日期的证明' })}>退回补件</Button>
          <Button size="sm" variant="outline" onClick={() => void act('final-reject', { reason: '不符合规定' })}>最终驳回</Button>
          <Button size="sm" variant="outline" onClick={() => void act('withdraw', { reason: '提交者撤回' })}>撤回</Button>
          {openTasks[0]?.stageId === 'rating' && (
            <Button size="sm" variant="outline" onClick={() => {
              void window.reviewAPI.castRatingV2({
                caseId,
                command: { requestId: `rate-${Date.now().toString(36)}`, target: { kind: 'case', id: caseId }, expectedRevision: aggregate.caseV2.revision, actor: { actorId: 'judge-local', actorSource: 'local', role: 'judge' }, type: 'CastRating', payload: { stageId: 'rating', scores: { overall: 4 } } },
              }).then(onResult)
            }}>评委评分（4/5）</Button>
          )}
        </div>
      )}
      {aggregate.supplements.filter((request) => request.status === 'open' || request.status === 'responded').length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">补件：</span>
          {aggregate.supplements.filter((request) => request.status === 'open' || request.status === 'responded').map((request) => (
            <span key={request.id} className="inline-flex items-center gap-1">
              <code className="rounded bg-muted px-1">{request.id.slice(0, 10)}</code>
              <input
                className="rounded border px-1 py-0.5"
                placeholder="回复说明"
                value={replyText}
                onChange={(event) => setReplyText(event.target.value)}
              />
              {aggregate.caseV2.documents.filter((doc) => doc.active !== false).map((doc) => (
                <label key={doc.versionId} className="flex items-center gap-1 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={replyAttachments.includes(doc.versionId)}
                    onChange={(event) => setReplyAttachments(event.target.checked ? [...replyAttachments, doc.versionId] : replyAttachments.filter((id) => id !== doc.versionId))}
                  />
                  {doc.fileName}
                </label>
              ))}
              <Button size="sm" variant="outline" disabled={!replyText.trim() && replyAttachments.length === 0} onClick={() => {
                void window.reviewAPI.respondSupplementV2({
                  caseId,
                  command: { requestId: `res-${Date.now().toString(36)}`, target: { kind: 'case', id: caseId }, expectedRevision: aggregate.caseV2.revision, actor: { actorId: 'local-student', actorSource: 'local', role: 'student' }, type: 'RespondSupplement', payload: { supplementId: request.id, note: replyText.trim() || '见附件', documentVersionIds: replyAttachments } },
                }).then((result) => { onResult(result); if (result?.ok) { setReplyText(''); setReplyAttachments([]) } })
              }}>回复补件</Button>
              <Button size="sm" variant="outline" onClick={() => {
                void window.reviewAPI.resolveSupplementV2({
                  caseId,
                  command: { requestId: `sup-${Date.now().toString(36)}`, target: { kind: 'case', id: caseId }, expectedRevision: aggregate.caseV2.revision, actor: localActor, type: 'ResolveSupplement', payload: { supplementId: request.id, outcome: 'satisfied', reason: '要素齐全' } },
                }).then(onResult)
              }}>判定满足</Button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 投影纯函数的前端引用（服务层同源逻辑：finality 优先 + 更正排除） */
function resolveFinalDecisionProjectionPublic(decisions: Array<{ id: string; result: string; finality?: string; amendsDecisionId?: string; at: string }>): { decision: { id: string; result: string } | null; isFinal: boolean } {
  const superseded = decisions.filter((decision) => decision.amendsDecisionId).map((decision) => decision.amendsDecisionId!)
  const effective = decisions.filter((decision) => !superseded.includes(decision.id))
  const final = [...effective].filter((decision) => decision.finality === 'final').sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  if (final) return { decision: final, isFinal: true }
  return { decision: [...effective].sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null, isFinal: false }
}
