/**
 * 待办页（界面重组阶段一）。
 *
 * 只读现有真实数据：遍历案卷聚合里的开放任务，按案卷归组展示。
 * 不造任务、不把"读取失败"当成零。
 */
import * as React from 'react'
import { Button } from '@profer/ui/primitives/button'
import { useSetAtom } from 'jotai'
import { reviewRouteAtom } from '@/atoms/review-route'
import { selectedCaseIdAtom } from '@/atoms/review-atoms'

interface OpenTask {
  caseId: string
  caseTitle: string
  taskId: string
  stageId: string
  role: string
  status: string
}

interface FailedCase {
  caseId: string
  reason: string
}

const ROLE_LABEL: Record<string, string> = {
  reviewer: '审核员',
  teacher: '终审教师',
  student: '提交人',
  organizer: '组织者',
  judge: '评委',
}

export function ReviewTasksPage(): React.ReactElement {
  const setRoute = useSetAtom(reviewRouteAtom)
  const setSelectedCaseId = useSetAtom(selectedCaseIdAtom)
  const [tasks, setTasks] = React.useState<OpenTask[]>([])
  const [failed, setFailed] = React.useState<FailedCase[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    const failures: FailedCase[] = []
    const collected: OpenTask[] = []
    try {
      const cases = await window.reviewAPI.listCasesV2()
      for (const entry of cases ?? []) {
        try {
          const aggregate = await window.reviewAPI.getAggregateV2(entry.caseId)
          if (!aggregate) { failures.push({ caseId: entry.caseId, reason: '读取不到案卷数据' }); continue }
          for (const task of aggregate.tasks ?? []) {
            if (task.status !== 'open') continue
            collected.push({
              caseId: entry.caseId,
              caseTitle: aggregate.caseV2.title,
              taskId: task.id,
              stageId: task.stageId,
              role: task.assigneeRole,
              status: task.status,
            })
          }
        } catch (cause) {
          failures.push({ caseId: entry.caseId, reason: cause instanceof Error ? cause.message : String(cause) })
        }
      }
      setTasks(collected)
      setFailed(failures)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const openTask = React.useCallback((task: OpenTask): void => {
    setSelectedCaseId(task.caseId)
    setRoute({ page: 'case', caseId: task.caseId, tab: 'workflow' })
  }, [setRoute, setSelectedCaseId])

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => void load()}>刷新</Button>
        <span className="text-xs text-muted-foreground">
          {loading ? '正在读取…' : `共 ${tasks.length} 项待处理`}
          {failed.length > 0 && ` · ${failed.length} 份案卷读取失败`}
        </span>
      </div>

      {failed.length > 0 && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">以下案卷未能读取，待办数不含其任务：</p>
          <ul className="mt-1 list-disc pl-5">
            {failed.map((item) => <li key={item.caseId}>{item.caseId}：{item.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border/60">
        {!loading && tasks.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">当前没有待处理事项。</p>
        )}
        {tasks.map((task) => (
          <div key={task.taskId}
            className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-muted/40">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{task.caseTitle}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {task.stageId} · 处理身份：{ROLE_LABEL[task.role] ?? task.role} · {task.taskId}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs"
              onClick={() => openTask(task)}>去处理</Button>
          </div>
        ))}
      </div>
    </div>
  )
}
