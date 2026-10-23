/**
 * BulletinDialog — 本地系统公告栏弹窗
 *
 * 双栏模态对话框：左侧公告条目导航（分类徽标 / 时间 / 标题 / 置顶 / 未读红点），
 * 右侧选中公告的 Markdown 富文本详情。关闭时写入 lastReadBulletinId 并标记本次会话已读，
 * 下次启动无新公告则静默。手动入口：「设置 → 关于 → 查看系统公告」。
 *
 * 开关状态由 bulletinDialogOpenAtom 自管理（App 零 props 挂载）；
 * Esc / 遮罩点击 / 「我知道了」统一走 onOpenChange(false) 关闭。
 */
import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { BellRing, Pin } from 'lucide-react'
import type { BulletinCategory, BulletinItem } from '@profer/shared'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@profer/ui/primitives/dialog'
import { Badge } from '@profer/ui/primitives/badge'
import { Button } from '@profer/ui/primitives/button'
import { ScrollArea, ScrollBar } from '@profer/ui/primitives/scroll-area'
import { MessageResponse } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import {
  bulletinDialogOpenAtom,
  bulletinLastReadIdAtom,
  bulletinListAtom,
  bulletinSessionDismissedAtom,
  selectedBulletinIdAtom,
} from '@/atoms/bulletin-atoms'
import { pickLatestBulletin, sortBulletinsForDisplay } from './bulletin-startup'

/** 分类徽标元数据（配色跟随主题色板，深浅色各自适配） */
const CATEGORY_META: Record<BulletinCategory, { label: string; className: string }> = {
  notice: { label: '重要通知', className: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  feature: { label: '新功能', className: 'border-sky-500/30 bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  tip: { label: '使用贴士', className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  maintenance: { label: '维护安排', className: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
}

/** 左栏单条公告条目 */
function BulletinListItem({
  item,
  active,
  unread,
  onSelect,
}: {
  item: BulletinItem
  active: boolean
  unread: boolean
  onSelect: () => void
}): React.ReactElement {
  const meta = CATEGORY_META[item.category] ?? CATEGORY_META.tip
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full rounded-xl px-3 py-2.5 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={cn('h-auto px-1.5 py-0 text-[10px] font-medium', meta.className)}>
          {meta.label}
        </Badge>
        {item.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="置顶公告" />}
        {unread && <span className="ml-auto size-2 shrink-0 rounded-full bg-red-500" aria-label="未读" />}
      </div>
      <p className={cn('mt-1.5 line-clamp-2 text-sm leading-snug', active ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {item.title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{item.date}</p>
    </button>
  )
}

export function BulletinDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(bulletinDialogOpenAtom)
  const [items, setItems] = useAtom(bulletinListAtom)
  const [selectedId, setSelectedId] = useAtom(selectedBulletinIdAtom)
  const lastReadId = useAtomValue(bulletinLastReadIdAtom)
  const setLastReadId = useSetAtom(bulletinLastReadIdAtom)
  const setSessionDismissed = useSetAtom(bulletinSessionDismissedAtom)

  // 打开时兜底：列表为空则拉取一次（覆盖「设置 → 关于」手动入口场景）；
  // 选中项缺失或不在列表中时回退到最新公告
  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    const ensureSelection = (list: BulletinItem[]): void => {
      if (list.some((it) => it.id === selectedId)) return
      const latest = pickLatestBulletin(list)
      if (latest) setSelectedId(latest.id)
    }

    if (items.length === 0) {
      window.electronAPI
        .getBulletins()
        .then((fetched) => {
          if (cancelled) return
          setItems(fetched)
          ensureSelection(fetched)
        })
        .catch((error) => console.error('[Bulletin] 读取公告失败:', error))
    } else {
      ensureSelection(items)
    }

    return () => {
      cancelled = true
    }
  }, [open, items, selectedId, setItems, setSelectedId])

  const sorted = React.useMemo(() => sortBulletinsForDisplay(items), [items])
  const selected = React.useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  )

  // 关闭：写入最新已读公告 ID（空数据兜底跳过），并标记本次运行会话已关闭
  const handleClose = React.useCallback((): void => {
    const latest = pickLatestBulletin(items)
    if (latest) {
      setLastReadId(latest.id)
      window.electronAPI.updateSettings({ lastReadBulletinId: latest.id }).catch(console.error)
    }
    setSessionDismissed(true)
    setOpen(false)
  }, [items, setLastReadId, setSessionDismissed, setOpen])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="flex h-[640px] max-w-[880px] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl">
        {/* 无障碍：Radix 强制要求 DialogTitle；描述用 sr-only 满足 aria-describedby */}
        <DialogTitle className="sr-only">系统公告</DialogTitle>
        <DialogDescription className="sr-only">查看 CDUT Studio 的系统公告与更新指引</DialogDescription>

        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
          {/* 左栏：公告条目导航 */}
          <div className="flex min-h-0 flex-col border-r bg-muted/30">
            <div className="flex items-center gap-2 px-4 pb-2 pt-4">
              <BellRing className="size-4 text-primary" />
              <span className="text-base font-semibold">系统公告</span>
            </div>
            <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
              <div className="space-y-1">
                {sorted.map((item) => (
                  <BulletinListItem
                    key={item.id}
                    item={item}
                    active={item.id === selectedId}
                    unread={item.id !== lastReadId}
                    onSelect={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
              <ScrollBar orientation="vertical" />
            </ScrollArea>
          </div>

          {/* 右栏：选中公告详情 */}
          <div className="flex min-h-0 flex-col">
            {selected ? (
              <>
                <div className="border-b px-6 pb-4 pt-5">
                  <h2 className="text-xl font-bold leading-snug tracking-tight">{selected.title}</h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className={cn('h-auto px-1.5 py-0 text-[10px] font-medium', (CATEGORY_META[selected.category] ?? CATEGORY_META.tip).className)}>
                      {(CATEGORY_META[selected.category] ?? CATEGORY_META.tip).label}
                    </Badge>
                    <span>{selected.date}</span>
                    {selected.tag && (
                      <Badge variant="secondary" className="h-auto px-1.5 py-0 text-[10px] font-medium">
                        {selected.tag}
                      </Badge>
                    )}
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="px-6 py-4">
                    <MessageResponse enableBlockCopy={false}>{selected.content}</MessageResponse>
                  </div>
                  <ScrollBar orientation="vertical" />
                </ScrollArea>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                <BellRing className="size-8 opacity-40" />
                <p className="text-sm">暂无公告</p>
              </div>
            )}
          </div>
        </div>

        {/* 底栏：状态提示 + 一键关闭 */}
        <div className="flex items-center justify-between border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            共 {items.length} 条公告 · 本地数据，无网络请求
          </span>
          <Button onClick={handleClose}>我知道了</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
