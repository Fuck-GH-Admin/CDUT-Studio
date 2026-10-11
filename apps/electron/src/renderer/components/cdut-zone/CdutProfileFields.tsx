/**
 * CdutProfileFields — CDUT 专区已登录态用户信息条（无边框微底色只读字段群）
 *
 * 彻底移除原有的大边框常驻气泡卡片，改为：
 * - 左侧真实头像（带绿色在线脉冲灯）；
 * - 右侧无边框只读微底色文本框：姓名、学工号（一键复制）、学院、专业、身份；
 * - 末尾保留极简的【退出特区账户】次级按钮。
 */

import * as React from 'react'
import { Check, Copy, LogOut, User } from 'lucide-react'
import type { CdutAccountProfile } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
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

/** 单个只读微底色字段框的通用样式 */
const FIELD_BOX_CLASS =
  'flex items-center gap-2 rounded-xl bg-muted/40 px-3.5 py-1.5 transition-colors hover:bg-muted/60'

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

  return (
    <section className="relative isolate flex flex-wrap items-center justify-between gap-4">
      {/* 信息字段区域底层微淡晕影 */}
      <span
        className="pointer-events-none absolute -inset-x-3 -inset-y-4 -z-10 rounded-3xl bg-gradient-to-r from-primary/5 via-transparent to-transparent blur-2xl"
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-center gap-4">
        {/* 真实头像 + 绿色在线脉冲灯（默认带隐私蒙版，单击切换） */}
        <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-primary/20 bg-primary/5 shadow-inner">
          {account.avatar ? (
            <CdutPrivatePhoto src={account.avatar} alt="用户头像" />
          ) : (
            <div className="flex size-full items-center justify-center text-primary/40">
              <User size={26} />
            </div>
          )}
          <span className="absolute bottom-0.5 right-0.5 size-3.5 animate-pulse rounded-full border-2 border-card bg-emerald-500" />
        </div>

        {/* 无边框微底色只读字段群 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className={FIELD_BOX_CLASS}>
            <span className="text-[11px] text-muted-foreground">姓名</span>
            <span className="text-xs font-semibold text-foreground">
              {account.studentName || '—'}
            </span>
          </div>

          <div className={FIELD_BOX_CLASS}>
            <span className="text-[11px] text-muted-foreground">学工号</span>
            <span className="font-mono text-xs font-semibold text-foreground">
              {account.studentId || '—'}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyStudentId}
                  disabled={!account.studentId}
                  aria-label="复制学工号"
                  className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-40"
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
          </div>

          <div className={FIELD_BOX_CLASS}>
            <span className="text-[11px] text-muted-foreground">学院</span>
            <span className="text-xs font-semibold text-foreground">
              {account.college || '—'}
            </span>
          </div>

          <div className={FIELD_BOX_CLASS}>
            <span className="text-[11px] text-muted-foreground">专业</span>
            <span className="text-xs font-semibold text-foreground">
              {account.major || '—'}
            </span>
          </div>

          <div className={FIELD_BOX_CLASS}>
            <span className="text-[11px] text-muted-foreground">身份</span>
            <span className="text-xs font-semibold text-foreground">
              {account.role || '—'}
            </span>
          </div>
        </div>
      </div>

      {/* 极简退出按钮 */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 px-3 text-xs"
        onClick={onLogout}
      >
        <LogOut size={13} />
        <span>退出特区账户</span>
      </Button>
    </section>
  )
}
