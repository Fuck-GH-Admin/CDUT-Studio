/**
 * CoachTourOverlay — 界面蒙层引导（Coach Tour）
 *
 * 触发：coachTourOpenAtom（顶栏「界面引导」测试按钮 / Onboarding 完成后自动接力 /
 * 启动时引导版本偏低的自动重播）。
 *
 * 引擎行为：
 *  - 播放期间 rAF 持续跟踪锚点 rect，侧栏收合、视图切换动画中聚光灯实时跟手
 *  - 带 view 的步骤先把主内容区切到对应视图，退出时恢复用户原视图
 *  - 点击遮罩 / → 前进，← 后退，Esc / 点击 × 退出；Tab 焦点限制在气泡内
 *  - 锚点缺失（对应面板未打开）时气泡居中降级，不阻断流程
 *  - 尊重 prefers-reduced-motion：关闭聚光灯/气泡位移动画
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue, useStore } from 'jotai'
import { Crosshair, X } from 'lucide-react'
import { toast } from 'sonner'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { activeViewAtom, type ActiveView } from '@/atoms/active-view'
import {
  agentSessionStreamingStateAtomFamily,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { cdutAccountAtom, cdutSubViewAtom } from '@/atoms/cdut-account-atoms'
import { cslabAuthAtom } from '@/atoms/cslab-atoms'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'
import { Button } from '@profer/ui/primitives/button'
import { Z_LAYER } from '@profer/ui'
import { cn } from '@/lib/utils'
import {
  COACH_TOUR_STEPS,
  CURRENT_COACH_TOUR_VERSION,
  type CoachTourStep,
} from './coach-tour-steps'
import { computeCardPosition, unionRects, type AnchorRect, type CardSize } from './coach-tour-position'
import { claimCoachTourOwnership } from './coach-tour-owner'
import { useCoachTourRunner } from './coach-tour-runner'
import { useCoachTourWait } from './coach-tour-wait'

/** 未测量前的气泡估算尺寸；首个 layout effect 会用真实值收敛，避免跳动 */
const FALLBACK_CARD_SIZE: CardSize = { width: 320, height: 190 }
const MOVE_TRANSITION = 'left 0.32s cubic-bezier(0.22,1,0.36,1), top 0.32s cubic-bezier(0.22,1,0.36,1), width 0.32s cubic-bezier(0.22,1,0.36,1), height 0.32s cubic-bezier(0.22,1,0.36,1)'

/** 收集某选择器下所有可见且非零尺寸的元素矩形 */
function collectVisibleRects(selector: string): AnchorRect[] {
  const rects: AnchorRect[] = []
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
      rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    }
  }
  return rects
}

/** 解析步骤锚点：unionSelectors 取多容器外接矩形，否则取第一个可见元素 */
function findStepRect(step: CoachTourStep): AnchorRect | null {
  if (step.unionSelectors && step.unionSelectors.length > 0) {
    return unionRects(step.unionSelectors.flatMap(collectVisibleRects))
  }
  for (const selector of step.selectors) {
    const [first] = collectVisibleRects(selector)
    if (first) return first
  }
  return null
}

