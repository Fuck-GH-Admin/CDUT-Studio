/**
 * YanhuTabStrip —— 智联万站现代化多标签栏
 *
 * 能力：新建(+)、关闭(×)、鼠标拖拽排序、右键原生上下文菜单（关闭其他/关闭右侧/重新加载/复制链接）。
 * 视觉：Tailwind 语义化双模配色（卡片与阴影取代生硬边框，激活态 bg-primary/10 text-primary）。
 *
 * 说明：右键菜单改为由主进程 `Menu.popup` 弹出的系统原生菜单。原生菜单由操作系统绘制，
 * 恒悬浮于原生 WebContentsView 之上，因此无需再隐藏网页视图即可完整可见，从根本上
 * 消除了自绘菜单遮挡与「展开菜单时视口黑白闪烁」的问题。
 */

import * as React from 'react'
import { Globe, Loader2, Plus, X } from 'lucide-react'
import type { YanhuTabItem } from '@profer/shared'

interface YanhuTabStripProps {
  tabs: YanhuTabItem[]
  activeTabId: string
  loadingMap: Record<string, boolean>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCreate: () => void
  onReorder: (orderedTabIds: string[]) => void
  /** 弹出该标签的原生上下文菜单（由主进程 Menu.popup 承载） */
  onOpenMenu: (tabId: string) => void
}

export function YanhuTabStrip({
  tabs,
  activeTabId,
  loadingMap,
  onActivate,
  onClose,
  onCreate,
  onReorder,
  onOpenMenu,
}: YanhuTabStripProps): React.ReactElement {
  const dragIdRef = React.useRef<string | null>(null)

  const handleContextMenu = (event: React.MouseEvent, tabId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    onActivate(tabId)
    onOpenMenu(tabId)
  }

  const performReorder = (targetId: string): void => {
    const dragId = dragIdRef.current
    dragIdRef.current = null
    if (!dragId || dragId === targetId) return
    const ids = tabs.map((tab) => tab.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    const [moved] = ids.splice(from, 1)
    if (!moved) return
    ids.splice(to, 0, moved)
    onReorder(ids)
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-card/80 px-2 py-1 backdrop-blur-sm titlebar-no-drag">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isLoading = !!loadingMap[tab.id] || !!tab.loading
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={() => {
                dragIdRef.current = tab.id
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                performReorder(tab.id)
              }}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(event) => handleContextMenu(event, tab.id)}
              className={[
                'group flex min-w-[112px] max-w-[200px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              ].join(' ')}
              title={tab.title || tab.url}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {isLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : tab.favicon ? (
                  <img src={tab.favicon} alt="" className="size-4 rounded-sm object-contain" />
                ) : (
                  <Globe size={12} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.title || tab.url || '新标签页'}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.id)
                }}
                className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
                title="关闭标签"
                aria-label="关闭标签"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onCreate}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        title="新建标签"
        aria-label="新建标签"
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
