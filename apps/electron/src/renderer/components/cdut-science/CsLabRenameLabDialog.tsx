/**
 * CsLabRenameLabDialog — 重命名实验室
 *
 * 仅修改清单展示名称，沙箱目录、labId 与历史数据保持不变。
 * 视觉沿用 CSLab 羊皮纸暖调 token。
 */

import * as React from 'react'
import type { CsLabLab } from '@profer/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@profer/ui/primitives/dialog'

interface CsLabRenameLabDialogProps {
  lab: CsLabLab | null
  onClose: () => void
  onRenamed: (lab: CsLabLab) => void
}

export function CsLabRenameLabDialog({
  lab,
  onClose,
  onRenamed,
}: CsLabRenameLabDialogProps): React.ReactElement {
  const [name, setName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!lab) return
    setName(lab.name)
    setError(null)
    setSubmitting(false)
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
    return () => clearTimeout(timer)
  }, [lab])

  const handleSubmit = async (): Promise<void> => {
    if (!lab || submitting) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('实验室名称不能为空')
      return
    }
    if (trimmed === lab.name) {
      onClose()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const updated = await window.electronAPI.cslab.renameLab({ labId: lab.id, name: trimmed })
      onRenamed(updated)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={!!lab}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose()
      }}
    >
      <DialogContent className="border-cslab-border bg-cslab-elevated text-cslab-text sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl font-medium text-cslab-text">
            重命名实验室
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-cslab-muted">
            仅修改展示名称，沙箱目录、编号与历史数据保持不变。
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">
              实验室名称
            </span>
            <input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // 拼音输入法回车选词时不要触发表单提交。
                if (event.key === 'Enter' && event.nativeEvent.isComposing) {
                  event.preventDefault()
                }
              }}
              maxLength={60}
              placeholder="例如：固态电池界面课题组"
              className="mt-1.5 w-full rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-sm text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cslab-accent/30"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-3 py-1.5 text-xs text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="rounded-lg bg-cslab-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
