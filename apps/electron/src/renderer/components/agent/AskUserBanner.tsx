/**
 * AskUserBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 支持单选 / 多选 / 填空（简答）三类题型：
 * - 选择题以胶囊 Chips 呈现，单选一键选中并自动翻页，多选组合勾选后确认；
 * - 填空题直接展示输入区，Enter 提交、Shift+Enter 换行；
 * - 可折叠为悬浮胶囊，学生先查阅资料后再展开作答，折叠不会取消 Agent 等待。
 * 多问题用顶部 Tab 切换。键盘：方向键仅移动焦点，空格切换选中，数字键 1..9 直选，
 * Enter 确认当前问题（单选会先确认聚焦项，最后一题提交，否则翻页）。
 * 全局监听仅在横幅内或页面无控件焦点时生效，外部输入框与可交互控件一律放行。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, ChevronDown, ChevronUp, Send, Sparkles, X } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@profer/ui/primitives/button'
import {
  allPendingAskUserRequestsAtom,
  askUserAnswersAtom,
  askUserCollapsedAtom,
  type AskUserQuestionAnswer,
} from '@/atoms/agent-atoms'
import { isEditableTarget } from '@/lib/navigation-controller'
import { resolveBannerKeyScope, shouldHandleBannerKey } from '@/lib/banner-key-scope'
import type { AskUserQuestion, AskUserQuestionOption, AskUserQuestionType } from '@profer/shared'

const EMPTY_ANSWER: AskUserQuestionAnswer = { selected: [], customText: '', showCustom: false }

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

function safeUrlTransform(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return defaultUrlTransform(url)
}

/** 解析题型：显式 type 优先；选择题缺 options 时降级为填空，避免出现只剩「其他...」的畸形题。 */
function resolveQuestionType(q: AskUserQuestion): AskUserQuestionType {
  const opts = q.options ?? []
  if (q.type === 'fill-blank') return 'fill-blank'
  if (opts.length === 0) return 'fill-blank'
  if (q.type === 'multiple' || q.multiSelect) return 'multiple'
  return 'single'
}

/** 选择题的选项列表；填空题恒为空。 */
function questionOptions(q: AskUserQuestion): AskUserQuestionOption[] {
  return resolveQuestionType(q) === 'fill-blank' ? [] : (q.options ?? [])
}

function questionTypeLabel(type: AskUserQuestionType): string {
  if (type === 'multiple') return '多选'
  if (type === 'fill-blank') return '简答'
  return '单选'
}

/** 选项条目总数：选项 + 「其他...」 */
export function askUserItemCount(optionCount: number): number {
  return optionCount + 1
}

/** Tab 索引安全钳制；问题数为 0 时返回 0，避免越界读到 undefined。 */
export function clampTabIndex(index: number, totalTabs: number): number {
  if (totalTabs <= 0) return 0
  return Math.min(Math.max(index, 0), totalTabs - 1)
}

/** 方向键环形移动焦点，不改变任何答案。 */
export function moveAskUserFocus(current: number, itemCount: number, key: string): number {
  if (itemCount <= 0) return -1
  const forward = key === 'ArrowDown' || key === 'ArrowRight'
  if (current < 0) return forward ? 0 : itemCount - 1
  return forward ? (current + 1) % itemCount : (current - 1 + itemCount) % itemCount
}

/** 数字键 1..9 映射到选项条目索引；越界返回 null。 */
export function digitKeyToItemIndex(key: string, itemCount: number): number | null {
  if (key.length !== 1 || key < '1' || key > '9') return null
  const index = Number(key) - 1
  return index < itemCount ? index : null
}

/** 新题目的初始焦点：有选项则聚焦首项，填空题不聚焦。 */
export function initialFocusIndex(question: AskUserQuestion | undefined): number {
  return question != null && questionOptions(question).length > 0 ? 0 : -1
}

/** 选择题 Enter 语义：确认聚焦项 / 展开「其他」/ 直接前进 */
export type ChoiceEnterAction = 'select-focused' | 'open-custom' | 'advance'

export function resolveChoiceEnterAction(
  type: AskUserQuestionType,
  focusedIndex: number,
  optionCount: number,
): ChoiceEnterAction {
  if (type !== 'single') return 'advance'
  if (focusedIndex >= 0 && focusedIndex < optionCount) return 'select-focused'
  if (focusedIndex === optionCount) return 'open-custom'
  return 'advance'
}

