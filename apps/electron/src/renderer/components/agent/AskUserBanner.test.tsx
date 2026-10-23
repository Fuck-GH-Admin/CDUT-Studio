import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AskUserQuestion, AskUserRequest } from '@profer/shared'
import type { AskUserQuestionAnswer } from '../../atoms/agent-atoms'
import { allPendingAskUserRequestsAtom } from '../../atoms/agent-atoms'
import { shouldHandleBannerKey } from '../../lib/banner-key-scope'
import {
  AskUserBanner,
  askUserItemCount,
  clampTabIndex,
  digitKeyToItemIndex,
  initialFocusIndex,
  isAnswerValid,
  moveAskUserFocus,
  resolveChoiceEnterAction,
  serializeQuestionAnswer,
  setAnswerCustom,
  setAnswerOption,
} from './AskUserBanner'

const EMPTY: AskUserQuestionAnswer = { selected: [], customText: '', showCustom: false }

const OPTIONS = [
  { label: '方案 A', description: '描述 A' },
  { label: '方案 B' },
  { label: '方案 C' },
]

function singleQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return { question: '请选择方案', header: '方案', type: 'single', options: OPTIONS, ...overrides }
}

function multipleQuestion(): AskUserQuestion {
  return { question: '请选择多个方案', header: '多选', type: 'multiple', options: OPTIONS }
}

function fillBlankQuestion(): AskUserQuestion {
  return { question: '请补充说明', header: '简答', type: 'fill-blank', placeholder: '输入答案' }
}

function renderBanner(questions: AskUserQuestion[]): string {
  const store = createStore()
  const request: AskUserRequest = { requestId: 'req-1', sessionId: 's', questions, toolInput: {} }
  store.set(allPendingAskUserRequestsAtom, new Map([['s', [request]]]))
  return renderToStaticMarkup(
    <Provider store={store}>
      <AskUserBanner sessionId="s" onRequestStop={() => {}} />
    </Provider>,
  )
}

describe('全局键盘作用域（BUG-1）', () => {
  test('横幅内始终接管', () => {
    expect(shouldHandleBannerKey({ insideBanner: true, editable: true, interactiveControl: true })).toBe(true)
  })

  test('外部输入框放行，避免 Enter 被劫持提交', () => {
    expect(shouldHandleBannerKey({ insideBanner: false, editable: true, interactiveControl: true })).toBe(false)
  })

  test('外部会话条目等可交互控件放行', () => {
    expect(shouldHandleBannerKey({ insideBanner: false, editable: false, interactiveControl: true })).toBe(false)
  })

  test('聊天漫游容器（tabIndex=-1）与 body 继续接管', () => {
    expect(shouldHandleBannerKey({ insideBanner: false, editable: false, interactiveControl: false })).toBe(true)
  })
})

describe('焦点与选中解耦（BUG-2 / BUG-6）', () => {
  test('方向键环形移动焦点，无焦点时落到首尾', () => {
    expect(moveAskUserFocus(-1, 4, 'ArrowDown')).toBe(0)
    expect(moveAskUserFocus(-1, 4, 'ArrowUp')).toBe(3)
    expect(moveAskUserFocus(3, 4, 'ArrowRight')).toBe(0)
    expect(moveAskUserFocus(0, 4, 'ArrowLeft')).toBe(3)
    expect(moveAskUserFocus(0, 0, 'ArrowDown')).toBe(-1)
  })

  test('移动焦点不产生任何答案写入（纯函数只返回索引）', () => {
    const before: AskUserQuestionAnswer = { ...EMPTY, selected: ['方案 A'] }
    const nextIndex = moveAskUserFocus(0, askUserItemCount(OPTIONS.length), 'ArrowDown')
    expect(nextIndex).toBe(1)
    expect(before.selected).toEqual(['方案 A'])
  })

  test('多选展开「其他...」保留已勾选项', () => {
    const before: AskUserQuestionAnswer = { selected: ['方案 A', '方案 B'], customText: '', showCustom: false }
    const opened = setAnswerCustom(before, true, true)
    expect(opened.showCustom).toBe(true)
    expect(opened.selected).toEqual(['方案 A', '方案 B'])
    expect(setAnswerCustom(opened, true, false).selected).toEqual(['方案 A', '方案 B'])
  })

  test('单选展开「其他...」按单选语义清空已选项', () => {
    const before: AskUserQuestionAnswer = { selected: ['方案 A'], customText: '', showCustom: false }
    expect(setAnswerCustom(before, false, true).selected).toEqual([])
  })

  test('setAnswerOption 多选切换、单选替换', () => {
    expect(setAnswerOption(EMPTY, '方案 A', true).selected).toEqual(['方案 A'])
    expect(setAnswerOption({ ...EMPTY, selected: ['方案 A'] }, '方案 A', true).selected).toEqual([])
    const single = setAnswerOption({ ...EMPTY, selected: ['方案 A'] }, '方案 B', false)
    expect(single.selected).toEqual(['方案 B'])
    expect(single.showCustom).toBe(false)
  })

  test('数字键映射到条目索引并拒绝越界', () => {
    expect(digitKeyToItemIndex('1', 4)).toBe(0)
    expect(digitKeyToItemIndex('4', 4)).toBe(3)
    expect(digitKeyToItemIndex('5', 4)).toBeNull()
    expect(digitKeyToItemIndex('a', 4)).toBeNull()
    expect(digitKeyToItemIndex('0', 4)).toBeNull()
  })
})

