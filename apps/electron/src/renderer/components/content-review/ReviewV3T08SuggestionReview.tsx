/**
 * T08 reviewed AI suggestion: a real, explicitly confirmed field edit using
 * the already trusted Main UpdateFieldsV2 transaction.
 * No model-generated key, Actor or approval is ever executed.
 */
import * as React from 'react'
import type { CaseAggregateV2, ReviewRunV2, TemplateVersion } from '@profer/shared'
import { useReviewWorkspaceActions } from './use-review-workspace-actions'
import { resolveT08Source } from './review-v3-t08-case-report'
import {
  getT08FieldTargets, makeT08FieldUpdate, parseT08FieldDraft, showT08FieldValue,
} from './review-v3-t08-suggestion'

interface Props {
  aggregate: CaseAggregateV2
  run: ReviewRunV2
  template: TemplateVersion | null
  opinion: ReviewRunV2['opinions'][number]
  stale: boolean
  onClose(): void
}

export function ReviewV3T08SuggestionReview({ aggregate, run, template, opinion, stale, onClose }: Props): React.ReactElement {
  const actions = useReviewWorkspaceActions()
  const targets = React.useMemo(() => getT08FieldTargets(aggregate, template), [aggregate, template])
  const [targetId, setTargetId] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [confirmed, setConfirmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const target = targets.find((item) => item.id === targetId) ?? null
  const sources = opinion.sourceRefs.map((ref) => resolveT08Source(ref, aggregate))
  const located = sources.filter((ref) => ref.state === 'located').length

  React.useEffect(() => { setConfirmed(false) }, [targetId, draft])

  const apply = async (): Promise<void> => {
    if (!target || !confirmed || stale || busy) return
    setBusy(true); setNotice('')
    try {
      const value = parseT08FieldDraft(target.field, draft)
      const fresh = await window.reviewAPI.getAggregateV2(aggregate.caseV2.id)
      if (!fresh || fresh.caseV2.revision !== aggregate.caseV2.revision)
        throw new Error('案卷在审阅期间已经修改；请刷新案卷后重新核对修改前后的值')
      if (await window.reviewAPI.getWorkspaceRunValidityV2({ caseId: aggregate.caseV2.id, runId: run.id }))
        throw new Error('关联的审核 Run 已过期，不允许以旧建议修改当前案卷')
      const update = makeT08FieldUpdate(target, value)
      const response = await window.reviewAPI.updateFieldsV2({
        caseId: aggregate.caseV2.id,
        command: {
          requestId: 't08-reviewed-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9),
          target: { kind: 'case', id: aggregate.caseV2.id },
          type: 'UpdateFields',
          // Main must rebind the local actor. This is NOT school identity.
          actor: { actorId: 'local-user', actorSource: 'local', role: 'reviewer' },
          expectedRevision: fresh.caseV2.revision,
          payload: update,
        },
      })
      if (!response?.ok) throw new Error('业务字段保存失败')
      await actions.refresh()
      setNotice('修改已通过 Main 案卷命令保存。旧 Run 不会被改写，需重新审核受影响的规则。')
      setConfirmed(false)
      setDraft('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return <section aria-label="审核助手建议应用" className="mt-2 space-y-2 rounded border border-primary/40 bg-muted/20 p-3 text-xs">
    <header className="flex items-start justify-between">
      <strong>人工审阅 AI 建议 · {opinion.title}</strong>
      <button type="button" className="rounded border px-2 py-1" onClick={onClose}>关闭</button>
    </header>
    <p className="whitespace-pre-wrap">{opinion.suggestionText}</p>
    <p className="text-muted-foreground">关联 Run：{run.id}；当前案卷 revision {aggregate.caseV2.revision}。准确定位来源 {located}/{sources.length}，无法核对的来源不得视作证据。</p>
    {sources.map((source, index) => <p key={index} className="text-muted-foreground">{source.label} · {source.state}</p>)}
    {stale && <p className="text-amber-700">本次 Run 已过期；刷新并重新核查后才能应用。</p>}
    {!targets.length ? <p>当前没有可供人工修改的已发布模板字段；必须先配置真实模板，不接受 AI 自造字段。</p> : <>
      <label className="block space-y-1">
        <span>选择实际修改目标（不自动猜测）</span>
        <select className="w-full rounded border bg-background p-2" value={targetId} onChange={(event) => { setTargetId(event.target.value); setDraft(''); setNotice('') }}>
          <option value="">请选择模板中的具体字段</option>
          {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {target && <div className="space-y-2">
        <p>旧值：<strong>{showT08FieldValue(target.before)}</strong></p>
        <label className="block space-y-1"><span>新值（由人工确认，不从模型自动填入）</span>
          {target.field.kind === 'boolean'
            ? <select className="w-full rounded border bg-background p-2" value={draft} onChange={(event) => setDraft(event.target.value)}>
                <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
              </select>
            : target.field.kind === 'enum' && target.field.options?.length
              ? <select className="w-full rounded border bg-background p-2" value={draft} onChange={(event) => setDraft(event.target.value)}>
                  <option value="">请选择</option>
                  {target.field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              : <input className="w-full rounded border bg-background p-2" value={draft} onChange={(event) => setDraft(event.target.value)}
                  placeholder={target.field.kind === 'number' ? '例如 18' : target.field.kind === 'date' ? 'YYYY-MM-DD' : '请输入核对后的实际值'} />
          }
        </label>
        <div className="rounded bg-background p-2">对比：{showT08FieldValue(target.before)} → <strong>{draft || '待填写'}</strong></div>
        {target.field.kind !== 'text' && <p className="text-amber-700">可以审阅新值，但当前 Main 仅能安全保存文本字段。数字、日期等需要 L 线接入模板类型事务后才能应用；不会将类型错误写入案卷。</p>}
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我已核对原件和模板，确认仅修改选定字段；这不是自动采纳模型意见，也不是校方审批。修改后原 Run 保留、需重新检查。</span>
        </label>
        <button type="button" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
          disabled={stale || busy || !draft.trim() || !confirmed || target.field.kind !== 'text'} onClick={() => void apply()}>
          {busy ? '正在保存…' : '人工确认并保存至案卷'}
        </button>
      </div>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
