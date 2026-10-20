/**
 * T07 评委评分工作台容器（Local-L04 桥接层）。
 *
 * 面板 `ReviewV3T07JudgePanel` 是受控组件：只接受 Main 投影好的 T07View 与
 * onAction。本容器负责：
 * - 选择一个已有批次（评分轮次挂在批次上）；
 * - 以「组织者」或「本地评委」身份读取视图（角色只是声明，actor 由 Main 派生）；
 * - 把动作提交给 Main，带 expectedRevision，提交后重新读取视图。
 *
 * 不实现评分算法：排名、同分、缺评门控、冻结全部在 Main 的 T07 工作流里。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import type { T07Action, T07View } from '../../../main/lib/review/review-v3-t07-rating-workflow'
import { ReviewV3T07JudgePanel } from './ReviewV3T07JudgePanel'

type Claim = { role: 'judge' | 'organizer'; reviewerId?: string }

interface BatchSummary {
  id: string
  name?: string
  caseCount?: number
}

export function ReviewV3T07Workbench(): JSX.Element {
  const [batches, setBatches] = React.useState<BatchSummary[]>([])
  const [batchId, setBatchId] = React.useState('')
  const [claim, setClaim] = React.useState<Claim>({ role: 'organizer' })
  const [judgeId, setJudgeId] = React.useState('local-judge-1')
  const [view, setView] = React.useState<T07View | null>(null)
  const [revision, setRevision] = React.useState(0)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const loadBatches = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.reviewAPI.listBatchesV2()
      const mapped = (list ?? []).map((item: { id?: string; batch?: { id: string; name?: string; caseIds?: string[] } }) => ({
        id: item?.batch?.id ?? item?.id ?? '',
        name: item?.batch?.name ?? undefined,
        caseCount: item?.batch?.caseIds?.length ?? undefined,
      })).filter((item: BatchSummary) => Boolean(item.id))
      setBatches(mapped)
      if (!batchId && mapped[0]) setBatchId(mapped[0].id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [batchId])

  React.useEffect(() => { void loadBatches() }, [loadBatches])

  const effectiveClaim = React.useMemo<Claim>(() => (
    claim.role === 'judge' ? { role: 'judge', reviewerId: judgeId.trim() } : { role: 'organizer' }
  ), [claim, judgeId])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!batchId) return
    setBusy(true); setError('')
    try {
      const result = await window.reviewAPI.getT07View({ batchId, claim: effectiveClaim })
      setView(result.view); setRevision(result.revision)
    } catch (cause) {
      // 尚未初始化的批次是正常状态：提示如何开始，而不是报错
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.includes('T07_STATE_NOT_INITIALIZED')) { setView(null); setError('该批次还没有评分轮次') }
      else setError(message)
    } finally { setBusy(false) }
  }, [batchId, effectiveClaim])

  React.useEffect(() => { void refresh() }, [refresh])

  const startRound = React.useCallback(async (): Promise<void> => {
    if (!batchId) return
    setBusy(true); setError('')
    try {
      const detail = await window.reviewAPI.getBatchV2(batchId)
      const caseIds: string[] = (detail?.batch?.caseIds ?? []).slice(0, 50)
      if (caseIds.length === 0) throw new Error('该批次没有案卷，无法建立评分轮次')
      // 一次性初始化：匿名标签按序生成，不泄露真实案卷标题
      const initialState = {
        batchId,
        rubricVersion: 1,
        rubric: {
          id: 'e2e-default-rubric', name: '默认评分表', version: 1, strategy: 'weighted-mean',
          dimensions: [
            { id: 'quality', name: '质量', weight: 1, min: 0, max: 5 },
            { id: 'impact', name: '影响', weight: 1, min: 0, max: 5 },
          ],
          minEffectiveJudges: 2,
          conversion: { mode: 'linear', targetMax: 100 },
        },
        cases: caseIds.map((caseId, index) => ({
          caseId, blindLabel: `案件 ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? Math.floor(index / 26) : ''}`,
        })),
        rounds: [{ number: 1, assignments: [], votes: [], divergenceReasons: {}, tieOrders: {} }],
      } as never
      // 建轮次是独立动作：T07 的 reopen 只对已冻结轮次有效
      const result = await window.reviewAPI.initT07State({
        batchId, claim: effectiveClaim, state: initialState,
      })
      setView(result.view); setRevision(result.revision)
      toast.success('已建立评分轮次')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }, [batchId, effectiveClaim])

  const onAction = React.useCallback(async (action: T07Action): Promise<void> => {
    if (!batchId) return
    const result = await window.reviewAPI.applyT07Action({
      batchId, claim: effectiveClaim, expectedRevision: revision, action,
    })
    setView(result.view); setRevision(result.revision)
  }, [batchId, effectiveClaim, revision])

  return (
    <section aria-label="T07 评委评分工作台" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="h-7 rounded-md border bg-background px-2"
          value={batchId}
          onChange={(event) => setBatchId(event.target.value)}
          aria-label="选择评分批次"
        >
          <option value="">选择批次…</option>
          {batches.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name ?? item.id}{item.caseCount !== undefined ? `（${item.caseCount} 案）` : ''}
            </option>
          ))}
        </select>
        <select
          className="h-7 rounded-md border bg-background px-2"
          value={claim.role}
          onChange={(event) => setClaim({ role: event.target.value as 'judge' | 'organizer' })}
          aria-label="选择身份"
        >
          <option value="organizer">组织者（本机审核员）</option>
          <option value="judge">本地评委</option>
        </select>
        {claim.role === 'judge' && (
          <input
            className="h-7 w-40 rounded-md border bg-background px-2"
            value={judgeId}
            onChange={(event) => setJudgeId(event.target.value)}
            aria-label="本地评委标识"
            placeholder="本地评委标识"
          />
        )}
        <Button size="sm" variant="outline" disabled={busy || !batchId} onClick={() => void refresh()}>刷新</Button>
        <Button size="sm" disabled={busy || !batchId || Boolean(view)} onClick={() => void startRound()}>建立评分轮次</Button>
      </div>

      {error && <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">{error}</p>}

      {view ? (
        <ReviewV3T07JudgePanel view={view} onAction={onAction} />
      ) : (
        <p className="text-xs text-muted-foreground">
          选择批次后点「建立评分轮次」。评分与冻结状态由 Main 持久保存，重启后仍在。
        </p>
      )}
    </section>
  )
}
