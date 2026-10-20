import * as React from 'react'
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderOpen,
  MessageSquare,
  Mic,
  Puzzle,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@profer/ui/primitives/button'
import { IntroFluidBackground } from './IntroFluidBackground'

interface FeatureSlide {
  title: string
  summary: string
  example: string
}

const TOUR_INTERVAL_MS = 4000
const TOUR_TRANSITION_MS = 600

const FEATURE_TOUR_SLIDES: FeatureSlide[] = [
  { title: 'Pi 全能 Agent', summary: '问问题，也能完成任务。', example: '分析 @销售.xlsx，给我一份报告' },
  { title: 'CDUT 校园特区', summary: '登录特区账户，直连校内事务。', example: '查我这周还剩哪些空教室' },
  { title: '智联万站与内置浏览器', summary: '让 Agent 自己上网办事。', example: '在内置浏览器访问知网、B 站和抖音，告诉我各自的特色' },
  { title: '材料审核专区', summary: '把规则和材料放在一起核对。', example: '对照评分细则检查申报材料，并定位问题出处' },
  { title: '规划与自动化', summary: '让任务自己发生。', example: '每周一整理项目进展并提醒我' },
  { title: '技能与工作区', summary: '沉淀重复工作，让文件成为上下文。', example: '创建一个写周报的 Skill' },
]

interface FeatureTourProps {
  onNext: () => void
  onSkip: () => void
  finishLabel: string
}

export function FeatureTour({ onNext, onSkip, finishLabel }: FeatureTourProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [pendingIndex, setPendingIndex] = React.useState<number | null>(null)
  const [phase, setPhase] = React.useState<'idle' | 'exiting' | 'entering'>('idle')
  const [direction, setDirection] = React.useState<1 | -1>(1)
  const isTransitioning = phase !== 'idle'
  const isLast = activeIndex === FEATURE_TOUR_SLIDES.length - 1

  const navigate = React.useCallback((nextIndex: number) => {
    if (isTransitioning || nextIndex === activeIndex) return
    setDirection(nextIndex > activeIndex ? 1 : -1)
    setPendingIndex(nextIndex)
    setPhase('exiting')
  }, [activeIndex, isTransitioning])

  const previous = React.useCallback(() => {
    navigate(Math.max(0, activeIndex - 1))
  }, [activeIndex, navigate])

  const next = React.useCallback(() => {
    if (isLast) {
      onNext()
      return
    }
    navigate(activeIndex + 1)
  }, [activeIndex, isLast, navigate, onNext])

  React.useEffect(() => {
    if (phase === 'exiting') {
      const timer = window.setTimeout(() => {
        setActiveIndex(pendingIndex!)
        setPhase('entering')
      }, TOUR_TRANSITION_MS)
      return () => window.clearTimeout(timer)
    }
    if (phase === 'entering') {
      const timer = window.setTimeout(() => {
        setPendingIndex(null)
        setPhase('idle')
      }, TOUR_TRANSITION_MS)
      return () => window.clearTimeout(timer)
    }
  }, [pendingIndex, phase])

  React.useEffect(() => {
    // 自动播放只到最后一页为止；最后一页停留，等用户主动点击完成，避免来不及看完就被跳走。
    if (phase !== 'idle' || isLast) return
    const timer = window.setTimeout(next, TOUR_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [activeIndex, isLast, next, phase])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        next()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onSkip()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [next, onSkip, previous])

  return (
    <section className="relative -m-8 flex h-screen w-screen overflow-hidden bg-black text-white" aria-label="CDUT Studio 功能导览">
      {/* 背景一次挂载、18 秒一轮循环流动；翻页不再重建/重播，全程保持波纹明显。 */}
      <IntroFluidBackground durationMs={18000} repeat />
      <div className="feature-tour-veil pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(0,0,0,.82)_0%,rgba(0,0,0,.52)_42%,rgba(0,0,0,.12)_100%)]" />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_64%_50%,transparent_4%,rgba(0,0,0,.26)_76%,rgba(0,0,0,.55)_100%)]" />

      <div className="relative z-10 flex w-full flex-col px-8 py-7 sm:px-14 sm:py-10">
        <header className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.3em] text-white/45">CDUT STUDIO / 00{activeIndex + 1}</span>
          <Button variant="ghost" size="icon" onClick={onSkip} className="text-white/55 hover:bg-white/10 hover:text-white" aria-label="跳过介绍">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <main className="flex flex-1 items-center">
          <div className="relative w-full max-w-xl sm:ml-[10vw]">
            <TourSlide
              key={`${activeIndex}-${phase}`}
              index={activeIndex}
              direction={direction}
              phase={phase === 'exiting' ? 'outgoing' : phase === 'entering' ? 'incoming' : 'idle'}
            />
          </div>
        </main>

        <footer className="flex items-center justify-between gap-4">
          <Button variant="ghost" onClick={previous} disabled={activeIndex === 0 || isTransitioning} className="text-white/65 hover:bg-white/10 hover:text-white disabled:text-white/20">
            <ChevronLeft className="mr-1 h-4 w-4" />
            上一步
          </Button>
          <div className="flex items-center gap-2" role="tablist" aria-label="功能导览进度">
            {FEATURE_TOUR_SLIDES.map((item, index) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                aria-label={`查看第 ${index + 1} 项：${item.title}`}
                aria-selected={index === activeIndex}
                onClick={() => navigate(index)}
                disabled={isTransitioning}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300 disabled:cursor-default',
                  index === activeIndex ? 'w-8 bg-white shadow-[0_0_12px_rgba(255,255,255,.7)]' : 'w-1.5 bg-white/30 hover:bg-white/55',
                )}
              />
            ))}
          </div>
          <Button onClick={next} disabled={isTransitioning} className="bg-white text-black hover:bg-white/85">
            {isLast ? finishLabel : '继续'}
            {isLast ? <Check className="ml-1 h-4 w-4" /> : <ChevronRight className="ml-1 h-4 w-4" />}
          </Button>
        </footer>
      </div>
    </section>
  )
}

function TourSlide({
  index,
  direction,
  phase,
}: {
  index: number
  direction: 1 | -1
  phase: 'idle' | 'incoming' | 'outgoing'
}): React.ReactElement {
  const slide = FEATURE_TOUR_SLIDES[index]!
  return (
    <div
      className={cn(
        'feature-tour-slide flex w-full flex-col items-start text-left',
        phase === 'incoming' ? 'feature-tour-slide-incoming' : phase === 'outgoing' ? 'feature-tour-slide-outgoing' : 'feature-tour-slide-idle',
        direction === 1 ? 'feature-tour-forward' : 'feature-tour-backward',
      )}
    >
      <p className="feature-tour-kicker font-mono text-[11px] tracking-[0.24em] text-white/45">WHAT CDUT STUDIO CAN DO</p>
      <h2 className="feature-tour-title mt-4 text-5xl font-semibold tracking-normal sm:text-7xl">{slide.title}</h2>
      <p className="feature-tour-summary mt-5 text-lg text-white/70 sm:text-xl">{slide.summary}</p>
      <div className="feature-tour-example mt-11 flex items-center gap-3 border-b border-white/30 pb-3 text-sm text-white/90 sm:text-base">
        <ArrowUpRight className="h-4 w-4 shrink-0 text-white/50" />
        <span>“{slide.example}”</span>
      </div>
    </div>
  )
}

export { FEATURE_TOUR_SLIDES }
