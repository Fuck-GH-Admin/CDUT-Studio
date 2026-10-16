/**
 * 测验题目与选项洗牌的回归测试
 *
 * 锁死两个顽固问题：
 *   1. 自测练习「答案全是 A」（模型位置偏置，需算法层重排纠偏）；
 *   2. 重做时题序与选项序不变（学生可靠位置记忆作答）。
 */

import { describe, expect, it } from 'bun:test'
import {
  answerPositionHistogram,
  createSeededRandom,
  shuffleQuiz,
  shuffleQuestionOptions,
  shuffleWith,
  type ShufflableOption,
} from '../src/main/lib/study/quiz-options'

const FOUR_OPTIONS: ShufflableOption[] = [
  { key: 'A', text: '选项甲' },
  { key: 'B', text: '选项乙' },
  { key: 'C', text: '选项丙' },
  { key: 'D', text: '选项丁' },
]

describe('shuffleWith（基础洗牌 BDD-QUIZ-OPT-01）', () => {
  it('Given 任意数组 When 洗牌 Then 元素集合完全不变（仅换序）', () => {
    const shuffled = shuffleWith(FOUR_OPTIONS, createSeededRandom('集合校验'))
    expect([...shuffled].sort((a, b) => a.key.localeCompare(b.key))).toEqual(FOUR_OPTIONS)
  })

  it('Given 注入同一种子 When 洗牌两次 Then 结果完全一致（可复现）', () => {
    const first = shuffleWith(FOUR_OPTIONS, createSeededRandom('同一道题干')).map((o) => o.key)
    const second = shuffleWith(FOUR_OPTIONS, createSeededRandom('同一道题干')).map((o) => o.key)
    expect(first).toEqual(second)
  })

  it('Given 空数组或单元素 When 洗牌 Then 不抛异常', () => {
    expect(shuffleWith([], createSeededRandom('x'))).toEqual([])
    expect(shuffleWith([1], createSeededRandom('x'))).toEqual([1])
  })
})

describe('shuffleQuestionOptions（选项重排与答案重映射 BDD-QUIZ-OPT-02）', () => {
  it('Given 模型把正确答案放在 A When 重排 Then 正确选项文本被保留且答案指向新的正确键', () => {
    const { options, answer } = shuffleQuestionOptions('题一', 'single', FOUR_OPTIONS, ['A'], createSeededRandom('题一'))
    expect(options.map((o) => o.text).sort()).toEqual(FOUR_OPTIONS.map((o) => o.text).sort())
    expect(answer.length).toBe(1)
    expect(options.find((o) => o.key === answer[0])?.text).toBe('选项甲')
  })

  it('Given 任意随机源 When 重排 Then 键序列恒为 A、B、C、D 连续编号', () => {
    for (let i = 0; i < 30; i++) {
      const { options } = shuffleQuestionOptions(`题干-${i}`, 'single', FOUR_OPTIONS, ['A'])
      expect(options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D'])
    }
  })

  it('Given 30 道答案本应全是 A 的题 When 真实随机重排 Then 位置均匀（A 占比不得超过一半且四位置全覆盖）', () => {
    const questions = Array.from({ length: 30 }, (_, i) =>
      shuffleQuestionOptions(`同一批题干-${i}`, 'single', FOUR_OPTIONS, ['A']),
    )
    const histogram = answerPositionHistogram(questions)
    expect(histogram.reduce((sum, n) => sum + n, 0)).toBe(30)
    // 关键回归：绝不允许再出现「全是 A」
    expect(histogram[0]).toBeLessThan(30 * 0.5)
    for (const count of histogram) expect(count).toBeGreaterThan(0)
  })

  it('Given 多选答案 When 重排 Then 全部正确键都被同步重映射且不重复', () => {
    const { options, answer } = shuffleQuestionOptions('多选题干', 'multiple', FOUR_OPTIONS, ['A', 'D'])
    expect(answer.length).toBe(2)
    expect(new Set(answer).size).toBe(2)
    expect(answer.map((key) => options.find((o) => o.key === key)?.text).sort()).toEqual(['选项丁', '选项甲'])
  })

  it('Given 是非题 When 重排 Then 保持约定顺序不参与洗牌（正确在前）', () => {
    const booleanOptions: ShufflableOption[] = [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' },
    ]
    const { options, answer } = shuffleQuestionOptions('是非题干', 'boolean', booleanOptions, ['A'])
    expect(options).toEqual(booleanOptions)
    expect(answer).toEqual(['A'])
  })

  it('Given 答案键与任何选项都不匹配（脏数据）When 重排 Then 原样返回，绝不把题目改坏', () => {
    const { options, answer } = shuffleQuestionOptions('脏数据题干', 'single', FOUR_OPTIONS, ['Z'])
    expect(options).toEqual(FOUR_OPTIONS)
    expect(answer).toEqual(['Z'])
  })

  it('Given 仅一个选项 When 重排 Then 直接原样返回', () => {
    const single: ShufflableOption[] = [{ key: 'A', text: '唯一选项' }]
    const { options, answer } = shuffleQuestionOptions('单选项题干', 'single', single, ['A'])
    expect(options).toEqual(single)
    expect(answer).toEqual(['A'])
  })
})

describe('shuffleQuiz（整卷洗牌：题序 + 选项序 BDD-QUIZ-OPT-03）', () => {
  const buildQuestions = (): Array<{ question: string; type: 'single'; options: ShufflableOption[]; answer: string[] }> =>
    Array.from({ length: 8 }, (_, i) => ({
      question: `第${i}题题干`,
      type: 'single' as const,
      options: FOUR_OPTIONS.map((o) => ({ ...o })),
      answer: ['A'],
    }))

  it('Given 整卷 When 洗牌 Then 题目数量不变且每题答案键都存在于选项中', () => {
    const shuffled = shuffleQuiz(buildQuestions())
    expect(shuffled.length).toBe(8)
    for (const question of shuffled) {
      expect(question.options.some((o) => o.key === question.answer[0])).toBe(true)
    }
  })

  it('Given 同一份卷 When 连续洗牌 20 次 Then 出现多于一种题目顺序（每次重做都不一样）', () => {
    const questions = buildQuestions()
    const orders = new Set<string>()
    for (let i = 0; i < 20; i++) {
      orders.add(shuffleQuiz(questions).map((q) => q.question).join('|'))
    }
    expect(orders.size).toBeGreaterThan(1)
  })

  it('Given 同一份卷 When 连续洗牌 20 次 Then 也出现多于一种选项顺序', () => {
    const questions = buildQuestions()
    const optionOrders = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const first = shuffleQuiz(questions)[0]!
      optionOrders.add(first.options.map((o) => o.text).join('|'))
    }
    expect(optionOrders.size).toBeGreaterThan(1)
  })

  it('Given 空卷 When 洗牌 Then 返回空数组', () => {
    expect(shuffleQuiz([])).toEqual([])
  })
})

describe('answerPositionHistogram（答案位置直方图 BDD-QUIZ-OPT-04）', () => {
  it('Given 空题目列表 When 统计 Then 返回全零四元组', () => {
    expect(answerPositionHistogram([])).toEqual([0, 0, 0, 0])
  })

  it('Given 答案键为空 When 统计 Then 该题被跳过不计数', () => {
    expect(answerPositionHistogram([{ options: FOUR_OPTIONS, answer: [] }])).toEqual([0, 0, 0, 0])
  })
})
