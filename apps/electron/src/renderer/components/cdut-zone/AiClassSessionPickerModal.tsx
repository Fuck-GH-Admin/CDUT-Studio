/**
 * AiClassSessionPickerModal — AI 速课堂会话选择前置弹窗
 *
 * 拦截式时序设计：点击专区首页「AI速课堂」Bento 卡片时先弹出本弹窗，
 * 顶部醒目展示【＋ 开始新课堂】卡片，下方卡片式罗列历史课堂（课程名 / 最近学习时间 /
 * 资料数 / 删除）。用户新建或选定课堂后，才真正进入速课堂主页面。
 */

import * as React from 'react'
import {
  BookOpen,
  Clock,
  GraduationCap,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import type { AiClassSessionSummary } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@profer/ui/primitives/dialog'
import { cn } from '@/lib/utils'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

interface AiClassSessionPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 选中或新建课堂后的回调（携带 sessionId 与课程名） */
  onSelect: (sessionId: string, courseName: string) => void
}

/** 最近学习时间的可读格式化 */
function formatLastActive(timestamp: number): string {
  if (!timestamp) return '—'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function AiClassSessionPickerModal({
  open,
  onOpenChange,
  onSelect,
}: AiClassSessionPickerModalProps): React.ReactElement {
  const [sessions, setSessions] = React.useState<AiClassSessionSummary[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [newCourseName, setNewCourseName] = React.useState('')
  const [error, setError] = React.useState('')

  // 全局模态叠加登记：课堂选择器打开时，智联万站原生视口必须让位
  useGlobalOverlay(open)

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const list = await window.electronAPI.cdutAiClass.listSessions()
      setSessions(list)
    } catch (err) {
      console.warn('[AI速课堂] 加载历史课堂失败:', err)
      setError('加载历史课堂失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  // 每次打开弹窗时刷新历史课堂列表
  React.useEffect(() => {
    if (!open) return
    setNewCourseName('')
    setError('')
    void refresh()
  }, [open, refresh])

  const handleCreate = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    setError('')
    try {
      const created = await window.electronAPI.cdutAiClass.createSession(newCourseName)
      onSelect(created.sessionId, created.courseName)
      onOpenChange(false)
    } catch (err) {
      console.error('[AI速课堂] 新建课堂失败:', err)
      setError('新建课堂失败，请稍后重试')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (sessionId: string): Promise<void> => {
    try {
      await window.electronAPI.cdutAiClass.deleteSession(sessionId)
      setSessions((prev) => prev.filter((session) => session.sessionId !== sessionId))
    } catch (err) {
      console.warn('[AI速课堂] 删除课堂失败:', err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl w-full gap-0 rounded-2xl border-border/70 bg-card p-6 shadow-2xl">
        <DialogHeader className="mb-4 space-y-1.5 text-left">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <GraduationCap size={17} />
            </span>
            <DialogTitle className="text-base font-semibold tracking-tight">
              AI 速课堂 · 选择学习课堂
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            每个课堂是一个独立的沉浸式学习空间，资料与对话彼此隔离。
          </DialogDescription>
        </DialogHeader>

        {/* 顶部醒目：开始新课堂卡片 */}
        <div className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm shadow-primary/5">
          <div className="flex items-center gap-2 text-xs font-semibold text-primary">
            <Plus size={14} />
            <span>开始新课堂</span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={newCourseName}
              onChange={(event) => setNewCourseName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder="输入课程名称，如「高数期末冲刺」"
              className="h-9 flex-1 text-xs"
              disabled={creating}
            />
            <Button
              type="button"
              size="sm"
              disabled={creating}
              onClick={() => void handleCreate()}
              className="h-9 gap-1.5 px-4 text-xs font-semibold"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              <span>开启</span>
            </Button>
          </div>
        </div>

        {/* 历史课堂列表 */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              历史课堂
            </span>
            <span className="text-[11px] text-muted-foreground/70">{sessions.length}</span>
          </div>

          {error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              <span>正在加载历史课堂…</span>
            </div>
          ) : sessions.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
              还没有历史课堂，在上面输入课程名开启第一节吧。
            </p>
          ) : (
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5">
              {sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className={cn(
                    'group/item flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5',
                    'transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(session.sessionId, session.courseName)
                      onOpenChange(false)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <BookOpen size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {session.courseName}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock size={11} />
                          {formatLastActive(session.lastActiveAt)}
                        </span>
                        <span>· {session.documentCount} 份资料</span>
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    title="删除该课堂"
                    onClick={() => void handleDelete(session.sessionId)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/item:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部版权声明 */}
        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          Powered by 雫窝中央实验室 · 2026
        </p>
      </DialogContent>
    </Dialog>
  )
}
