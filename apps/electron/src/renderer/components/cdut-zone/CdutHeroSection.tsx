/**
 * CdutHeroSection — CDUT 专区正中央校标与三大 Bento 毛玻璃战略板块
 *
 * 居中展示成都理工大学校徽（CDUT-CE.png），下方以 Bento 空间毛玻璃黄金律
 * 横向展开三大全新战略板块：AI 速课堂、智联万站、材料审核。
 * 每张卡片赋予专属微光晕、光掠与 3D Hover 浮起微动效，深浅主题无缝自适应。
 */

import * as React from 'react'
import { BrainCircuit, ChevronRight, Compass, FileCheck2, type LucideIcon } from 'lucide-react'
import { CdutLogo } from '@/components/shared/CdutLogo'

interface CdutHeroSectionProps {
  /** 板块点击回调，预留给后续自动化流程或多智能体通道对接 */
  onSelect?: (id: string) => void
}

interface BentoModule {
  id: string
  icon: LucideIcon
  title: string
  tag: string
  desc: string
  /** Bento 卡片专属渐变基底（含 via/to 语义 token，兼容暗色模式） */
  surface: string
  /** 图标微胶囊配色 */
  accent: string
  /** 悬浮专属辉光 */
  glow: string
}

const BENTO_MODULES: BentoModule[] = [
  {
    id: 'ai-class',
    icon: BrainCircuit,
    title: 'AI 速课堂',
    tag: '知识图谱 · 靶向提分',
    desc: '输入考纲与课件，智能拆解思维导图，实时追踪掌握边界，靶向提分带教。',
    surface: 'from-indigo-500/10 via-card to-card',
    accent: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    glow: 'hover:shadow-indigo-500/20',
  },
  {
    id: 'yanhu-express',
    icon: Compass,
    title: '智联万站',
    tag: '自动代理 · 秒级速达',
    desc: '内置自动化浏览器，请假、课表、查分全流程自动化交互。',
    surface: 'from-emerald-500/10 via-card to-card',
    accent: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    glow: 'hover:shadow-emerald-500/20',
  },
  {
    id: 'material-review',
    icon: FileCheck2,
    title: '材料审核',
    tag: '三栏研判 · 偏差稽核',
    desc: '标准栏 × 待审栏 × AI 研判栏，毫秒级比对校级评优与报销材料偏差。',
    surface: 'from-amber-500/10 via-card to-card',
    accent: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    glow: 'hover:shadow-amber-500/20',
  },
]

export function CdutHeroSection({ onSelect }: CdutHeroSectionProps): React.ReactElement {
  return (
    <section className="my-auto flex flex-1 flex-col items-center justify-center gap-6 py-4 sm:gap-8 sm:py-6">
      {/* 居中校徽（含微淡晕影） */}
      <div className="flex flex-col items-center gap-3">
        {/* Logo 容器自适应高度，图片底部对齐容器底边 */}
        <div className="relative flex h-36 items-end justify-center sm:h-44">
          {/* 校徽底层微淡晕影 */}
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-indigo-400/10 via-primary/5 to-emerald-400/10 blur-3xl"
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 size-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl"
            aria-hidden="true"
          />
          <CdutLogo className="relative h-40 w-auto drop-shadow-sm sm:h-48" />
        </div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          成理智能体矩阵 · 赋能教科研与校园生活
        </p>
      </div>

      {/* Bento 三大战略板块 */}
      <div className="grid w-full max-w-5xl grid-cols-1 gap-5 md:grid-cols-3">
        {BENTO_MODULES.map((mod) => (
          <button
            key={mod.id}
            type="button"
            data-tour={`cdut-module-${mod.id}`}
            onClick={() => onSelect?.(mod.id)}
            className={`group relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-surface-border/60 bg-gradient-to-br ${mod.surface} p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:shadow-lg ${mod.glow}`}
          >
            <span
              className={`flex size-9 items-center justify-center rounded-xl ${mod.accent}`}
            >
              <mod.icon size={17} />
            </span>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">{mod.title}</h3>
              <span className="inline-block rounded-md bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {mod.tag}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{mod.desc}</p>
            <ChevronRight
              size={15}
              className="absolute bottom-4 right-4 text-muted-foreground/60 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-primary"
            />
          </button>
        ))}
      </div>
    </section>
  )
}
