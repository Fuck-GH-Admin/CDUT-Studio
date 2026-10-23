/**
 * CsLabDeleteLabDialog — 实验室防误触彻底删除
 *
 * 红线：必须输入与实验室完整名称一致的文本才允许确认；
 * 确认后主进程会停止监听、关闭 SQLite 并物理删除沙箱目录。
 */

import * as React from 'react'
import type { CsLabLab } from '@profer/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'

interface CsLabDeleteLabDialogProps {
  lab: CsLabLab | null
  onClose: () => void
  onDeleted: (labId: string) => void
}

export function CsLabDeleteLabDialog({
  lab,
  onClose,
  onDeleted,
}: CsLabDeleteLabDialogProps): React.ReactElement {
  const [confirmName, setConfirmName] = React.useState('')
  const [deleting, setDeleting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!lab) return
    setConfirmName('')
    setError(null)
    setDeleting(false)
    const timer = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [lab])

  const confirmed = !!lab && confirmName.trim() === lab.name

  const handleDelete = async (): Promise<void> => {
    if (!lab || !confirmed || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await window.electronAPI.cslab.deleteLab(lab.id)
      onDeleted(lab.id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog
      open={!!lab}
      onOpenChange={(open) => {
        if (!open && !deleting) onClose()
      }}
    >
      <AlertDialogContent className="border-cslab-border bg-cslab-elevated text-cslab-text sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-xl font-medium text-cslab-text">
            彻底删除实验室
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs leading-relaxed text-cslab-muted">
            此操作不可逆。将物理抹除「
            <span className="font-medium text-cslab-text">{lab?.name ?? ''}</span>
            」的本地沙箱文件夹、SQLite 数据库与全部实验数据；已绑定的历史会话会脱敏解绑保留。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">
            请输入实验室完整名称以确认
          </span>
          <input
            ref={inputRef}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (event.nativeEvent.isComposing) {
                  event.preventDefault()
                  return
                }
                event.preventDefault()
                void handleDelete()
              }
            }}
            placeholder={lab?.name ?? ''}
            className="w-full rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-sm text-cslab-text placeholder:text-cslab-muted/50 focus:border-red-400/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/30"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {error}
          </p>
        )}

        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel
            disabled={deleting}
            className="mt-0 border-cslab-border bg-transparent text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!confirmed || deleting}
            onClick={(event) => {
              event.preventDefault()
              void handleDelete()
            }}
            className="bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? '删除中…' : '确认彻底删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
