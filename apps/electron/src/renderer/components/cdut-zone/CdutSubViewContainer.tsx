/**
 * CdutSubViewContainer — CDUT 专区三大板块通用子页面容器
 *
 * 统一顶栏：最左侧微缩成都理工大学校徽、中间加粗居中板块标题、
 * 最右侧 Apple 风格矢量圆圈关闭按钮。主体区域填充剩余高度，供各板块业务内容自渲染。
 *
 * 说明：本容器不显示 70 周年庆祝横幅（横幅仅在专区首页展示）。
 */

import * as React from 'react'
import { detectIsWindows } from '@profer/ui'
import { CdutLogo } from '@/components/shared/CdutLogo'
import { resolveWindowControlsRightInset } from '@/lib/window-controls-layout'

interface CdutSubViewContainerProps {
  /** 板块标题（如「AI 速课堂」） */
  title: string
  /** 点击关闭按钮回调：退出子页面返回专区首页 */
  onClose: () => void
  /** 顶栏右侧操作区（位于关闭按钮左侧，如速课堂【切换课堂】入口） */
  actions?: React.ReactNode
  /** 顶栏左侧操作区（紧贴校徽右侧，如速课堂左栏收起/展开开关） */
  leftAction?: React.ReactNode
  children: React.ReactNode
}

export function CdutSubViewContainer({ title, onClose, actions, leftAction, children }: CdutSubViewContainerProps): React.ReactElement {
  // Windows 窗口按钮位于右上角，顶栏右端按钮簇（切换课堂 / 关闭）必须避免伸入其安全区
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 统一子页面顶栏 */}
      <header
        className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card/80 px-5 py-3 titlebar-no-drag backdrop-blur-sm"
        style={isWindows ? { paddingRight: resolveWindowControlsRightInset(isWindows) + 12 } : undefined}
      >
        {/* 最左侧：成都理工大学 Logo（保持清晰可辨的尺寸） */}
        <CdutLogo className="h-10 w-auto shrink-0" alt="成都理工大学" />
        {/* 校徽右侧操作插槽（保持 titlebar-no-drag 安全） */}
        {leftAction ? <div className="flex shrink-0 items-center">{leftAction}</div> : null}
        {/* 中间：板块名称，加粗居中 */}
        <div className="min-w-0 flex-1 text-center">
          <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        </div>
        {/* 右侧操作区 */}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        {/* 最右侧：Apple 风格矢量圆圈关闭按钮 */}
        <button
          type="button"
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-foreground/70 transition-all hover:bg-foreground/15 hover:text-foreground active:scale-95"
          title="关闭返回专区首页"
          aria-label="关闭返回专区首页"
        >
          <svg viewBox="0 0 24 24" className="size-4 stroke-[2.2] stroke-current fill-none">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      {/* 主体区域：填充剩余高度，由各板块自行滚动 */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
