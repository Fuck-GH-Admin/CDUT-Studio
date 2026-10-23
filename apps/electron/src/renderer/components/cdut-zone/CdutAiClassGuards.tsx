/**
 * CdutAiClassGuards — AI 速课堂访问管控展示组件
 *
 * 两个受控展示组件（不含业务状态，由父级决定渲染时机）：
 *   - CdutAiClassComposerLock：已登录但从主侧边栏进入课堂时的输入区锁定占位；
 *   - CdutAiClassContentGuard：未登录且已打开课堂会话时，替换对话内容防止泄露。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Lock, ShieldCheck } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { CdutLogo } from '@/components/shared/CdutLogo'
import { activeViewAtom } from '@/atoms/active-view'

/** 前往 CDUT 专区（返回该视图首页，供登录 / 重新进入速课堂） */
function useGoToCdutZone(): () => void {
  const setActiveView = useSetAtom(activeViewAtom)
  return React.useCallback(() => setActiveView('cdut-zone'), [setActiveView])
}

interface CdutAiClassComposerLockProps {
  /** 点击「前往 CDUT 专区」：直接进入当前课堂的 AI速课堂 界面 */
  onEnter: () => void
}

/**
 * 输入区锁定占位：视觉沿用现有输入卡片的圆角与底色，替换整个 composer（模型 / 附件 / 发送均不可用）。
 */
export function CdutAiClassComposerLock({ onEnter }: CdutAiClassComposerLockProps): React.ReactElement {
  return (
    <div className="agent-input-surface relative z-10 flex flex-col items-center justify-center gap-2 rounded-[17px] border-[0.5px] border-border bg-background/70 px-4 py-5 text-center backdrop-blur-sm select-none">
      <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Lock size={18} />
      </span>
      <h3 className="text-sm font-semibold tracking-tight text-foreground">AI速课堂 请在 CDUT 专区 内交互</h3>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        本节课堂属于 AI速课堂，为防止学习内容外泄，仅支持在 CDUT 专区 内继续提问与上传资料。
      </p>
      <Button type="button" size="sm" onClick={onEnter} className="mt-1 h-8 gap-1.5 px-4 text-xs font-semibold shadow-md">
        <ShieldCheck size={13} />
        <span>前往 CDUT 专区</span>
      </Button>
    </div>
  )
}

/**
 * 内容拦截占位：未登录特区账户且已打开课堂会话时，替换消息区，彻底阻断内容展示。
 */
export function CdutAiClassContentGuard(): React.ReactElement {
  const goToCdutZone = useGoToCdutZone()
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center select-none">
      <CdutLogo className="h-16 w-auto drop-shadow-sm" />
      <div className="flex items-center gap-1.5 text-primary">
        <Lock size={15} />
        <h3 className="text-base font-semibold tracking-tight text-foreground">需要登录特区账户查看本课堂</h3>
      </div>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        AI速课堂 的学习内容仅对已登录的 CDUT 特区账户开放。请前往 CDUT 专区 完成统一身份认证。
      </p>
      <Button type="button" size="sm" onClick={goToCdutZone} className="mt-1 h-8 gap-1.5 px-4 text-xs font-semibold shadow-md">
        <ShieldCheck size={13} />
        <span>前往 CDUT 专区</span>
      </Button>
    </div>
  )
}
