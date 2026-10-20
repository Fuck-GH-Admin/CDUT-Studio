/**
 * CsLabToolTrustBadge — 实验室 Python 工具免审批状态的常驻徽章
 *
 * 仅在会话绑定实验室且当前权限模式为 bypassPermissions 时显示：
 * - 已信任：高对比警示色，提示 Agent 可直接执行实验室全部 Python 代码，并提供一键恢复逐次确认；
 * - 未信任（含冷启动）：提示仍需逐次审批，并提供显式启用入口（二次确认后生效）。
 *
 * 信任状态只存在于主进程内存，本组件不持久化任何内容。
 */

import * as React from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { ConfirmDialog } from '@profer/ui/primitives/confirm-dialog'
import type { ProferPermissionMode } from '@profer/shared'
import { cn } from '@/lib/utils'

interface CsLabToolTrustBadgeProps {
  sessionId: string
  labId: string
  permissionMode: ProferPermissionMode
  revision?: number
}

export function CsLabToolTrustBadge({
  sessionId,
  labId,
  permissionMode,
  revision,
}: CsLabToolTrustBadgeProps): React.ReactElement | null {
  const active = permissionMode === 'bypassPermissions'
  const [trusted, setTrusted] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  React.useEffect(() => {
    if (!active) {
      setTrusted(false)
      return
    }
    let cancelled = false
    void window.electronAPI.cslab
      .getToolTrust(sessionId)
      .then((value) => {
        if (!cancelled) setTrusted(Boolean(value))
      })
      .catch((error: unknown) => {
        console.warn('[CsLabToolTrustBadge] 读取工具信任状态失败:', error)
      })
    return () => {
      cancelled = true
    }
  }, [active, sessionId, labId])

  if (!active) return null

  const restorePerCallApproval = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.electronAPI.updateSessionPermissionMode(sessionId, 'auto', revision)
      setTrusted(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复逐次确认失败')
    } finally {
      setBusy(false)
    }
  }

  const enableBypass = async (): Promise<void> => {
    setBusy(true)
    try {
      // 同模式调用也会触发主进程写入显式信任。
      await window.electronAPI.updateSessionPermissionMode(sessionId, 'bypassPermissions', revision)
      setTrusted(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启用免审批失败')
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <>
      <div
        className={cn(
          'mx-4 mb-3 flex items-start gap-2 rounded-xl px-3 py-2 shadow-lg animate-in slide-in-from-bottom-2 duration-200',
          trusted
            ? 'border border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200'
            : 'border border-border/60 bg-card text-foreground',
        )}
      >
        {trusted ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        ) : (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">
            {trusted ? '免审批全自动模式' : '实验室 Python 工具待授权'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {trusted
              ? 'Agent 可直接执行本实验室全部自定义 Python 代码，执行记录写入 runtime/logs/tool-executions.jsonl。'
              : '自定义 Python 工具仍将逐次确认；启用后仅在本次运行期免审批，重启应用或切换实验室即失效。'}
          </p>
        </div>
        <Button
          variant={trusted ? 'outline' : 'default'}
          size="sm"
          disabled={busy}
          className="h-7 shrink-0 px-3 text-xs"
          onClick={() => {
            if (trusted) void restorePerCallApproval()
            else setConfirmOpen(true)
          }}
        >
          {trusted ? '恢复逐次确认' : '启用免审批'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="允许 Agent 直接执行实验室 Python 代码？"
        description="启用后，本会话在本次运行期内调用实验室自定义 Python 工具将不再逐次弹窗；软件重启或切换实验室后自动失效。"
        confirmLabel="启用免审批"
        cancelLabel="取消"
        variant="destructive"
        loading={busy}
        onConfirm={() => void enableBypass()}
      />
    </>
  )
}
