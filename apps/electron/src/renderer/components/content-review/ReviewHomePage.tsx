/**
 * 审核首页（界面重组规范 4.0）。
 *
 * 职责：让用户一进来就知道「从哪里开始 / 上次审到哪 / 接下来做什么」。
 * 数据全部来自真实 Main 回执：当前案卷聚合、运行记录、开放任务、最近案卷。
 * 不保存首页专用副本，不擅自把列表第一项当成当前案卷。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import type { CaseAggregateV2, ReviewRunV2 } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { reviewRouteAtom, type CaseTab } from '@/atoms/review-route'
import { selectedCaseIdAtom } from '@/atoms/review-atoms'

interface CaseRow {
  caseId: string
  title: string
  stage: string
  revision: number
  templateId: string
  templateVersion: number
  updatedAt: string
}

const STAGE_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  reviewing: '审核中',
  'awaiting-supplement': '等待补件',
  decided: '已形成决定',
  archived: '已归档',
}

const RUN_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  'partially-completed': '部分完成',
  running: '执行中',
  failed: '执行失败',
  stopped: '已停止',
}

interface BriefState {
  aggregate: CaseAggregateV2 | null
  run: ReviewRunV2 | null
  openTasks: number
  loading: boolean
  error: string | null
}

export function ReviewHomePage(): React.ReactElement {
  const setRoute = useSetAtom(reviewRouteAtom)
  const currentCaseId = useAtomValue(selectedCaseIdAtom)
  const setSelectedCaseId = useSetAtom(selectedCaseIdAtom)
  const [cases, setCases] = React.useState<CaseRow[]>([])
  const [casesLoading, setCasesLoading] = React.useState(true)
  const [state, setState] = React.useState<BriefState>({ aggregate: null, run: null, openTasks: 0, loading: true, error: null })

  const openCase = React.useCallback((caseId: string): void => {
    setSelectedCaseId(caseId)
    setRoute({ page: 'case', caseId, tab: 'materials' })
  }, [setRoute, setSelectedCaseId])

  const goTab = React.useCallback((tab: CaseTab, caseId: string): void => {
    setSelectedCaseId(caseId)
    setRoute({ page: 'case', caseId, tab })
  }, [setRoute, setSelectedCaseId])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.reviewAPI.listCasesV2()
        if (!cancelled) setCases((list ?? []) as CaseRow[])
      } catch (cause) {
        if (!cancelled) toast.error(`读取案卷列表失败：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally {
        if (!cancelled) setCasesLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (!currentCaseId) { setState({ aggregate: null, run: null, openTasks: 0, loading: false, error: null }); return }
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    void (async () => {
      try {
        const aggregate = await window.reviewAPI.openAggregateV2(currentCaseId)
        const runs = await window.reviewAPI.listRunsV2(currentCaseId)
        if (cancelled) return
        if (!aggregate) {
          setState({ aggregate: null, run: null, openTasks: 0, loading: false, error: '当前案卷不可读取或被移除' })
          return
        }
        setState({
          aggregate,
          run: (runs ?? [])[0] ?? null,
          openTasks: (aggregate.tasks ?? []).filter((task) => task.status === 'open').length,
          loading: false,
          error: null,
        })
      } catch (cause) {
        if (!cancelled) setState({ aggregate: null, run: null, openTasks: 0, loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      }
    })()
    return () => { cancelled = true }
  }, [currentCaseId])

  const aggregate = state.aggregate
  const run = state.run
  const documents = aggregate ? aggregate.caseV2.documents.filter((doc) => doc.active !== false).length : 0
  const unresolvedChecks = run?.checks.filter((check) => check.status === 'awaiting-confirmation' || check.status === 'non-compliant').length ?? 0
  const openTasks = (aggregate?.tasks ?? []).filter((task) => task.status === 'open')

  /** 下一步按规范 5.3 的优先级取一条，并带具体目标页。 */
  const next = React.useMemo((): { label: string; action: string; tab: CaseTab } | null => {
    if (!aggregate) return null
    if (openTasks.length > 0) {
      return { label: `处理「${openTasks[0]!.stageId}」`, action: '去办理', tab: 'workflow' }
    }
    if (run && (run.status === 'queued' || run.status === 'awaiting-input' || run.status === 'awaiting-decision')) {
      return { label: '审核正在执行', action: '查看运行', tab: 'checks' }
    }
    if (!run) {
      return { label: '还没有检查结果', action: '开始审核', tab: 'checks' }
    }
    if (unresolvedChecks > 0) {
      return { label: `${unresolvedChecks} 项检查需要核对`, action: '核对检查', tab: 'checks' }
    }
    if (aggregate.caseV2.stage === 'decided') {
      return { label: '已形成决定', action: '查看结果与报告', tab: 'reports' }
    }
    return { label: `当前阶段：${STAGE_LABEL[aggregate.caseV2.stage] ?? aggregate.caseV2.stage}`, action: '继续办理', tab: 'workflow' }
  }, [aggregate, openTasks, run, unresolvedChecks])

  const recent = cases.slice(0, 5)
  const latestCase = cases[0]

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">审核首页</h1>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" className="h-8 text-xs"
            onClick={() => setRoute({ page: 'case-new', start: 'files' })}>新建审核</Button>
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
            onClick={() => setRoute({ page: 'case-new', start: 'template' })}>从模板新建</Button>
        </div>
      </header>

      {/* ===== 当前审核 ===== */}
      {currentCaseId && state.loading && (
        <section className="rounded-lg border border-border/60 px-4 py-6 text-xs text-muted-foreground">正在读取当前审核…</section>
      )}
      {currentCaseId && state.error && (
        <section className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          当前案卷读取失败：{state.error}
          <Button type="button" variant="ghost" size="sm" className="ml-2 h-6 text-xs"
            onClick={() => setRoute({ page: 'cases' })}>切换案卷</Button>
        </section>
      )}
      {currentCaseId && aggregate && (
        <section aria-label="当前审核" className="rounded-lg border border-border/60 bg-card/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">当前审核</p>
              <p className="mt-1 truncate text-base font-semibold">{aggregate.caseV2.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {STAGE_LABEL[aggregate.caseV2.stage] ?? aggregate.caseV2.stage}
                {' · '}检查{RUN_STATUS_LABEL[run?.status ?? ''] ?? (run ? run.status : '未开始')}
                {unresolvedChecks > 0 ? ` · ${unresolvedChecks} 项需要核对` : ''}
              </p>
            </div>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs"
              onClick={() => setRoute({ page: 'cases' })}>切换案卷</Button>
          </div>

          {next && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2">
              <p className="text-xs">下一步：<span className="font-medium">{next.label}</span></p>
              <Button type="button" size="sm" className="h-7 text-xs"
                onClick={() => goTab(next.tab, aggregate.caseV2.id)}>{next.action}</Button>
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            {([
              ['材料准备', `${documents} 份已登记`, 'materials' as CaseTab],
              ['审核检查', run ? `${run.checks.length} 项${unresolvedChecks > 0 ? `（${unresolvedChecks} 需核对）` : ''}` : '尚未开始', 'checks' as CaseTab],
              ['人工办理', openTasks.length > 0 ? `${openTasks.length} 项待办` : '暂无待办', 'workflow' as CaseTab],
              ['报告交付', aggregate.caseV2.stage === 'decided' ? '可查看报告' : '决定后可用', 'reports' as CaseTab],
            ] as Array<[string, string, CaseTab]>).map(([label, detail, tab]) => (
              <button key={label} type="button"
                className="rounded-md border border-border/60 bg-background px-3 py-2 text-left hover:bg-muted/50"
                onClick={() => goTab(tab, aggregate.caseV2.id)}>
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="mt-0.5 truncate text-xs font-medium">{detail}</p>
              </button>
            ))}
          </div>

          {openTasks.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium">本案待处理</p>
              <ul className="space-y-1">
                {openTasks.slice(0, 3).map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1">
                    <span className="truncate text-xs">{task.stageId} · 处理身份 {task.assigneeRole}</span>
                    <Button type="button" size="sm" variant="outline" className="h-6 text-[11px]"
                      onClick={() => goTab('workflow', aggregate.caseV2.id)}>处理</Button>
                  </li>
                ))}
              </ul>
              <Button type="button" size="sm" variant="ghost" className="mt-1 h-6 text-[11px]"
                onClick={() => setRoute({ page: 'tasks', view: 'actionable' })}>查看本案待办</Button>
            </div>
          )}
        </section>
      )}

      {/* ===== 没有当前案卷 ===== */}
      {!currentCaseId && (
        <section aria-label="开始审核" className="rounded-lg border border-border/60 bg-card/60 p-4">
          {latestCase ? (
            <>
              <p className="text-xs text-muted-foreground">继续最近一次审核</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p className="truncate text-base font-semibold">{latestCase.title}</p>
                <Button type="button" size="sm" className="h-7 text-xs" onClick={() => openCase(latestCase.caseId)}>继续</Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {STAGE_LABEL[latestCase.stage] ?? latestCase.stage} · 只有点击后才会打开并设为当前案卷。
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">还没有案卷</p>
              <p className="mt-1 text-xs text-muted-foreground">可以先把材料拖进来，或从已发布模板新建。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" className="h-8 text-xs"
                  onClick={() => setRoute({ page: 'case-new', start: 'files' })}>从材料开始</Button>
                <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                  onClick={() => setRoute({ page: 'case-new', start: 'template' })}>选择模板</Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* ===== 最近案卷 ===== */}
      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">最近案卷</h2>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs"
            onClick={() => setRoute({ page: 'cases' })}>查看全部案卷</Button>
        </div>
        <div className="overflow-hidden rounded-lg border border-border/60">
          {casesLoading && <p className="px-3 py-4 text-xs text-muted-foreground">正在读取…</p>}
          {!casesLoading && recent.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground">还没有案卷。</p>
          )}
          {recent.map((row) => (
            <div key={row.caseId}
              className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-muted/40">
              <div className="min-w-0">
                <p className="truncate text-sm">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {STAGE_LABEL[row.stage] ?? row.stage} · {row.templateId} v{row.templateVersion}
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs"
                onClick={() => openCase(row.caseId)}>继续处理</Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