describe('提交合并与前置校验（审计①②）', () => {
  test('多选必须合并已勾选项与「其他」文本', () => {
    const answer: AskUserQuestionAnswer = { selected: ['方案 A', '方案 B'], customText: ' 补充说明 ', showCustom: true }
    expect(serializeQuestionAnswer(multipleQuestion(), answer)).toBe('方案 A, 方案 B, 补充说明')
  })

  test('多选未展开「其他」时只回传勾选项', () => {
    const answer: AskUserQuestionAnswer = { selected: ['方案 A'], customText: '', showCustom: false }
    expect(serializeQuestionAnswer(multipleQuestion(), answer)).toBe('方案 A')
  })

  test('单选「其他」有内容时优先自定义文本，填空取纯文本', () => {
    expect(serializeQuestionAnswer(singleQuestion(), { selected: [], customText: ' 自定义 ', showCustom: true })).toBe('自定义')
    expect(serializeQuestionAnswer(fillBlankQuestion(), { selected: [], customText: ' 自由回答 ', showCustom: false })).toBe('自由回答')
  })

  test('未作答的题目判定为无效，避免回传空 answers', () => {
    expect(isAnswerValid(singleQuestion(), EMPTY)).toBe(false)
    expect(isAnswerValid(multipleQuestion(), { ...EMPTY, selected: ['方案 A'] })).toBe(true)
    expect(isAnswerValid(fillBlankQuestion(), { ...EMPTY, customText: '内容' })).toBe(true)
    expect(isAnswerValid(fillBlankQuestion(), EMPTY)).toBe(false)
  })
})

describe('Tab 边界与初始焦点（BUG-3 / BUG-5）', () => {
  test('clampTabIndex 永不越界', () => {
    expect(clampTabIndex(2, 2)).toBe(1)
    expect(clampTabIndex(-1, 2)).toBe(0)
    expect(clampTabIndex(5, 0)).toBe(0)
    expect(clampTabIndex(0, 3)).toBe(0)
  })

  test('单选题聚焦首项而非预选首项', () => {
    expect(initialFocusIndex(singleQuestion())).toBe(0)
    expect(initialFocusIndex(fillBlankQuestion())).toBe(-1)
    expect(initialFocusIndex(undefined)).toBe(-1)
  })

  test('Enter 语义：单选确认聚焦项 / 展开其他 / 多选直接前进', () => {
    expect(resolveChoiceEnterAction('single', 0, 3)).toBe('select-focused')
    expect(resolveChoiceEnterAction('single', 3, 3)).toBe('open-custom')
    expect(resolveChoiceEnterAction('single', -1, 3)).toBe('advance')
    expect(resolveChoiceEnterAction('multiple', 0, 3)).toBe('advance')
  })
})

describe('SSR 渲染（BUG-4 / BUG-5）', () => {
  test('单选题打开时没有任何预选项', () => {
    const html = renderBanner([singleQuestion()])
    expect(html).not.toContain('ask-user-option-selected')
    expect(html).toContain('确认')
    expect(html).not.toContain('下一题')
  })

  test('多问题非末页提供「下一题」纯鼠标通道', () => {
    const html = renderBanner([singleQuestion(), multipleQuestion()])
    expect(html).toContain('下一题')
    expect(html).not.toContain('>确认<')
  })

  test('多选题渲染「其他...」入口', () => {
    expect(renderBanner([multipleQuestion()])).toContain('其他...')
  })
})
