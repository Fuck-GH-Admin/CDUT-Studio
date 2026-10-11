/**
 * 审核结果面板：展示最近一次真实运行的检查明细、结论和覆盖情况
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReviewRunV2 } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { toast } from 'sonner'

const STATUS_LABEL: Record<string, string> = {
  compliant: '符合', 'non-compliant': '不符合', 'needs-confirmation': '待确认', 'not-applicable': '不适用', 'not-executed': '未执行', 'execution-failed': '执行失败', 'awaiting-confirmation': '待确认', 'awaiting-supplement': '待补件',
}

interface RunPreflight {
  deterministicCount: number
  semanticCount: number
  manualCount: number
  missingRequiredSlots: string[]
  missingDataCheckSlots: string[]
  policyReviewTitles: string[]
}

export function RunResultPanel({ caseId, refreshNonce }: { caseId: string; refreshNonce: number }): JSX.Element {
  const [runs, setRuns] = useState<ReviewRunV2[]>([])
  const [ruleLabels, setRuleLabels] = useState<Record<string, string>>({})
  const [preflight, setPreflight] = useState<RunPreflight | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, aggregate] = await Promise.all([window.reviewAPI.listRunsV2(caseId), window.reviewAPI.getAggregateV2(caseId)])
      setRuns(list ?? [])
      if (aggregate) {
        const template = await window.reviewAPI.getTemplateV2(aggregate.caseV2.templateId, aggregate.caseV2.templateVersion)
        const labels: Record<string, string> = {}
        const criteria = (template?.sections ?? []).flatMap((section) => section.criteria ?? [])
        for (const section of template?.sections ?? []) {
          for (const criterion of section.criteria ?? []) labels[`section-${section.id}-${criterion.id}`] = `${section.name} · ${criterion.title}`
        }
        setRuleLabels(labels)
        const activeDocuments = aggregate.caseV2.documents.filter((document) => document.active !== false)
        const missingRequiredSlots = (template?.materialSlots ?? []).filter((slot) => slot.requiredAt !== 'decision' && slot.minCount > 0 && activeDocuments.filter((document) => document.materialSlotId === slot.id).length < slot.minCount).map((slot) => slot.name)
        const dataChecks = criteria.flatMap((criterion) => criterion.execution === 'deterministic' && criterion.dataCheck ? [criterion.dataCheck] : [])
        const missingDataCheckSlots = [...new Set(dataChecks.filter((check) => !activeDocuments.some((document) => document.materialSlotId === check.materialSlotId && document.blocks.some((block) => block.location?.kind === 'sheet-cell'))).map((check) => (template?.materialSlots ?? []).find((slot) => slot.id === check.materialSlotId)?.name ?? check.materialSlotId))]
        const hasConfirmedPolicy = (template?.policyRefs?.length ?? 0) > 0 || (template?.policyVersionIds.length ?? 0) > 0
        const policyReviewTitles = !hasConfirmedPolicy
          ? criteria.filter((criterion) => criterion.execution === 'manual' && /政策|制度|额度|限额|标准|资格|可报/.test(criterion.title + criterion.requirement)).map((criterion) => criterion.title)
          : []
        setPreflight({
          deterministicCount: criteria.filter((criterion) => criterion.execution === 'deterministic').length,
          semanticCount: criteria.filter((criterion) => criterion.execution === 'semantic').length,
          manualCount: criteria.filter((criterion) => criterion.execution === 'manual').length,
          missingRequiredSlots,
          missingDataCheckSlots,
          policyReviewTitles,
        })
      }
      if (list && list.length > 0) setExpandedRun(list[0]!.id)
    } catch (error) {
      console.error('[审核] 运行列表加载失败', error)
    }
  }, [caseId])

  useEffect(() => { void load() }, [load, refreshNonce])

  /** 触发真实审核运行（RUN_REVIEW_V2 四层：真实渠道 + 真实执行器） */
  /** 导出报告：真实调用 EXPORT_REPORT_V2（公开反馈投影 + 检查结果落盘 MD） */
  const exportReport = useCallback(async (): Promise<void> => {
    try {
      const result = await window.reviewAPI.exportReportV2(caseId)
      toast.success(`报告已导出：${result.file}`)
    } catch (error) {
      toast.error(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [caseId])

  const startRun = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      const run = await window.reviewAPI.runReviewV2(caseId)
      toast.success(`审核运行完成：${run.id}（检查 ${(run.checks ?? []).length} 项）`)
      await load()
    } catch (error) {
      toast.error(`审核运行失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunning(false)
    }
  }, [caseId, load])

  return (
    <div className="space-y-1.5 rounded-lg border-t pt-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">审核结果（{runs.length} 次）</p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={running} onClick={() => void startRun()}>{running ? '审核中…' : '开始审核'}</Button>
          <Button size="sm" variant="ghost" disabled={runs.length === 0} onClick={() => void exportReport()}>导出报告</Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}>刷新</Button>
        </div>
      </div>
      {preflight && (
        <div className="space-y-0.5 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
          <p>本模板分工：程序核对 {preflight.deterministicCount} 项 · Agent 核对 {preflight.semanticCount} 项 · 人工确认 {preflight.manualCount} 项。</p>
          {preflight.missingRequiredSlots.length > 0 && <p>尚缺必需材料：{preflight.missingRequiredSlots.join('、')}。上传后再开始，避免把缺件误作通过。</p>}
          {preflight.missingDataCheckSlots.length > 0 && <p>表格计算尚未就绪：{preflight.missingDataCheckSlots.join('、')}。缺少工作簿时对应计算会显示待补件。</p>}
          {preflight.policyReviewTitles.length > 0 && <p>模板没有关联正式政策；{preflight.policyReviewTitles.join('、')}会留给人工判断，不自动决定额度或资格。</p>}
        </div>
      )}
      {runs.length === 0 && <p className="text-xs text-muted-foreground">尚未开始审核。点击“开始自动审核”后，系统会读取当前材料和审核依据。</p>}
      {runs.slice(0, 3).map((run) => (
        <div key={run.id} className="rounded-md border p-2 text-xs">
          <button type="button" className="flex w-full items-center justify-between" onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
            <span className="font-medium">{run.id.slice(-12)} · {run.status}{run.completedAt ? ` · ${new Date(run.completedAt).toLocaleTimeString()}` : ''}</span>
            <span className="text-muted-foreground">检查 {run.checks.length} · 覆盖 {run.coverage.completedChecks}/{run.coverage.plannedChecks}</span>
          </button>
          {expandedRun === run.id && (
            <div className="mt-1.5 space-y-1">
              {run.checks.length === 0 && <p className="text-muted-foreground">本次运行未产生检查结果（核对规则来源与模型返回）</p>}
              {run.checks.map((check, index) => {
                  const item = check as { ruleId: string; status: string; reason: string }
                  return (
                  <div key={index} className="flex items-start justify-between gap-2 rounded bg-muted/40 px-1.5 py-1">
                    <span className="min-w-0"><span className="font-medium">{ruleLabels[item.ruleId] ?? item.ruleId}</span><span className="text-muted-foreground">：{item.reason}</span></span>
                    <span className={item.status === 'compliant' ? 'text-emerald-600' : item.status === 'non-compliant' ? 'text-red-600' : 'text-amber-600'}>{STATUS_LABEL[item.status] ?? item.status}</span>
                  </div>
                )
              })}
              {run.opinions.length > 0 && <p className="rounded bg-muted/40 px-1.5 py-1">结论：{(run.opinions[0] as unknown as { text?: string }).text ?? '—'}</p>}
              {run.agentActivity && run.agentActivity.length > 0 && (
                <details className="text-muted-foreground">
                  <summary>Agent 材料能力调用（{run.agentActivity.length}）</summary>
                  <ol className="list-decimal pl-4">{run.agentActivity.map((activity, index) => <li key={`${index}-${activity}`}>{activity}</li>)}</ol>
                </details>
              )}
              {run.modelUsage && run.modelUsage.length > 0 && (
                <p className="text-muted-foreground">按需图像核验：{run.modelUsage.length} 次模型调用 · {run.modelUsage.reduce((sum, item) => sum + (item.tokens ?? 0), 0).toLocaleString()} tokens。</p>
              )}
              {run.diagnostics.length > 0 && (
                <details className="text-muted-foreground">
                  <summary>诊断（{run.diagnostics.length}）</summary>
                  <ul className="list-disc pl-4">{run.diagnostics.map((line, index) => <li key={index}>{line}</li>)}</ul>
                </details>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
