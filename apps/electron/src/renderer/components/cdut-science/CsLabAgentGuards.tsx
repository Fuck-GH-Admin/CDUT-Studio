/**
 * CsLabAgentGuards — CDUT Science 实验室会话访问管控展示组件
 *
 * 受控展示组件（不含业务状态，由父级决定渲染时机）：
 *   - CsLabComposerLock：实验室绑定会话在科学助理窗口外（主界面）打开时的输入区锁定占位，
 *     引导用户前往 CDUT Science 主页面交互。
 */

import * as React from 'react'
import { Atom, Lock } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'

interface CsLabComposerLockProps {
  /** 点击「前往 CDUT Science」：直达该会话所属实验室的工作台 */
  onEnter: () => void
}

/**
 * 输入区锁定占位：视觉沿用现有输入卡片的圆角与底色，替换整个 composer（模型 / 附件 / 发送均不可用）。
 * 按钮图标使用 Atom，与 CDUT Science 在侧边栏导航中的统一品牌图标保持一致。
 */
export function CsLabComposerLock({ onEnter }: CsLabComposerLockProps): React.ReactElement {
  return (
    <div className="agent-input-surface relative z-10 flex flex-col items-center justify-center gap-2 rounded-[17px] border-[0.5px] border-border bg-background/70 px-4 py-5 text-center backdrop-blur-sm select-none">
      <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Lock size={18} />
      </span>
      <h3 className="text-sm font-semibold tracking-tight text-foreground">CDUT Science 请在科学工作台内交互</h3>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        本会话属于 CDUT Science 实验室，仅支持在科学工作台内继续提问与调用实验工具。
      </p>
      <Button type="button" size="sm" onClick={onEnter} className="mt-1 h-8 gap-1.5 px-4 text-xs font-semibold shadow-md">
        <Atom size={13} />
        <span>前往 CDUT Science</span>
      </Button>
    </div>
  )
}
