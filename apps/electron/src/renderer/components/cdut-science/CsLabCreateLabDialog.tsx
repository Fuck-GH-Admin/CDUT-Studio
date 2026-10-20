/**
 * CsLabCreateLabDialog — 新建实验室
 *
 * 社论式极简：暖白卡片、1px 发丝边框、赤陶主操作、无浓重阴影。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import type { CsLabLab } from '@profer/shared'

interface CsLabCreateLabDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (lab: CsLabLab) => void
}

export function CsLabCreateLabDialog({
  open,
  onClose,
  onCreated,
}: CsLabCreateLabDialogProps): React.ReactElement | null {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [tags, setTags] = React.useState('')
  const [rootPath, setRootPath] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setName('')
      setDescription('')
      setTags('')
      setRootPath('')
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  if (!open) return null

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const lab = await window.electronAPI.cslab.createLab({
        name: name.trim(),
        description: description.trim() || undefined,
        tags: tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        rootPath: rootPath.trim() || undefined,
      })
      onCreated(lab)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-cslab-text/20 px-6">
      <div className="w-full max-w-lg rounded-2xl border border-cslab-border bg-cslab-elevated p-6 shadow-subtle">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-serif text-xl font-medium text-cslab-text">新建实验室</h2>
            <p className="mt-1 text-xs leading-relaxed text-cslab-muted">
              每个实验室是一个完全自包含的课题沙箱，包含数据铁笼、文稿与运行时目录。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg p-1.5 text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
          >
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">实验室名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              autoFocus
              placeholder="例如：固态电池界面课题组"
              className="mt-1.5 w-full rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-sm text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/50 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">研究方向</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="一句话描述课题目标"
              className="mt-1.5 w-full resize-none rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-sm leading-relaxed text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/50 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">标签（逗号分隔）</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="谱学表征, 电化学"
              className="mt-1.5 w-full rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-sm text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/50 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-cslab-muted">
              自定义目录（可选）
            </span>
            <input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder="例如 D:\\Research\\SolidStateBattery"
              className="mt-1.5 w-full rounded-xl border border-cslab-border bg-cslab-bg px-3 py-2 text-xs text-cslab-text placeholder:text-cslab-muted/60 focus:border-cslab-accent/50 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] leading-relaxed text-cslab-muted">
              留空则使用 ~/.cdutai/cslab-workspaces/ 下的默认沙箱目录。
            </span>
          </label>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="rounded-lg bg-cslab-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? '创建中…' : '创建实验室'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
