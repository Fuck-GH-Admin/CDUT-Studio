/**
 * AiClassCognitionModal — AI 速课堂「认知底座」双引擎配置弹窗
 *
 * 面向非技术背景的师生用户：隐藏晦涩学术名词，以学习场景化通俗标题呈现两组引擎，
 * 详尽说明适用场景、功能优势与潜在开销/风险，底部以灰色小字体如实标注底层技术。
 *   - 一、课堂知识检索引擎：精准查点模式 / 全书脉络与宏观演化模式；
 *   - 二、跨课联想终身记忆引擎：当堂专注模式 / 海马体跨课联想与贯通模式。
 *
 * 点击卡片即切换并经 Electron IPC 异步落盘，下一轮推理即刻生效，无需重启。
 * 状态全量走 Jotai（study-retrieval-atoms）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Brain, Check, Crosshair, Network, Target, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@profer/ui/primitives/dialog'
import { cn } from '@/lib/utils'
import {
  cognitionModalOpenAtom,
  memoryRetrievalEngineAtom,
  studyRetrievalEngineAtom,
} from '@/atoms/study-retrieval-atoms'
import type { MemoryEngineType, StudyEngineType } from '@/atoms/study-retrieval-atoms'

interface CognitionOption<T extends string> {
  value: T
  title: string
  badge: string
  tag: string
  scene: string
  advantage: string
  risk: string
  tech: string
  accent: string
  ring: string
  icon: React.ReactNode
}

/** 单张场景化大卡片：选中态微光边框 + 动态勾选标记 + 灰色技术标注 */
function CognitionOptionCard<T extends string>({
  option,
  selected,
  onSelect,
}: {
  option: CognitionOption<T>
  selected: boolean
  onSelect: (value: T) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.value)}
      className={cn(
        'flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-card px-4 py-3.5 text-left transition-all hover:shadow-md',
        selected ? `shadow-lg ring-2 ${option.ring}` : null,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted/50', option.accent)}>
          {option.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight text-foreground">{option.title}</p>
          <p className={cn('mt-0.5 text-[10px] font-medium tracking-wide', option.accent)}>{option.tag}</p>
        </div>
        {selected ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            <Check size={11} />
            已启用
          </span>
        ) : null}
      </div>

      <span className={cn('inline-flex w-fit rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium', option.accent)}>
        {option.badge}
      </span>

      <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground/80">适用场景：</span>
          {option.scene}
        </p>
        <p>
          <span className="font-medium text-foreground/80">功能优势：</span>
          {option.advantage}
        </p>
        <p className="text-rose-600/90 dark:text-rose-400/90">
          <span className="font-medium">潜在风险与开销：</span>
          {option.risk}
        </p>
      </div>

      <p className="border-t border-border/50 pt-2 text-[10px] leading-normal text-muted-foreground/60">{option.tech}</p>
    </button>
  )
}