/** 点击 / 空格 / 数字键选择选项：单选替换，多选切换（沿用原点击语义）。 */
export function setAnswerOption(
  prev: AskUserQuestionAnswer,
  label: string,
  isMultiple: boolean,
): AskUserQuestionAnswer {
  const selected = isMultiple
    ? (prev.selected.includes(label) ? prev.selected.filter((s) => s !== label) : [...prev.selected, label])
    : [label]
  return { selected, customText: '', showCustom: false }
}

/** 开关「其他...」：多选保留已勾选项，单选按单选语义清空已选。 */
export function setAnswerCustom(
  prev: AskUserQuestionAnswer,
  isMultiple: boolean,
  open: boolean,
): AskUserQuestionAnswer {
  if (open === prev.showCustom) return prev
  if (isMultiple) return { ...prev, showCustom: open }
  return { ...prev, showCustom: open, selected: open ? [] : prev.selected }
}

/** 单题答案是否有效（提交前置校验）。 */
export function isAnswerValid(question: AskUserQuestion, answer: AskUserQuestionAnswer): boolean {
  if (resolveQuestionType(question) === 'fill-blank') return answer.customText.trim().length > 0
  if (answer.selected.length > 0) return true
  return answer.showCustom && answer.customText.trim().length > 0
}

/**
 * 提交序列化：多选必须合并「已勾选项 + 其他文本」，避免选项被自定义文本吞掉。
 * 单选「其他」有内容时优先自定义文本；填空取纯文本。
 */
export function serializeQuestionAnswer(question: AskUserQuestion, answer: AskUserQuestionAnswer): string {
  const type = resolveQuestionType(question)
  const custom = answer.customText.trim()
  if (type === 'fill-blank') return custom
  if (type === 'multiple') {
    const parts = [...answer.selected]
    if (answer.showCustom && custom) parts.push(custom)
    return parts.join(', ')
  }
  if (answer.showCustom && custom) return custom
  return answer.selected.join(', ')
}

/** 提交时可携带的同帧答案覆盖：避免 React 异步 setState 尚未生效就读旧值。 */
interface SubmitOverride {
  index: number
  answer: AskUserQuestionAnswer
}

/** AskUserBanner 属性接口 */
interface AskUserBannerProps {
  sessionId: string
  onRequestStop: () => void
}

