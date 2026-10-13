/**
 * YanhuBlockedPage —— 智联万站内置拦截卡片（双模自适应）
 *
 * 当主进程安全网关阻断非网页协议访问（如 `mailto:` / `javascript:` / `file:`）时，
 * 标签 url 被置为 `yanhu://blocked?target=...` 哨兵，
 * 本组件据此渲染规定文案与三按钮组（返回上一页 / 回到办事大厅 / 系统浏览器打开外链）。
 *
 * 视觉：校徽安全护盾矢量图标（红金辉光 + 现代立体阴影），深浅色自动切换微底色，夜间无刺眼光晕。
 */

import * as React from 'react'
import { ExternalLink, Home, ShieldAlert, Undo2 } from 'lucide-react'
import { YANHU_DEFAULT_HOME_URL } from '@profer/shared'

interface YanhuBlockedPageProps {
  /** 被拦截的原始外链目标 */
  targetUrl: string
  onBack: () => void
  onGoHome: () => void
  onOpenExternal: (url: string) => void
}

export function YanhuBlockedPage({
  targetUrl,
  onBack,
  onGoHome,
  onOpenExternal,
}: YanhuBlockedPageProps): React.ReactElement {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-content-area p-6">
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-border/60 bg-card/95 p-8 text-center shadow-xl shadow-black/5 backdrop-blur-sm dark:border-border/40 dark:bg-card/90">
        {/* 校徽安全护盾：红金辉光 + 立体阴影；夜间降低辉光强度避免刺眼 */}
        <div className="relative flex size-20 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-400/25 via-destructive/20 to-transparent blur-md dark:from-amber-400/15 dark:via-destructive/10" />
          <span className="relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-destructive text-white shadow-lg shadow-destructive/25">
            <ShieldAlert size={30} strokeWidth={2.1} />
          </span>
        </div>

        <h3 className="mt-6 text-sm font-semibold text-foreground">
          抱歉，该链接不是可访问的网页地址，无法在本浏览器内打开。
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          This link cannot be opened in the current browser.
        </p>

        {targetUrl ? (
          <p className="mt-4 line-clamp-2 break-all rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground/80">
            {targetUrl}
          </p>
        ) : null}

        <div className="mt-6 flex w-full flex-col gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Undo2 size={14} />
            <span>返回上一页</span>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onGoHome}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-background/70 text-[11px] font-medium text-foreground/85 transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Home size={13} />
              <span>回到办事大厅</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenExternal(targetUrl)}
              disabled={!targetUrl}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-background/70 text-[11px] font-medium text-foreground/85 transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ExternalLink size={13} />
              <span>系统浏览器打开</span>
            </button>
          </div>
        </div>

        <p className="mt-4 text-[10px] text-muted-foreground/60">
          可信入口：{YANHU_DEFAULT_HOME_URL}
        </p>
      </div>
    </div>
  )
}
