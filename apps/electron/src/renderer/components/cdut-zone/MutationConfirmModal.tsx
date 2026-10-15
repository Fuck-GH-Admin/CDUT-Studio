/**
 * MutationConfirmModal — 教务写操作二次确认弹窗
 *
 * 当 Pi Agent 触发选退课、报名、缓考、改密等高危写操作时，主进程会派发
 * `cdut-zone:on-mutation-request`；本组件以高亮浮层呈现，仅在用户点击
 * 「确认执行」后，底层青果教务客户端才会真正提交 POST 变更。
 */

import * as React from 'react'
import { ShieldAlert } from 'lucide-react'
import type { CdutMutationConfirmRequest } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { Z_LAYER } from '@profer/ui'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

export function MutationConfirmModal(): React.ReactElement | null {
  const [request, setRequest] = React.useState<CdutMutationConfirmRequest | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [secondsLeft, setSecondsLeft] = React.useState(30)

  // 全局模态叠加登记：写操作二次确认弹出时，智联万站原生视口必须让位
  useGlobalOverlay(!!request)

  React.useEffect(() => {
    const unsub = window.electronAPI.cdutZone.onMutationRequest((req) => {
      setRequest(req)
      setSubmitting(false)
      setSecondsLeft(30)
    })
    return () => unsub()
  }, [])

  const respond = React.useCallback(async (confirmed: boolean): Promise<void> => {
    if (!request) return
    setSubmitting(true)
    try {
      await window.electronAPI.cdutZone.confirmMutation({ requestId: request.requestId, confirmed })
    } finally {
      setRequest(null)
      setSubmitting(false)
    }
  }, [request])

  // 30 秒自适应倒计时防卡死
  React.useEffect(() => {
    if (!request) return
    setSecondsLeft(30)
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          void respond(false)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [request, respond])

  if (!request) return null

  return (
    <div className={`fixed inset-0 ${Z_LAYER.confirm} flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm`}>
      <div className="w-full max-w-md rounded-2xl border border-border/80 bg-card p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
            <ShieldAlert size={20} />
          </span>
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-foreground">教务写操作二次确认</h3>
            <p className="text-xs text-muted-foreground">{request.description}</p>
          </div>
        </div>

        <div className="mt-4 space-y-1 rounded-xl bg-muted/60 p-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">操作类型</span>
            <span className="text-right font-medium text-foreground">{request.title}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">触发工具</span>
            <span className="font-mono text-[11px] text-foreground">{request.toolName}</span>
          </div>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-amber-600">
          ⚠️ 此操作将直接提交至成都理工大学青果教务系统，可能影响您的学籍或选课结果，请谨慎确认。
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={submitting} onClick={() => void respond(false)}>
            取消 ({secondsLeft}s)
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => void respond(true)}>
            {submitting ? '正在提交…' : '确认执行'}
          </Button>
        </div>
      </div>
    </div>
  )
}