export function AiClassCognitionModal(): React.ReactElement {
  const [open, setOpen] = useAtom(cognitionModalOpenAtom)
  const [studyEngine, setStudyEngine] = useAtom(studyRetrievalEngineAtom)
  const [memoryEngine, setMemoryEngine] = useAtom(memoryRetrievalEngineAtom)

  const studyOptions = React.useMemo<CognitionOption<StudyEngineType>[]>(
    () => [
      {
        value: 'classic',
        title: '精准查点模式',
        badge: '默认 · 极速定位考点',
        tag: '⚡ 即时考点定位 · 毫秒级直接响应',
        scene: '考前刷题、查找单条定理公式、定位习题原题、概念直查。',
        advantage: '聚焦当前段落原文，基于关键词与语义片段瞬间定位具体章节，精准确定，无发散干扰。',
        risk: '宏观概括弱：面对“总结全书演进逻辑”这类全局性问题时，容易只摘取局部零散段落，见树不见林。',
        tech: '底层技术：经典全文索引与向量混合切块检索 (Classic Hybrid RAG)',
        accent: 'text-sky-600 dark:text-sky-400',
        ring: 'ring-sky-500/40 border-sky-500/50',
        icon: <Target size={16} />,
      },
      {
        value: 'graphrag',
        title: '全书脉络与宏观演化模式',
        badge: '期末串讲 · 全局框架',
        tag: '🌐 分层社群大纲 · 期末系统串讲',
        scene: '期末大复习、全书核心理论演进答疑、跨章节概念横向对比、综合性大题破题。',
        advantage:
          '结合原子命题化与分层社群聚类，自动梳理顶层核心思想、中层大章脉络与底层细化考点，能站在全书全局高度回答系统性宏观大题。',
        risk: '内存与算力开销：纯内存构建多层级社区图谱额外占用约 10MB~30MB 运行内存；宏观多层遍历会导致首字生成耗时微增约 0.5~1.5 秒。',
        tech: '底层技术：Leiden 分层社群图谱检索 (Hierarchical GraphRAG)',
        accent: 'text-violet-600 dark:text-violet-400',
        ring: 'ring-violet-500/40 border-violet-500/50',
        icon: <Network size={16} />,
      },
    ],
    [],
  )

  const memoryOptions = React.useMemo<CognitionOption<MemoryEngineType>[]>(
    () => [
      {
        value: 'classic',
        title: '当堂专注模式',
        badge: '默认 · 线性时间线',
        tag: '🎯 当堂严格聚焦 · 零发散',
        scene: '只关注眼下这堂课的内容，不希望过去其他科目的陈旧记忆产生干扰。',
        advantage: '严格按时间线调取最近上下文，线性匹配，轻巧干净，完全不占用多余注意力。',
        risk: '跨课遗忘：无法建立隐式知识桥梁，遗忘较久之前学过的先修课程基础或错题记录。',
        tech: '底层技术：FTS5 BM25 词法时间线检索 (Classic Lexical Memory)',
        accent: 'text-emerald-600 dark:text-emerald-400',
        ring: 'ring-emerald-500/40 border-emerald-500/50',
        icon: <Crosshair size={16} />,
      },
      {
        value: 'hipporag',
        title: '海马体跨课联想与贯通模式',
        badge: '融会贯通 · 唤醒错题',
        tag: '🧠 突触多跳扩散 · 融会贯通',
        scene: '跨学科交叉学习、长期备战考试、遇到瓶颈时希望 Agent 主动提示相似错题与基础知识。',
        advantage:
          '模拟人脑海马体记忆联结机制，在概念共现网络中进行个性化 PageRank 扩散，能自发联想出“你之前在 XX 课程中推导过的类似原理”。',
        risk: 'Token 与内存消耗：纯内存概念图随历史累积占用 15MB~40MB 内存；联想召回的上下文较多，会使模型单次输入 Token 增加约 10%~25%。',
        tech: '底层技术：神经海马体多跳图谱扩散 (HippoRAG)',
        accent: 'text-amber-600 dark:text-amber-400',
        ring: 'ring-amber-500/40 border-amber-500/50',
        icon: <Brain size={16} />,
      },
    ],
    [],
  )

  const updateStudyEngine = async (next: StudyEngineType): Promise<void> => {
    if (next === studyEngine) return
    const previous = studyEngine
    setStudyEngine(next)
    try {
      const settings = await window.electronAPI.updateSettings({ studyRetrievalEngine: next })
      setStudyEngine(settings.studyRetrievalEngine === 'graphrag' ? 'graphrag' : 'classic')
      toast.success(next === 'graphrag' ? '已切换为「全书脉络与宏观演化模式」' : '已切换为「精准查点模式」')
    } catch (error) {
      setStudyEngine(previous)
      toast.error('认知底座设置保存失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const updateMemoryEngine = async (next: MemoryEngineType): Promise<void> => {
    if (next === memoryEngine) return
    const previous = memoryEngine
    setMemoryEngine(next)
    try {
      const settings = await window.electronAPI.updateSettings({ memoryRetrievalEngine: next })
      setMemoryEngine(settings.memoryRetrievalEngine === 'hipporag' ? 'hipporag' : 'classic')
      toast.success(next === 'hipporag' ? '已切换为「海马体跨课联想与贯通模式」' : '已切换为「当堂专注模式」')
    } catch (error) {
      setMemoryEngine(previous)
      toast.error('认知底座设置保存失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        className="grid max-h-[90vh] w-[min(880px,94vw)] max-w-none gap-0 overflow-y-auto rounded-3xl border-border/60 bg-card p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">认知底座设置</DialogTitle>

        {/* 标题区 */}
        <div className="relative flex flex-col gap-1 border-b border-border/50 px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Brain size={17} />
            </span>
            <h2 className="text-base font-semibold tracking-tight text-foreground">认知底座设置</h2>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            为你的速课堂挑选合适的“思考方式”。全部在本地运行，切换后下一轮提问即刻生效，无需重启。
          </p>
        </div>

        {/* 双引擎场景化大卡片 */}
        <div className="flex flex-col gap-5 px-6 py-5">
          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold text-foreground">一、课堂知识检索引擎</h3>
              <span className="text-[10px] text-muted-foreground">教材 · 课件 · 资料</span>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {studyOptions.map((option) => (
                <CognitionOptionCard
                  key={option.value}
                  option={option}
                  selected={studyEngine === option.value}
                  onSelect={(value) => {
                    void updateStudyEngine(value)
                  }}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold text-foreground">二、跨课联想终身记忆引擎</h3>
              <span className="text-[10px] text-muted-foreground">跨学期 · 跨学科历史会话</span>
            </div>
            <div className="grid gap-2.5 md:grid-cols-2">
              {memoryOptions.map((option) => (
                <CognitionOptionCard
                  key={option.value}
                  option={option}
                  selected={memoryEngine === option.value}
                  onSelect={(value) => {
                    void updateMemoryEngine(value)
                  }}
                />
              ))}
            </div>
          </section>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-6 py-4">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            完成
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
