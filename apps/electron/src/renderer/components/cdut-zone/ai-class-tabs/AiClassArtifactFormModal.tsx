/**
 * AiClassArtifactFormModal — 学习工件生成参数配置弹窗
 *
 * 首页三大功能入口（脑图 / 抽认卡 / 测验）点击后唤起本弹窗，按类型呈现不同参数表单，
 * 用户确认后即提交生成请求（双轨联动）。
 */

import * as React from 'react'
import type { StudyGenerateArtifactInput } from '@profer/shared'
import { Button } from '@profer/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@profer/ui/primitives/dialog'
import { cn } from '@/lib/utils'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

interface AiClassArtifactFormModalProps {
  kind: 'mindmap' | 'flashcard' | 'quiz'
  onCancel: () => void
  onConfirm: (input: StudyGenerateArtifactInput) => void
}

const FIELD_CLASS =
  'h-8 w-full rounded-lg border border-border/60 bg-background/70 px-2 text-xs text-foreground outline-none transition-colors focus:border-primary/50'

const TITLE: Record<string, string> = { mindmap: '生成思维导图', flashcard: '生成抽认卡', quiz: '生成自测练习' }
const DESC: Record<string, string> = {
  mindmap: '双曲投影知识脑图，支持拖拽与 OPML 2.0 导出。',
  flashcard: '严格遵循最小信息原则（单问题-单答案），FSRS-7 记忆调度智能复习。',
  quiz: '注入一阶逻辑互斥约束，杜绝干扰项事实重叠；实时判错溯源与能力评估。',
}

export function AiClassArtifactFormModal({ kind, onCancel, onConfirm }: AiClassArtifactFormModalProps): React.ReactElement {
  useGlobalOverlay(true)
  const [focusedTopic, setFocusedTopic] = React.useState('')
  const [cardMode, setCardMode] = React.useState<'concise' | 'standard' | 'in_depth'>('standard')
  const [difficulty, setDifficulty] = React.useState<'easy' | 'medium' | 'hard'>('medium')
  const [questionCount, setQuestionCount] = React.useState(5)
  const [types, setTypes] = React.useState<Array<'single' | 'multiple' | 'boolean'>>(['single'])

  const toggleType = (type: 'single' | 'multiple' | 'boolean'): void => {
    setTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]))
  }

  const submit = (): void => {
    const base: StudyGenerateArtifactInput = {
      sessionId: '',
      kind,
      focusedTopic: focusedTopic.trim() || undefined,
    }
    if (kind === 'flashcard') {
      onConfirm({ ...base, cardMode, difficulty })
    } else if (kind === 'quiz') {
      onConfirm({ ...base, questionCount, difficulty, questionTypes: types.length > 0 ? types : ['single'] })
    } else {
      onConfirm(base)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="max-w-md gap-3 p-5">
        <DialogHeader>
          <DialogTitle className="text-sm">{TITLE[kind]}</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">{DESC[kind]}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-foreground">定向学习主题（选填）</span>
            <input
              className={FIELD_CLASS}
              value={focusedTopic}
              placeholder="选填：聚焦主题关键词（留空则覆盖全部资料）"
              onChange={(event) => setFocusedTopic(event.target.value)}
            />
          </label>

          {kind === 'flashcard' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-foreground">卡片数量模式</span>
              <select className={FIELD_CLASS} value={cardMode} onChange={(e) => setCardMode(e.target.value as typeof cardMode)}>
                <option value="concise">精简速记（5~8 张）</option>
                <option value="standard">标准巩固（10~15 张）</option>
                <option value="in_depth">深度研读（20+ 张）</option>
              </select>
            </label>
          )}

          {kind !== 'mindmap' && (
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-foreground">难度等级</span>
              <select className={FIELD_CLASS} value={difficulty} onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}>
                <option value="easy">基础认知（基本概念识记）</option>
                <option value="medium">理解应用（核心分类与规则应用）</option>
                <option value="hard">综合研判（多源对比分析）</option>
              </select>
            </label>
          )}

          {kind === 'quiz' && (
            <>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-foreground">题目数量</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className={FIELD_CLASS}
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
              </label>
              <div className="space-y-1">
                <span className="text-[11px] font-medium text-foreground">题型</span>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ['single', '单项选择'],
                      ['multiple', '多项选择'],
                      ['boolean', '是非判断'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleType(value)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        types.includes(value)
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border/60 text-muted-foreground hover:border-primary/40',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" onClick={submit}>
            开始生成
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