/** 把 Tab/Shift+Tab 循环限制在气泡内部，焦点不逃逸到被遮罩的真实 UI */
function trapTabKey(event: KeyboardEvent, card: HTMLElement | null): void {
  if (!card) return
  const focusables = Array.from(
    card.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
  if (focusables.length === 0) {
    event.preventDefault()
    return
  }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || !card.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !card.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * 把聚光灯几何钳制进视口：锚点本身顶满窗口时（如规划/技能全屏页），
 * ±8px padding 会把白圈画到屏幕外导致框缺边；钳制后四边贴屏幕缘完整可见。
 * 遮罩阴影（9999px 巨影）不受钳制影响。
 */
function clampFrameToViewport(rect: AnchorRect): { left: number; top: number; width: number; height: number } {
  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(Math.max(rect.left - pad, 0), vw)
  const top = Math.min(Math.max(rect.top - pad, 0), vh)
  const right = Math.max(Math.min(rect.left + rect.width + pad, vw), left)
  const bottom = Math.max(Math.min(rect.top + rect.height + pad, vh), top)
  return { left, top, width: right - left, height: bottom - top }
}

export function CoachTourOverlay(): React.ReactElement | null {
  const store = useStore()
  const [open, setOpen] = useAtom(coachTourOpenAtom)
  const [stepIndex, setStepIndex] = React.useState(0)
  const [rect, setRect] = React.useState<AnchorRect | null>(null)
  const [pulseRects, setPulseRects] = React.useState<AnchorRect[]>([])
  const [cardSize, setCardSize] = React.useState<CardSize>(FALLBACK_CARD_SIZE)
  const cardRef = React.useRef<HTMLDivElement>(null)
  /** 打开引导时用户所在的主内容区视图，退出时恢复 */
  const restoreViewRef = React.useRef<ActiveView | null>(null)
  /** 交互步骤中已排定的自动前进定时器，防止连点锚点跳两步 */
  const advanceTimerRef = React.useRef<number | null>(null)

  const totalSteps = COACH_TOUR_STEPS.length
  const step = COACH_TOUR_STEPS[stepIndex]
  const isLast = stepIndex === totalSteps - 1
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const streamState = useAtomValue(
    agentSessionStreamingStateAtomFamily(sessionId ?? '__coach-tour-none__'),
  )
  const cdutAccount = useAtomValue(cdutAccountAtom)
  const cslabAuth = useAtomValue(cslabAuthAtom)
  // 引导蒙层高于一切 DOM，但原生 WebContentsView 会硬性遮挡：播放期间让内嵌网页瞬时让位。
  // 例外：智联万站步骤需让原生网页视图正常呈现，用户才能看到砚小龙驱动百度搜索与官网跳转的实时过程；
  // 离开该步骤时 cdutSubView 切走 → YanhuExpressView 卸载 → HIDE_VIEW 已兜底释放桌宠保活，无残留。
  const isYanhuStep = step?.cdutSubView === 'yanhu-express'
  useGlobalOverlay(open && !isYanhuStep)
  const runner = useCoachTourRunner(open, step)
  const wait = useCoachTourWait({
    enabled: open && runner.phase === 'ready' && step?.advanceOn === 'wait',
    stepKey: step?.key ?? '',
    waitFor: step?.waitFor,
    sessionId,
    running: streamState?.running ?? false,
    backgroundWaiting: streamState?.backgroundWaiting ?? false,
    contentLength: streamState?.content.length,
    startedAt: streamState?.startedAt,
    cdutActive: cdutAccount.status === 'active',
    cslabVerified: cslabAuth.isVerified,
  })
  const prepareReady = runner.phase === 'ready'
  /** 关闭时按当前步骤决定是否恢复进入前视图 */
  const stepRef = React.useRef<CoachTourStep | undefined>(step)
  stepRef.current = step
  /** 交互步骤：镂空放行真实点击，等用户点击锚点后自动前进；锚点缺失时降级为手动下一步 */
  const isClickToAdvance = step?.advanceOn === 'click-anchor'
  const interactive = isClickToAdvance && rect !== null && prepareReady
  /** 需要用户操作真实 UI 的步骤：不铺整屏点击捕获层 */
  const requiresInteraction = Boolean(
    step?.prepare || step?.waitFor || step?.passthrough || isClickToAdvance,
  )

  // 打开时：回到第一步 + 记住当前视图（退出恢复）
  React.useEffect(() => {
    if (!open) return
    setStepIndex(0)
    restoreViewRef.current = store.get(activeViewAtom)
  }, [open, store])

  // 关闭（完成 / Esc / 点击 ×）即视为看过：按步骤恢复原视图 + 写入当前引导版本
  const close = React.useCallback(() => {
    setOpen(false)
    // 关闭即归零：避免下次打开的首帧用旧步骤触发一次准备动作
    setStepIndex(0)
    if (stepRef.current?.restoreViewOnExit !== false && restoreViewRef.current) {
      store.set(activeViewAtom, restoreViewRef.current)
    }
    restoreViewRef.current = null
    window.electronAPI.updateSettings({ coachTourVersion: CURRENT_COACH_TOUR_VERSION }).catch((error) => {
      console.error('[CoachTour] 持久化引导版本失败:', error)
    })
  }, [setOpen, store])

  // 最后一步「完成」/遮罩点击/→ 走这里：收尾反馈 + 关团
  const finish = React.useCallback(() => {
    close()
    toast.success('引导完成，随时可从顶栏指南针按钮重播')
  }, [close])

  // 跨窗口单例：另一窗口正在播放时静默让位（并恢复视图/写版本，与正常退出同路径）；
  // 持有期间被后来的窗口抢走锁时同样让位。依赖 open，close 置 false 时 cleanup 释放锁。
  React.useEffect(() => {
    if (!open) return
    const claim = claimCoachTourOwnership(() => close())
    if (!claim) {
      toast.info('另一个窗口正在播放界面引导')
      close()
      return
    }
    return () => claim.release()
  }, [open, close])

  const next = React.useCallback(() => {
    if (isLast) {
      finish()
      return
    }
    setStepIndex((current) => current + 1)
  }, [finish, isLast])
  const previous = React.useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1))
  }, [])

  // 等待型步骤：业务状态完成后自动前进，留一小段沉降时间让用户看到结果
  React.useEffect(() => {
    if (!open || step?.advanceOn !== 'wait' || wait.status !== 'done') return
    const timer = window.setTimeout(next, 600)
    return () => window.clearTimeout(timer)
  }, [open, step, wait.status, next])

  // 轮播型步骤（数据表 / 分子晶体）：准备完成后停留固定时长再前进
  React.useEffect(() => {
    if (!open || !step?.autoAdvanceMs || step.advanceOn === 'wait') return
    if (runner.phase !== 'ready') return
    const timer = window.setTimeout(next, step.autoAdvanceMs)
    return () => window.clearTimeout(timer)
  }, [open, step, runner.phase, next])

  // 切步/退出时清掉未触发的交互前进定时器
  React.useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current)
        advanceTimerRef.current = null
      }
    }
  }, [stepIndex, open])

  // 交互步骤：capture 阶段侦测落在锚点镂空区的真实点击，稍作停顿让视图切换动画启动，再进下一步
  React.useEffect(() => {
    if (!open || !interactive || !rect) return
    const pad = 14 // 聚光灯 padding(8) + 点击容差
    const zone = {
      left: rect.left - pad,
      top: rect.top - pad,
      right: rect.left + rect.width + pad,
      bottom: rect.top + rect.height + pad,
    }
    const handleClick = (event: MouseEvent): void => {
      const inZone =
        event.clientX >= zone.left && event.clientX <= zone.right &&
        event.clientY >= zone.top && event.clientY <= zone.bottom
      if (!inZone || advanceTimerRef.current !== null) return
      advanceTimerRef.current = window.setTimeout(() => {
        advanceTimerRef.current = null
        next()
      }, step?.settleMs ?? 350)
    }
    window.addEventListener('click', handleClick, true)
    return () => window.removeEventListener('click', handleClick, true)
  }, [open, interactive, rect, next, step])

  // 桌宠步骤保活：离开该步或关闭引导时恢复常规显隐裁决
  React.useEffect(() => {
    if (!open || step?.key !== 'yanhu') return
    return () => {
      void window.electronAPI.yanhuExpress.petTourRelease().catch(() => undefined)
    }
  }, [open, step?.key])

  // 步骤声明了 view 时先切主内容区，聚光灯跟随新视图里的锚点
  React.useEffect(() => {
    if (!open || !step?.view) return
    if (store.get(activeViewAtom) !== step.view) {
      store.set(activeViewAtom, step.view)
    }
  }, [open, step, store])

  // 步骤声明了 cdutSubView 时切入对应子页面；null 表示退出子页面
  React.useEffect(() => {
    if (!open || !step || step.cdutSubView === undefined) return
    if (store.get(cdutSubViewAtom) !== step.cdutSubView) {
      store.set(cdutSubViewAtom, step.cdutSubView)
    }
  }, [open, step, store])

  // 播放期间 rAF 持续跟踪锚点：视图切换、侧栏收合、布局动画都会实时跟手；
  // rect 未变化时不 setState，不引入额外渲染。
  React.useEffect(() => {
    if (!open || !step) return
    let raf = 0
    let lastKey = ''
    const tick = (): void => {
      const found = findStepRect(step)
      const pulses = step.pulseSelectors?.flatMap(collectVisibleRects) ?? []
      const key = [
        found
          ? `${found.left.toFixed(1)}|${found.top.toFixed(1)}|${found.width.toFixed(1)}|${found.height.toFixed(1)}`
          : 'none',
        ...pulses.map(
          (item) =>
            `${item.left.toFixed(1)}|${item.top.toFixed(1)}|${item.width.toFixed(1)}|${item.height.toFixed(1)}`,
        ),
      ].join(';')
      if (key !== lastKey) {
        lastKey = key
        setRect(found)
        setPulseRects(pulses)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, step])

  // 测量气泡真实尺寸，供定位收敛
  React.useLayoutEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    const { offsetWidth, offsetHeight } = card
    if (offsetWidth > 0 && offsetHeight > 0 && (offsetWidth !== cardSize.width || offsetHeight !== cardSize.height)) {
      setCardSize({ width: offsetWidth, height: offsetHeight })
    }
  }, [open, stepIndex, rect, cardSize])

  // 步骤切换后把焦点放进气泡，保证键盘与读屏上下文连续
  React.useEffect(() => {
    if (!open) return
    cardRef.current?.focus()
  }, [open, stepIndex])

  // 键盘：Esc 退出，←/→ 翻步，Tab 困在气泡内（Enter/Space 留给聚焦按钮自身）
  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key === 'Tab') {
        trapTabKey(event, cardRef.current)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, close, next, previous])

  if (!open || !step) return null

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const cardPosition = computeCardPosition(rect, cardSize, step.placement, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  const transition = reduceMotion ? 'none' : MOVE_TRANSITION
  const frame = rect ? clampFrameToViewport(rect) : null

  return createPortal(
    <div className={`pointer-events-none fixed inset-0 ${Z_LAYER.overlay}`}>
      {/* 点击捕获：纯讲解步骤为整屏点击前进；需要用户操作真实 UI 的步骤完全不拦截 */}
      {!interactive && !requiresInteraction && (
        <div
          className={cn('pointer-events-auto absolute inset-0', !rect && 'bg-black/55')}
          onClick={next}
          aria-hidden="true"
        />
      )}
      {interactive && rect && (
        <CaptureAround rect={rect} />
      )}

      {/* 额外呼吸光圈：提示用户点击发送等关键动作，不参与气泡定位 */}
      {pulseRects.map((pulse, index) => {
        const pulseFrame = clampFrameToViewport(pulse)
        return (
          <div
            key={`pulse-${index}`}
            aria-hidden="true"
            className="coach-tour-pulse-ring pointer-events-none absolute rounded-lg"
            style={{
              left: pulseFrame.left,
              top: pulseFrame.top,
              width: pulseFrame.width,
              height: pulseFrame.height,
            }}
          />
        )
      })}

      {/* 聚光灯：box-shadow 巨影形成遮罩镂空；pointer-events-none 让点击穿透到捕获层。
          几何钳制进视口，否则顶满窗口的锚点会让白圈缺边 */}
      {frame && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            boxShadow:
              '0 0 0 2px rgba(255,255,255,0.85), 0 0 24px rgba(255,255,255,0.22), 0 0 0 9999px rgba(0,0,0,0.55)',
            transition,
          }}
        />
      )}

      {/* 交互步骤的呼吸脉冲环：提示「点这里」；reduced-motion 下由 CSS 关闭动画 */}
      {frame && interactive && (
        <div
          aria-hidden="true"
          className="coach-tour-pulse-ring pointer-events-none absolute rounded-xl"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            transition,
          }}
        />
      )}

      {/* 引导气泡 */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={`界面引导，第 ${stepIndex + 1} 步，共 ${totalSteps} 步`}
        tabIndex={-1}
        style={{ left: cardPosition.left, top: cardPosition.top, transition }}
        className={cn(
          'pointer-events-auto absolute w-[320px] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl outline-none',
          !reduceMotion && 'animate-in fade-in-0 zoom-in-95 duration-200',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {/* 内容区按步 key 重挂，切步时交叉淡入，避免文案瞬跳 */}
        <div
          key={step.key}
          className={cn(!reduceMotion && 'animate-in fade-in-0 slide-in-from-bottom-1 duration-200')}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] tracking-[0.24em] text-muted-foreground">
                {String(stepIndex + 1).padStart(2, '0')} / {String(totalSteps).padStart(2, '0')}
              </span>
              <h3 className="text-sm font-semibold">{step.title}</h3>
            </div>
            <button
              type="button"
              aria-label="退出引导"
              onClick={close}
              className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>

          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{step.body}</p>

          {interactive && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              点击高亮区域继续
            </p>
          )}

          {/* 准备 / 等待 / 异常状态：让用户知道引导正在做什么，而不是看起来卡死 */}
          {!interactive && runner.phase === 'preparing' && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" aria-hidden="true" />
              {runner.message}
            </p>
          )}
          {runner.phase === 'error' && (
            <p className="mt-2 text-[11px] leading-relaxed text-[#B4472F]">{runner.message}</p>
          )}
          {step.advanceOn === 'wait' && wait.status === 'waiting' && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" aria-hidden="true" />
              {wait.message}
            </p>
          )}
          {step.advanceOn === 'wait' && wait.status === 'timeout' && (
            <p className="mt-2 text-[11px] leading-relaxed text-[#B4472F]">{wait.message}</p>
          )}

          {/* 气泡专属快捷操作：仅在引导气泡内出现，绝不入侵真实业务界面 */}
          {step.action === 'demo-digitize' && (
            <Button
              type="button"
              size="sm"
              className="mt-3 h-8 w-full gap-1.5 text-xs font-semibold"
              disabled={!rect}
              onClick={() => window.dispatchEvent(new CustomEvent('cslab:demo-digitize'))}
            >
              <Crosshair size={13} />
              一键演示标定
            </Button>
          )}
        </div>

        <div className="mt-3.5 flex items-center justify-between">
          {/* 步骤指示点 */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {COACH_TOUR_STEPS.map((s, index) => (
              <span
                key={s.key}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-200',
                  index === stepIndex ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/25',
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {stepIndex > 0 && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={previous}>
                上一步
              </Button>
            )}
            {/* 交互步骤等用户亲自点击锚点，同时保留跳过入口；其余步骤始终可手动前进 */}
            {isClickToAdvance && interactive ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={next}>
                跳过本步
              </Button>
            ) : (
              <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={next}>
                {isLast ? '完成' : '下一步'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 交互步骤的镂空挡板：锚点四周四块惰性区域拦截误点，
 * 镂空区不放任何元素，真实 UI 的点击/悬停（含按钮 hover 态）原样生效。
 */
function CaptureAround({ rect }: { rect: AnchorRect }): React.ReactElement {
  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(0, rect.left - pad)
  const top = Math.max(0, rect.top - pad)
  const right = Math.min(vw, rect.left + rect.width + pad)
  const bottom = Math.min(vh, rect.top + rect.height + pad)
  const panels: Array<{ key: string; left: number; top: number; width: number; height: number }> = [
    { key: 'top', left: 0, top: 0, width: vw, height: top },
    { key: 'bottom', left: 0, top: bottom, width: vw, height: Math.max(0, vh - bottom) },
    { key: 'left', left: 0, top, width: left, height: Math.max(0, bottom - top) },
    { key: 'right', left: right, top, width: Math.max(0, vw - right), height: Math.max(0, bottom - top) },
  ]
  return (
    <>
      {panels
        .filter((panel) => panel.width > 0 && panel.height > 0)
        .map((panel) => (
          <div
            key={panel.key}
            aria-hidden="true"
            className="pointer-events-auto absolute"
            style={{ left: panel.left, top: panel.top, width: panel.width, height: panel.height }}
          />
        ))}
    </>
  )
}
