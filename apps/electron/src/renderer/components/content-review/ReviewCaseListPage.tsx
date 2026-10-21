/**
 * 案卷列表页（界面重组阶段一）。
 *
 * 职责边界（对应规范第 4 节）：
 * - 进入审核模块默认停在这里，不擅自打开第一份案卷；
 * - 只做"看列表 / 打开某案 / 新建"三件事，不承载材料、检查、办理；
 * - 新建通过显式路由进入独立页面，不在列表里堆一个巨大的建案表单。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { Button } from '@profer/ui/primitives/button'
import { reviewRouteAtom } from '@/atoms/review-route'
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
  'awaiting-supplement': '待补件',
  decided: '已决定',
  archived: '已归档',
}

export function ReviewCaseListPage(): React.ReactElement {
  const setRoute = useSetAtom(reviewRouteAtom)
  const setSelectedCaseId = useSetAtom(selectedCaseIdAtom)
  const [rows, setRows] = React.useState<CaseRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [keyword, setKeyword] = React.useState('')

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.reviewAPI.listCasesV2()
      setRows((list ?? []) as CaseRow[])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const openCase = React.useCallback((caseId: string): void => {
    setSelectedCaseId(caseId)
    setRoute({ page: 'case', caseId, tab: 'materials' })
  }, [setRoute, setSelectedCaseId])

  const visible = React.useMemo(() => {
    const needle = keyword.trim()
    if (!needle) return rows
    return rows.filter((row) => row.title.includes(needle) || row.caseId.includes(needle)
      || (STAGE_LABEL[row.stage] ?? row.stage).includes(needle))
  }, [rows, keyword])

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">案卷</h1>
          <p className="mt-1 text-xs text-muted-foreground">选择一份案卷继续处理，或新建一份。</p>
        </div>
        <div className="flex items-center gap-2">
          <input aria-label="搜索案卷" placeholder="搜索标题、编号或阶段"
            className="h-8 w-56 rounded-md border border-border bg-background px-2 text-xs"
            value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          <Button type="button" size="sm" className="h-8 text-xs" onClick={() => void load()}>刷新</Button>
          <Button type="button" size="sm" className="h-8 text-xs"
            onClick={() => setRoute({ page: 'case-new', start: 'files' })}>新建案卷</Button>
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          读取案卷列表失败：{error}
          <Button type="button" variant="ghost" size="sm" className="ml-2 h-6 text-xs" onClick={() => void load()}>重试</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60">
        {loading && <p className="px-3 py-6 text-center text-xs text-muted-foreground">正在读取案卷…</p>}
        {!loading && visible.length === 0 && (
          <div className="px-3 py-10 text-center">
            <p className="text-sm font-medium">还没有案卷</p>
            <p className="mt-1 text-xs text-muted-foreground">可以从材料开始，也可以先选一套已发布模板。</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button type="button" size="sm" className="h-8 text-xs"
                onClick={() => setRoute({ page: 'case-new', start: 'files' })}>从材料开始</Button>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs"
                onClick={() => setRoute({ page: 'case-new', start: 'template' })}>选择模板</Button>
            </div>
          </div>
        )}
        {visible.map((row) => (
          <div key={row.caseId}
            className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-muted/40">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{row.title}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {STAGE_LABEL[row.stage] ?? row.stage} · {row.templateId} v{row.templateVersion} · rev {row.revision} · {row.caseId}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs"
              onClick={() => openCase(row.caseId)}>打开</Button>
          </div>
        ))}
      </div>
    </div>
  )
}
