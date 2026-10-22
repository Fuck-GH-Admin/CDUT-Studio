/**
 * GatekeeperNoticeModal — CDUT 专区统一门禁引导弹窗
 *
 * 当大模型在未登录特区账户的状态下调用 CDUT 工具集（8+1）时，主进程会派发
 * `cdut-zone:gatekeeper-blocked` 事件；本组件以专属定制浮层呈现：
 *   - 顶部居中排版成都理工大学校徽；
 *   - 中部友好提示与两个操作按钮（【前往登录】/【稍后再说】）；
 *   - 底部版权声明微标 `Powered by 雫窝中央实验室 · 2026`。
 *
 * 决策回传：点击【前往登录】自动跳转 CDUT 专区并回传 navigate_login；
 * 点击【稍后再说】回传 decline，由大模型识别用户意图后自主安抚。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { LogIn, Clock } from 'lucide-react'
import type { CdutGatekeeperNoticeEvent } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { CdutLogo } from '@/components/shared/CdutLogo'
import { activeViewAtom } from '@/atoms/active-view'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'
import { Z_LAYER } from '@profer/ui'

export function GatekeeperNoticeModal(): React.ReactElement | null {
  const [notice, setNotice] = React.useState<CdutGatekeeperNoticeEvent | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const setActiveView = useSetAtom(activeViewAtom)

  // 全局模态叠加登记：门禁引导弹出时，智联万站原生视口必须让位
  useGlobalOverlay(!!notice)

  React.useEffect(() => {
    const unsub = window.electronAPI.cdutZone.onGatekeeperBlocked((event) => {
      setNotice(event)
      setSubmitting(false)
    })
    return () => unsub()
  }, [])

  const respond = async (action: 'navigate_login' | 'decline'): Promise<void> => {
    if (!notice) return
    setSubmitting(true)
    if (action === 'navigate_login') {
      // 先切换视图，保证主进程放行后用户已身处 CDUT 专区，可直接完成登录
      setActiveView('cdut-zone')
    }
    try {
      await window.electronAPI.cdutZone.gatekeeperRespond({ requestId: notice.requestId, action })
    } finally {
      setNotice(null)
      setSubmitting(false)
    }
  }

  if (!notice) return null

  return (
    <div className={`fixed inset-0 ${Z_LAYER.confirm} flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm`}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl">
        {/* 顶部校徽区：居中排版成都理工大学校徽 */}
        <div className="relative flex flex-col items-center gap-2 bg-gradient-to-b from-primary/10 via-card to-card px-6 pt-8 pb-5">
          <span
            className="pointer-events-none absolute left-1/2 top-2 size-40 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
            aria-hidden="true"
          />
          <CdutLogo className="relative h-16 w-auto drop-shadow-sm" />
          <div className="relative space-y-1 text-center">
            <h3 className="text-base font-semibold text-foreground">需要登录 CDUT 特区账户</h3>
            <p className="text-xs text-muted-foreground">
              AI 正在尝试调用「{notice.toolLabel}」，该能力仅对已登录的特区账户开放。
            </p>
          </div>
        </div>

        {/* 中部说明与操作按钮 */}
        <div className="space-y-4 px-6 pb-5">
          <div className="rounded-xl bg-muted/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
            前往 CDUT 专区完成统一身份认证后，即可使用课表、成绩、空教室、考务及反代大模型等专属能力。
            凭据仅经操作系统安全加密保存在本地，绝不上云。
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void respond('decline')}
              className="h-9 flex-1 gap-1.5 text-xs"
            >
              <Clock size={14} />
              <span>稍后再说</span>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={submitting}
              onClick={() => void respond('navigate_login')}
              className="h-9 flex-1 gap-1.5 text-xs font-semibold shadow-md"
            >
              <LogIn size={14} />
              <span>前往登录</span>
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
