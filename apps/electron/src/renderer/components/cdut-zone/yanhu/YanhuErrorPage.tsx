/**
 * YanhuErrorPage —— 智联万站网络故障自愈诊断卡片（双模自适应）
 *
 * 当主框架加载失败（did-fail-load，非用户主动取消）时，主进程把该标签置为错误态并广播，
 * 本组件据 activeTab.error 渲染错误码、失败 URL 与人性化排查指引，并提供
 * 「净化缓存并重试」与「在系统浏览器中打开」两种自愈操作。
 *
 * 视觉：云蓝信号中断矢量图标（渐变辉光 + 现代立体阴影），深浅色自动切换，夜间无刺眼光晕。
 */

import * as React from 'react'
import { ExternalLink, RefreshCw, WifiOff } from 'lucide-react'
import type { YanhuTabError } from '@profer/shared'

interface YanhuErrorPageProps {
  /** 主框架加载失败详情 */
  error: YanhuTabError
  /** 净化陈旧动态签名缓存后重试加载 */
  onRetry: () => void
  /** 在系统默认浏览器中打开失败地址 */
  onOpenExternal: (url: string) => void
}

export function YanhuErrorPage({
  error,
  onRetry,
  onOpenExternal,
}: YanhuErrorPageProps): React.ReactElement {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-content-area p-6">
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-border/60 bg-card/95 p-8 text-center shadow-xl shadow-black/5 backdrop-blur-sm dark:border-border/40 dark:bg-card/90">
        {/* 信号中断图标：云蓝辉光 + 立体阴影；夜间降低辉光强度避免刺眼 */}
        <div className="relative flex size-20 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-gradient-to-br from-sky-400/25 via-primary/20 to-transparent blur-md dark:from-sky-400/15 dark:via-primary/10" />
          <span className="relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-primary text-white shadow-lg shadow-primary/25">
            <WifiOff size={30} strokeWidth={2.1} />
          </span>
        </div>

        <h3 className="mt-6 text-sm font-semibold text-foreground">网页加载失败</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {error.errorDescription}（错误码 {error.errorCode}）
        </p>

        {error.failedUrl ? (
          <p className="mt-4 line-clamp-2 break-all rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground/80">
            {error.failedUrl}
          </p>
        ) : null}

        <div className="mt-4 w-full rounded-lg bg-muted/40 px-3 py-2 text-left text-[11px] leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground/80">请尝试排查：</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>确认已连接校园网，或已登录学校 VPN（校外访问需先接入内网）</li>
            <li>校内服务可能正在维护或临时故障，可稍后重试</li>
            <li>检查本地网络是否稳定，必要时切换网络环境</li>
          </ul>
        </div>

        <div className="mt-6 flex w-full flex-col gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <RefreshCw size={14} />
            <span>净化缓存并重试</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenExternal(error.failedUrl)}
            disabled={!error.failedUrl}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-background/70 text-[11px] font-medium text-foreground/85 transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ExternalLink size={13} />
            <span>在系统浏览器中打开</span>
          </button>
        </div>
      </div>
    </div>
  )
}