export function AskUserBanner({ sessionId, onRequestStop }: AskUserBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingAskUserRequestsAtom)
  const [answersByRequest, setAnswersByRequest] = useAtom(askUserAnswersAtom)
  const [collapsedRequestIds, setCollapsedRequestIds] = useAtom(askUserCollapsedAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [submitting, setSubmitting] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState(0)
  const [focusedOptIdx, setFocusedOptIdx] = React.useState(-1)

  const request = requests[0] ?? null
  const questions = request?.questions ?? []
  const requestId = request?.requestId ?? null
  // 渲染层统一安全索引：即使 activeTab 短暂越界也不会导致整卡消失
  const safeTab = clampTabIndex(activeTab, questions.length)
  const isLastTab = safeTab >= questions.length - 1
  const isCollapsed = requestId != null && collapsedRequestIds.has(requestId)

  // 当前请求的答案草稿：按 requestId 从 atom 读取（请求不存在则空）
  const answers = React.useMemo<Map<number, AskUserQuestionAnswer>>(
    () => (requestId ? (answersByRequest.get(requestId) ?? new Map()) : new Map()),
    [answersByRequest, requestId],
  )

  // 写入当前请求的答案草稿（支持函数式更新；无请求则不写）
  const setAnswers = React.useCallback(
    (update: Map<number, AskUserQuestionAnswer> | ((prev: Map<number, AskUserQuestionAnswer>) => Map<number, AskUserQuestionAnswer>)): void => {
      if (!requestId) return
      setAnswersByRequest((prev) => {
        const map = new Map(prev)
        const cur = map.get(requestId) ?? new Map<number, AskUserQuestionAnswer>()
        map.set(requestId, typeof update === 'function'
          ? (update as (p: Map<number, AskUserQuestionAnswer>) => Map<number, AskUserQuestionAnswer>)(cur)
          : update)
        return map
      })
    },
    [requestId, setAnswersByRequest],
  )

  /** 切换折叠状态：只收起卡片，不向主进程发送取消。 */
  const setCollapsed = React.useCallback((id: string, collapsed: boolean): void => {
    setCollapsedRequestIds((prev) => {
      if (collapsed === prev.has(id)) return prev
      const next = new Set(prev)
      if (collapsed) next.add(id)
      else next.delete(id)
      return next
    })
  }, [setCollapsedRequestIds])

  // ===== Refs：确保 keydown handler 始终读取最新值，消除闭包过期问题 =====
  const bannerRef = React.useRef<HTMLDivElement>(null)
  const activeTabRef = React.useRef(activeTab)
  activeTabRef.current = activeTab
  const questionsRef = React.useRef(questions)
  questionsRef.current = questions
  const focusedOptIdxRef = React.useRef(focusedOptIdx)
  focusedOptIdxRef.current = focusedOptIdx
  const answersRef = React.useRef(answers)
  answersRef.current = answers
  const submitRef = React.useRef<((override?: SubmitOverride) => void) | null>(null)
  const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  /** handler 内读取最新答案，禁止使用 effect 闭包里的 answers */
  function getAnswerNow(idx: number): AskUserQuestionAnswer {
    return answersRef.current.get(idx) ?? EMPTY_ANSWER
  }

  /** 写入某一题答案草稿（函数式更新，天然读取最新状态） */
  function updateAnswer(qIdx: number, updater: (prev: AskUserQuestionAnswer) => AskUserQuestionAnswer): void {
    setAnswers((prev) => {
      const map = new Map(prev)
      map.set(qIdx, updater(map.get(qIdx) ?? EMPTY_ANSWER))
      return map
    })
  }

  const clearAutoAdvanceTimer = React.useCallback((): void => {
    if (autoAdvanceTimerRef.current != null) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }, [])

  // 组件卸载时清理未触发的跳转定时器
  React.useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer])

  /** 单选点击/数字键后延迟切页；末尾钳制索引，防止手动切页后越界（BUG-3） */
  function scheduleAutoAdvance(fromTab: number): void {
    clearAutoAdvanceTimer()
    if (fromTab >= questionsRef.current.length - 1) return
    autoAdvanceTimerRef.current = setTimeout(() => {
      autoAdvanceTimerRef.current = null
      setActiveTab((prev) => clampTabIndex(prev + 1, questionsRef.current.length))
    }, 150)
  }

  // 请求变化时重置 Tab 与焦点；答案草稿由用户显式作答产生，不做任何静默预选。
  React.useEffect(() => {
    clearAutoAdvanceTimer()
    setActiveTab(0)
    setFocusedOptIdx(initialFocusIndex(questionsRef.current[0]))
  }, [request?.requestId, clearAutoAdvanceTimer])

  // 问题数量变化（如请求被替换）时钳制 Tab，避免读到 undefined 后整卡消失
  React.useEffect(() => {
    setActiveTab((prev) => clampTabIndex(prev, questions.length))
  }, [questions.length])

  // 切换 Tab 时焦点落到该题首项（仅聚焦，不选中）
  React.useEffect(() => {
    setFocusedOptIdx(initialFocusIndex(questionsRef.current[activeTab]))
  }, [activeTab])

  // 键盘导航：只在 requestId / 折叠态变化时重建 handler，内部通过 ref 读取最新值
  React.useEffect(() => {
    // 折叠态下不得接管键盘：否则学生在输入框按 Enter 会被误判为提交提问
    if (!request || questions.length === 0 || isCollapsed) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      // 作用域守卫：外部输入框 / 侧边栏按钮等一律放行，不 preventDefault
      if (!shouldHandleBannerKey(resolveBannerKeyScope(e, bannerRef.current))) return

      const qs = questionsRef.current
      const curTab = clampTabIndex(activeTabRef.current, qs.length)
      const q = qs[curTab]
      if (!q) return

      const qType = resolveQuestionType(q)
      const opts = questionOptions(q)
      const itemCount = askUserItemCount(opts.length)
      const lastTab = curTab >= qs.length - 1
      const isMultiple = qType === 'multiple'
      const curFocusIdx = focusedOptIdxRef.current

      // 自由文本与富文本编辑器内：仅 Enter 生效（输入法组合中跳过）。
      // ProseMirror/contenteditable 必须保留箭头键给原生光标移动。
      if (isEditableTarget(e.target)) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (lastTab) submitRef.current?.()
          else setActiveTab((prev) => clampTabIndex(prev + 1, questionsRef.current.length))
        }
        return
      }

      if (qType === 'fill-blank') return

      const selectOption = (index: number): void => {
        const opt = opts[index]
        if (!opt) return
        updateAnswer(curTab, (prev) => setAnswerOption(prev, opt.label, isMultiple))
      }

      /** 前进；末页携带同帧答案直接提交（不能依赖异步 setState 落盘） */
      const advance = (override?: SubmitOverride): void => {
        if (lastTab) submitRef.current?.(override)
        else setActiveTab((prev) => clampTabIndex(prev + 1, questionsRef.current.length))
      }

      // 方向键：仅移动焦点，严禁改动答案
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setFocusedOptIdx(moveAskUserFocus(curFocusIdx, itemCount, e.key))
        return
      }

      // 空格：切换聚焦项选中态 / 开关「其他」
      if (e.key === ' ') {
        e.preventDefault()
        if (curFocusIdx < 0) return
        if (curFocusIdx < opts.length) selectOption(curFocusIdx)
        else updateAnswer(curTab, (prev) => setAnswerCustom(prev, isMultiple, !prev.showCustom))
        return
      }

      // 数字键 1..9：直达选项；单选选完立即安排切页
      const digitIndex = digitKeyToItemIndex(e.key, itemCount)
      if (digitIndex != null) {
        e.preventDefault()
        setFocusedOptIdx(digitIndex)
        if (digitIndex < opts.length) {
          selectOption(digitIndex)
          if (!isMultiple) scheduleAutoAdvance(curTab)
        } else {
          updateAnswer(curTab, (prev) => setAnswerCustom(prev, isMultiple, true))
        }
        return
      }

      // Enter：单选先确认聚焦项，再前进/提交
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const action = resolveChoiceEnterAction(qType, curFocusIdx, opts.length)
        if (action === 'open-custom') {
          updateAnswer(curTab, (prev) => setAnswerCustom(prev, isMultiple, true))
          return
        }
        if (action === 'select-focused') {
          const opt = opts[curFocusIdx]
          if (opt) {
            // 用 answersRef 的当前值合成答案，并随提交同步传入
            const next = setAnswerOption(getAnswerNow(curTab), opt.label, false)
            updateAnswer(curTab, () => next)
            advance({ index: curTab, answer: next })
            return
          }
        }
        advance()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId, isCollapsed])

  /** 关闭问题，并经统一入口请求停止 Agent。 */
  const handleDismiss = (): void => {
    // 清理当前请求的答案草稿与折叠状态（随请求关闭失效）
    if (requestId) {
      setAnswersByRequest((prev) => {
        if (!prev.has(requestId)) return prev
        const map = new Map(prev)
        map.delete(requestId)
        return map
      })
      setCollapsed(requestId, false)
    }
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    onRequestStop()
  }

  if (!request) return null

  const getAnswer = (idx: number): AskUserQuestionAnswer => answers.get(idx) ?? EMPTY_ANSWER

  const hasValidAnswers = questions.some((q, idx) => isAnswerValid(q, getAnswer(idx)))

  const handleSubmit = async (override?: SubmitOverride): Promise<void> => {
    if (submitting) return
    // 非覆盖项统一走 answersRef，彻底绝缘渲染闭包
    const answerAt = (idx: number): AskUserQuestionAnswer =>
      override && override.index === idx ? override.answer : getAnswerNow(idx)
    // 回车与按钮共用同一入口：未作答时必须拒绝提交，避免向模型回传空 answers。
    // override 参与校验，防止「刚选中就被判定为空」而静默失败。
    if (!questions.some((q, idx) => isAnswerValid(q, answerAt(idx)))) return
    setSubmitting(true)
    try {
      const answersRecord: Record<string, string> = {}
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        if (!q) continue
        const text = serializeQuestionAnswer(q, answerAt(i))
        if (text) answersRecord[q.question || String(i)] = text
      }
      await window.electronAPI.respondAskUser({ requestId: request.requestId, answers: answersRecord })
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
      // 提交成功：清理该请求的答案草稿与折叠状态
      setAnswersByRequest((prev) => {
        if (!prev.has(request.requestId)) return prev
        const map = new Map(prev)
        map.delete(request.requestId)
        return map
      })
      setCollapsed(request.requestId, false)
    } catch (error) {
      console.error('[AskUserBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  submitRef.current = handleSubmit

  const currentQuestion = questions[safeTab]
  if (!currentQuestion) return null

  // ===== 折叠态：悬浮胶囊，不占用输入区，不终止 Agent =====
  if (isCollapsed && requestId) {
    return (
      <div className="shrink-0 px-4 pb-2">
        <button
          type="button"
          className="flex items-center gap-2 rounded-full bg-card px-3.5 py-2 text-xs text-foreground shadow-lg ring-1 ring-border/40 transition hover:shadow-xl"
          onClick={() => setCollapsed(requestId, false)}
          title="展开提问卡片"
        >
          <Sparkles className="size-3.5 text-primary" />
          <span>导师提出了 {questions.length} 个问题 · 点击作答</span>
          <ChevronUp className="size-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  const goNextTab = (): void => {
    clearAutoAdvanceTimer()
    setActiveTab((prev) => clampTabIndex(prev + 1, questions.length))
  }

  // 「其他...」在条目列表中的索引 = 选项数
  const currentOptionCount = questionOptions(currentQuestion).length

  return (
    <div ref={bannerRef} className="ask-user-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 头部 + Tab 栏 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">CDUT Studio Agent 需要你的输入</span>
          <div className="flex items-center gap-1.5">
            {requests.length > 1 && (
              <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
            )}
            <button
              type="button"
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground transition-colors"
              onClick={() => setCollapsed(request.requestId, true)}
              title="折叠为悬浮胶囊，稍后回答"
            >
              <ChevronDown className="size-3.5" />
              稍后回答
            </button>
            <button
              type="button"
              className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={handleDismiss}
              title="放弃并终止 Agent"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Tab 栏（多问题时显示） */}
        {questions.length > 1 && (
          <div className="flex gap-1">
            {questions.map((q, idx) => {
              const isActive = idx === safeTab
              const hasAnswer = getAnswer(idx).selected.length > 0
                || getAnswer(idx).customText.trim().length > 0
              return (
                <button
                  key={idx}
                  type="button"
                  className={`
                    px-2.5 py-1 rounded-lg text-xs font-medium transition-all outline-none
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : hasAnswer
                        ? 'ask-user-question-tab-answered bg-primary/15 text-primary'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }
                  `}
                  onClick={() => {
                    clearAutoAdvanceTimer()
                    setActiveTab(idx)
                  }}
                >
                  {`${idx + 1}-${questionTypeLabel(resolveQuestionType(q))}：${q.header || `问题 ${idx + 1}`}`}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 当前问题内容 */}
      <div className="px-4 pb-2">
        <QuestionCard
          question={currentQuestion}
          questionIndex={safeTab}
          answer={getAnswer(safeTab)}
          focusedIndex={focusedOptIdx}
          showBadge={questions.length === 1}
          onToggleOption={(label, index) => {
            setFocusedOptIdx(index)
            const isMultiple = resolveQuestionType(currentQuestion) === 'multiple'
            updateAnswer(safeTab, (prev) => setAnswerOption(prev, label, isMultiple))
            if (!isMultiple) scheduleAutoAdvance(safeTab)
          }}
          onToggleCustom={() => {
            setFocusedOptIdx(currentOptionCount)
            const isMultiple = resolveQuestionType(currentQuestion) === 'multiple'
            updateAnswer(safeTab, (prev) => setAnswerCustom(prev, isMultiple, !prev.showCustom))
          }}
          onCustomTextChange={(text) => updateAnswer(safeTab, (prev) => ({ ...prev, customText: text }))}
          onEnter={() => (isLastTab ? void handleSubmit() : goNextTab())}
          onForceSubmit={() => void handleSubmit()}
        />
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-end gap-1.5 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">
          {resolveQuestionType(currentQuestion) === 'fill-blank'
            ? 'Enter 提交 · Shift+Enter 换行'
            : `↑↓←→ 移动 · 空格选择 · Enter ${isLastTab ? '确认' : '下一个'}`}
        </span>
        {isLastTab ? (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={submitting || !hasValidAnswers}
            className="h-7 px-3 text-xs"
          >
            <Send className="size-3 mr-1" />
            确认
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={goNextTab}
            className="h-7 px-3 text-xs"
          >
            下一题
          </Button>
        )}
      </div>
    </div>
  )
}

/** 单个问题卡片（选择题胶囊 / 填空题输入区） */
function QuestionCard({
  question,
  questionIndex,
  answer,
  focusedIndex,
  showBadge,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onEnter,
  onForceSubmit,
}: {
  question: AskUserQuestion
  questionIndex: number
  answer: AskUserQuestionAnswer
  focusedIndex: number
  showBadge: boolean
  onToggleOption: (label: string, index: number) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onEnter: () => void
  onForceSubmit: () => void
}): React.ReactElement {
  const type = resolveQuestionType(question)
  const isFillBlank = type === 'fill-blank'
  const isMultiple = type === 'multiple'
  const options = questionOptions(question)
  const optionCount = options.length
  const previewOption = !isFillBlank && focusedIndex >= 0 && focusedIndex < optionCount
    ? options[focusedIndex]
    : !isFillBlank
      ? options.find((o) => answer.selected.includes(o.label))
      : undefined
  const previewContent = previewOption?.preview

  return (
    <div className="space-y-2">
      {/* 问题标签 + 文本（分行显示） */}
      <div className="space-y-1">
        {showBadge && (
          <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground shadow-sm">
            {`${questionIndex + 1}-${questionTypeLabel(type)}${question.header ? `：${question.header}` : ''}`}
          </span>
        )}
        <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none prose-p:my-0 prose-headings:my-0.5 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} urlTransform={safeUrlTransform}>
            {question.question}
          </Markdown>
        </div>
      </div>

      {isFillBlank ? (
        <textarea
          rows={2}
          className="w-full resize-none px-3 py-2 rounded-xl text-xs bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors"
          placeholder={question.placeholder ?? '输入你的答案…'}
          value={answer.customText}
          onChange={(e) => onCustomTextChange(e.target.value)}
          onKeyDown={(e) => {
            // 完全接管输入区键盘事件，避免与 document 全局监听重复提交/翻页
            e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            if (e.key !== 'Enter') return
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault()
              onForceSubmit()
              return
            }
            if (e.shiftKey) return
            e.preventDefault()
            onEnter()
          }}
          autoFocus
        />
      ) : (
        <>
          {/* 胶囊选项区 */}
          <div className="flex flex-wrap gap-1.5">
            {options.map((option, idx) => {
              const isSelected = answer.selected.includes(option.label)
              const isFocused = focusedIndex === idx
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`
                    flex items-start gap-2 rounded-full px-3 py-1.5 text-xs transition-all outline-none text-left shadow-sm
                    ${isSelected
                      ? 'ask-user-option-selected bg-primary text-primary-foreground shadow-md'
                      : 'bg-muted/50 text-foreground/80 hover:bg-muted'
                    }
                    ${isFocused ? 'ask-user-option-focused ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
                  `}
                  onClick={() => onToggleOption(option.label, idx)}
                >
                  {isMultiple ? (
                    <span
                      className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        isSelected ? 'border-primary-foreground/70 bg-primary-foreground/20' : 'border-muted-foreground/40'
                      }`}
                    >
                      {isSelected && <Check className="size-2.5" />}
                    </span>
                  ) : (
                    <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] ${isSelected ? 'bg-primary-foreground/20 text-primary-foreground/80' : 'bg-muted-foreground/10 text-muted-foreground/60'}`}>
                      {idx + 1}
                    </span>
                  )}
                  <span className="flex flex-col items-start">
                    <span className="font-medium leading-tight">{option.label}</span>
                    {option.description && (
                      <span className={`ask-user-option-description text-[11px] ${isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'} ${isFocused ? 'ask-user-option-description-focused' : ''}`}>
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}

            {/* "其他..." */}
            <button
              type="button"
              className={`
                flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition-all outline-none text-left shadow-sm
                ${answer.showCustom
                  ? 'bg-primary text-primary-foreground shadow-md'
                  : 'bg-muted/50 text-foreground/80 hover:bg-muted'
                }
                ${focusedIndex === optionCount ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
              `}
              onClick={onToggleCustom}
            >
              <span className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] ${answer.showCustom ? 'bg-primary-foreground/20 text-primary-foreground/80' : 'bg-muted-foreground/10 text-muted-foreground/60'}`}>
                {optionCount + 1}
              </span>
              <span className="font-medium">其他...</span>
            </button>
          </div>

          {/* 自由文本输入 */}
          {answer.showCustom && (
            <input
              type="text"
              className="w-full px-3 py-2 rounded-lg text-xs bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors"
              placeholder="输入自定义答案..."
              value={answer.customText}
              onChange={(e) => onCustomTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  e.stopPropagation() // 阻止冒泡到 document handler，避免重复触发 setActiveTab
                  onEnter()
                }
              }}
              autoFocus
            />
          )}
        </>
      )}

      {/* 选项 Preview（聚焦或选中时展示） */}
      {previewContent && (
        <div className="mt-2 rounded-lg bg-muted/40 p-3 text-xs prose prose-sm dark:prose-invert max-w-none prose-p:my-0 prose-headings:my-0.5 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} urlTransform={safeUrlTransform}>
            {previewContent}
          </Markdown>
        </div>
      )}
    </div>
  )
}
