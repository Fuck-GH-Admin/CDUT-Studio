/**
 * CdutAiClassAccessDialog — 「AI速课堂」访问受限登录引导弹窗
 *
 * 未登录特区账户时，用户在主侧边栏点击被锁定的「AI速课堂」项目/会话即触发本弹窗。
 * 视觉与 GatekeeperNoticeModal 保持一致：校徽 + 说明 + 操作按钮 + 版权微标。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { LogIn, Clock } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { CdutLogo } from '@/components/shared/CdutLogo'
import { activeViewAtom } from '@/atoms/active-view'
import { cdutAiClassLockPromptAtom } from '@/atoms/cdut-account-atoms'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'
import { Z_LAYER } from '@profer/ui'

export function CdutAiClassAccessDialog(): React.ReactElement | null {
  const [open, setOpen] = useAtom(cdutAiClassLockPromptAtom)
  const setActiveView = useSetAtom(activeViewAtom)

  // 全局模态叠加登记：登录引导弹出时，智联万站原生视口必须让位
  useGlobalOverlay(open)

  if (!open) return null

  const goToCdutZone = (): void => {
    setActiveView('cdut-zone')
    setOpen(false)
  }

  return (
    <div className={`fixed inset-0 ${Z_LAYER.confirm} flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm`}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl">
        {/* 顶部校徽区 */}
        <div className="relative flex flex-col items-center gap-2 bg-gradient-to-b from-primary/10 via-card to-card px-6 pt-8 pb-5">
          <span
            className="pointer-events-none absolute left-1/2 top-2 size-40 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
            aria-hidden="true"
          />
          <CdutLogo className="relative h-16 w-auto drop-shadow-sm" />
          <div className="relative space-y-1 text-center">
            <h3 className="text-base font-semibold text-foreground">需要登录 CDUT 特区账户</h3>
            <p className="text-xs text-muted-foreground">「AI速课堂」仅对已登录的特区账户开放。</p>
          </div>
        </div>

        {/* 中部说明与操作按钮 */}
        <div className="space-y-4 px-6 pb-5">
          <div className="rounded-xl bg-muted/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
            为避免课堂学习内容外泄，未登录特区账户时无法查看或进入「AI速课堂」的任何课堂。
            请前往 CDUT 专区完成统一身份认证后使用；凭据仅经操作系统安全加密保存在本地，绝不上云。
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              className="h-9 flex-1 gap-1.5 text-xs"
            >
              <Clock size={14} />
              <span>稍后再说</span>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={goToCdutZone}
              className="h-9 flex-1 gap-1.5 text-xs font-semibold shadow-md"
            >
              <LogIn size={14} />
              <span>前往 CDUT 专区</span>
            </Button>
          </div>
        </div>

        {/* 底部版权声明微标 */}
        <div className="border-t border-border/60 bg-muted/30 px-6 py-2.5 text-center">
          <span className="text-[10px] tracking-wide text-muted-foreground/70">
            Powered by 雫窝中央实验室 · 2026
          </span>
        </div>
      </div>
    </div>
  )
}
