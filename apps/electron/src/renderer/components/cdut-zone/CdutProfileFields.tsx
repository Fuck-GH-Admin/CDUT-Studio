/**
 * CdutProfileFields — CDUT 专区已登录态「校园实名智能卡」
 *
 * 玻璃拟态（Glassmorphism）高级徽章设计：
 * - 深理工红金渐变流光 + 毛玻璃卡片质感（bg-card/75 backdrop-blur-md）；
 * - 顶部「成理统一身份认证 · 官方实名认证」认证印章条；
 * - 高清真实头像 + 翡翠绿在线呼吸信标；
 * - 加粗真实姓名 + 学工号一键复制胶囊；
 * - 学院 / 专业 / 身份三枚学术信息徽章；
 * - 精修「退出特区账户」按钮（图标 + 悬停色彩反馈）。
 */

import * as React from 'react'
import { BadgeCheck, Check, Copy, GraduationCap, LogOut, User } from 'lucide-react'
import type { CdutAccountProfile } from '@profer/shared'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@profer/ui/primitives/tooltip'
import { CdutPrivatePhoto } from './CdutPrivatePhoto'

interface CdutProfileFieldsProps {
  account: CdutAccountProfile
  onLogout: () => void
}

/** 学术信息徽章（学院 / 专业 / 身份）通用样式 */
const META_PILL_CLASS =
  'inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/50 bg-background/60 px-2.5 py-1 backdrop-blur-sm'

export function CdutProfileFields({
  account,
  onLogout,
}: CdutProfileFieldsProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopyStudentId = (): void => {
    if (!account.studentId) return
    void navigator.clipboard
      .writeText(account.studentId)
      .then(() => setCopied(true))
      .catch(() => {
        /* 剪贴板写入失败静默忽略，不阻断界面 */
      })
  }

  const metaPills = [
    { icon: <GraduationCap size={12} className="shrink-0 text-primary/70" />, label: '学院', value: account.college },
    { icon: <span className="size-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden="true" />, label: '专业', value: account.major },
    { icon: <BadgeCheck size={12} className="shrink-0 text-primary/70" />, label: '身份', value: account.role },
  ]

  return (
    <section className="relative isolate overflow-hidden rounded-2xl border border-primary/20 bg-card/75 shadow-lg shadow-primary/5 backdrop-blur-md">
      {/* 顶部深理工红金渐变流光饰带 */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-primary/70 via-amber-400/80 to-primary/70"
        aria-hidden="true"
      />
      {/* 右上角柔光晕影，强化卡片进深感 */}
      <div
        className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-primary/10 blur-3xl"
        aria-hidden="true"
      />

      {/* 认证印章条：官方实名认证声明 */}
      <div className="flex items-center gap-1.5 border-b border-primary/10 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-5 py-2">
        <BadgeCheck size={14} className="shrink-0 text-primary" />
        <span className="text-[11px] font-semibold tracking-wide text-primary">
          成理统一身份认证 · 官方实名认证
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
          保活心跳正常
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          {/* 高清真实头像 + 翡翠绿在线呼吸信标（默认带隐私蒙版，单击切换） */}
          <div className="relative size-16 shrink-0 overflow-hidden rounded-2xl border border-primary/25 bg-primary/5 shadow-inner ring-2 ring-background">
            {account.avatar ? (
              <CdutPrivatePhoto src={account.avatar} alt="用户头像" />
            ) : (
              <div className="flex size-full items-center justify-center text-primary/40">
                <User size={28} />
              </div>
            )}
            <span className="absolute bottom-0.5 right-0.5 flex size-4 items-center justify-center">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" aria-hidden="true" />
              <span className="relative inline-flex size-3.5 rounded-full border-2 border-card bg-emerald-500" aria-hidden="true" />
            </span>
          </div>

          {/* 姓名 + 学工号复制胶囊 + 学术信息徽章群 */}
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-lg font-bold tracking-tight text-foreground">
                {account.studentName || '未命名用户'}
              </span>
              {/* 学工号徽章 + 一键复制 */}
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                {account.studentId || '—'}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopyStudentId}
                      disabled={!account.studentId}
                      aria-label="复制学工号"
                      className="text-primary/70 transition-colors hover:text-primary disabled:opacity-40"
                    >
                      {copied ? (
                        <Check size={12} className="text-emerald-500" />
                      ) : (
                        <Copy size={12} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{copied ? '已复制' : '复制学工号'}</TooltipContent>
                </Tooltip>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {metaPills.map((pill) => (
                <span key={pill.label} className={META_PILL_CLASS} title={`${pill.label}：${pill.value || '—'}`}>
                  {pill.icon}
                  <span className="text-[10px] text-muted-foreground">{pill.label}</span>
                  <span className="max-w-[180px] truncate text-[11px] font-semibold text-foreground">
                    {pill.value || '—'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 精修退出按钮 */}
        <button
          type="button"
          onClick={onLogout}
          className="group inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-3.5 py-2 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive active:scale-95"
        >
          <LogOut size={13} className="transition-transform group-hover:-translate-x-0.5" />
          <span>退出特区账户</span>
        </button>
      </div>
    </section>
  )
}
