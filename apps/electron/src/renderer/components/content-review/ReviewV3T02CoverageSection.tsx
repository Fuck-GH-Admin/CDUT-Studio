/**
 * T02 材料覆盖区容器（Local-L04 桥接）。
 *
 * 只读：从 Main 取当前案卷的暂存来源预览，交给 T02 的展示组件。
 * 预览是 staging-only，不产生 DocumentVersion，也不改变案卷。
 */
import * as React from 'react'
import { Button } from '@profer/ui/primitives/button'
import { ReviewV3T02MaterialCoveragePanel } from './ReviewV3T02MaterialCoveragePanel'

interface StagedInventory {
  total: number
  parsed: number
  partial: number
  failed: number
  imagesAwaitingInspection: number
  sources: Parameters<typeof ReviewV3T02MaterialCoveragePanel>[0]['sources']
}

export function ReviewV3T02CoverageSection({ caseId }: { caseId: string }): JSX.Element {
  const [inventory, setInventory] = React.useState<StagedInventory | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    if (!caseId) return
    setBusy(true); setError('')
    try {
      const result = await window.reviewAPI.getT02StagedInventory(caseId)
      setInventory(result as unknown as StagedInventory)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }, [caseId])

  React.useEffect(() => { void load() }, [load])

  return (
    <section aria-label="材料来源与解析覆盖" className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || !caseId} onClick={() => void load()}>
          读取材料覆盖
        </Button>
        <span className="text-xs text-muted-foreground">
          只读预览：暂存来源不等于已登记原件
        </span>
      </div>
      {error && (
        <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {error}
        </p>
      )}
      {inventory && inventory.sources.length > 0 && (
        <ReviewV3T02MaterialCoveragePanel sources={inventory.sources} />
      )}
      {inventory && inventory.sources.length === 0 && (
        <p className="text-xs text-muted-foreground">当前案卷还没有可预览的来源</p>
      )}
    </section>
  )
}
