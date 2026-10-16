/**
 * 认知子系统纯算法单元测试
 *
 * 覆盖：FSRS-7 记忆动力学调度（BDD-SRS-01）、FIM 潜伏能力追踪（BDD-QUIZ-01）、
 * 思维导图双曲布局 / 贝塞尔连线 / OPML 2.0 导出（BDD-MINDMAP-01）。
 */

import { describe, expect, test } from 'bun:test'
import type { FlashcardFsrs, MindMapData, MindMapNode } from '@profer/shared'
import {
  AGAIN_INTERVAL_MS,
  createInitialFsrs,
  retrievability,
  scheduleFsrs,
} from './fsrs-scheduler'
import { describeTheta, estimateTheta, fimInformation, fimProbability, updateTheta } from './fim-estimator'
import {
  buildBezierPath,
  buildNodeStudyPrompt,
  flattenMindMap,
  layoutMindMap,
  mindMapToOpml,
  parseMindMapText,
  stripMermaidNodeLabel,
} from '@profer/shared'
import { normalizeToMarkdown } from './markdown-normalizer'

const DAY = 86_400_000

describe('FSRS-7 记忆动力学（BDD-SRS-01）', () => {
  test('提取概率在 t = S 时恰为 0.9（幂律标定）', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 5)
    expect(retrievability(0, 10)).toBeCloseTo(1, 5)
    // 随时间单调衰减
    expect(retrievability(30, 10)).toBeLessThan(retrievability(10, 10))
  })

  test('新卡评 Again：进入学习态并安排在 10 分钟后重测', () => {
    const now = 1_700_000_000_000
    const next = scheduleFsrs(createInitialFsrs(), 'again', now)
    expect(next.nextReview).toBe(now + AGAIN_INTERVAL_MS)
    expect(next.reps).toBe(1)
    expect(next.lapses).toBe(0)
    expect(next.state).toBe('learning')
  })

  test('新卡评 Good：毕业进入复习态，下次间隔达天级', () => {
    const now = 1_700_000_000_000
    const next = scheduleFsrs(createInitialFsrs(), 'good', now)
    expect(next.state).toBe('review')
    expect(next.nextReview - now).toBeGreaterThanOrEqual(DAY)
  })

  test('复习卡四挡间隔单调：Again < Hard < Good < Easy', () => {
    const now = 1_700_000_000_000
    const base: FlashcardFsrs = {
      stability: 10,
      difficulty: 5,
      reps: 3,
      lapses: 0,
      lastReview: now - 5 * DAY,
      nextReview: now,
      state: 'review',
    }
    const again = scheduleFsrs(base, 'again', now)
    const hard = scheduleFsrs(base, 'hard', now)
    const good = scheduleFsrs(base, 'good', now)
    const easy = scheduleFsrs(base, 'easy', now)
    expect(again.nextReview).toBeLessThan(hard.nextReview)
    expect(hard.nextReview).toBeLessThan(good.nextReview)
    expect(good.nextReview).toBeLessThan(easy.nextReview)
  })

  test('复习卡评 Again 累加遗忘次数并转入重学态', () => {
    const now = 1_700_000_000_000
    const base: FlashcardFsrs = {
      stability: 10,
      difficulty: 5,
      reps: 3,
      lapses: 1,
      lastReview: now - 5 * DAY,
      nextReview: now,
      state: 'review',
    }
    const next = scheduleFsrs(base, 'again', now)
    expect(next.lapses).toBe(2)
    expect(next.state).toBe('relearning')
    // 脱落时稳定性不超过原值
    expect(next.stability).toBeLessThanOrEqual(base.stability)
  })

  test('难度高（Hard/Easy）时向初始难度均值回归，仍钳制在 [1,10]', () => {
    const now = 1_700_000_000_000
    const base: FlashcardFsrs = {
      stability: 10,
      difficulty: 10,
      reps: 5,
      lapses: 0,
      lastReview: now - 10 * DAY,
      nextReview: now,
      state: 'review',
    }
    const next = scheduleFsrs(base, 'easy', now)
    expect(next.difficulty).toBeGreaterThanOrEqual(1)
    expect(next.difficulty).toBeLessThanOrEqual(10)
  })
})

describe('FIM 潜伏认知能力追踪（BDD-QUIZ-01）', () => {
  test('作答正确概率随 θ 单调递增，Fisher 信息量为正', () => {
    const item = { discrimination: 1.2, difficulty: 0.2 }
    expect(fimProbability(-2, item)).toBeLessThan(fimProbability(0, item))
    expect(fimProbability(0, item)).toBeLessThan(fimProbability(2, item))
    expect(fimInformation(0, item)).toBeGreaterThan(0)
  })

  test('答对提升 θ、答错降低 θ，且恒被钳制在 [-3, 3]', () => {
    const item = { discrimination: 1.2, difficulty: 0.2 }
    expect(updateTheta(0, item, true)).toBeGreaterThan(0)
    expect(updateTheta(0, item, false)).toBeLessThan(0)
    let theta = 0
    for (let i = 0; i < 100; i++) theta = updateTheta(theta, item, true)
    expect(theta).toBeLessThanOrEqual(3)
    let low = 0
    for (let i = 0; i < 100; i++) low = updateTheta(low, item, false)
    expect(low).toBeGreaterThanOrEqual(-3)
  })

  test('整体估计与可读等级描述', () => {
    const item = { discrimination: 1.2, difficulty: 0.2 }
    const theta = estimateTheta([
      { item, correct: true },
      { item, correct: true },
      { item, correct: false },
    ])
    expect(theta).toBeGreaterThan(0)
    expect(describeTheta(2.5)).toContain('卓越')
    expect(describeTheta(-2.5)).toContain('亟需')
  })
})

describe('思维导图引擎（BDD-MINDMAP-01）', () => {
  const tree: MindMapNode = {
    id: 'root',
    label: '成都理工大学转专业政策',
    notes: '核心教务规则',
    children: [
      {
        id: 'a',
        label: '硬性限制条件',
        children: [
          { id: 'a1', label: '成绩排名' },
          { id: 'a2', label: '无违纪记录' },
        ],
      },
      { id: 'b', label: '平转与降转规则' },
    ],
  }

  test('双曲 Poincaré 布局覆盖全部节点，根节点居中', () => {
    const positions = layoutMindMap(tree, { centerX: 0, centerY: 0 })
    expect(positions.size).toBe(5)
    expect(positions.get('root')).toMatchObject({ x: 0, y: 0, depth: 0 })
    // 深层节点半径受 tanh 压缩，恒小于等于圆盘半径
    const diskRadius = 460
    for (const p of positions.values()) {
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(diskRadius + 1)
    }
  })

  test('前序遍历展开节点顺序正确', () => {
    const flat = flattenMindMap(tree).map((n) => n.id)
    expect(flat).toEqual(['root', 'a', 'a1', 'a2', 'b'])
  })

  test('贝塞尔连线为三次样条路径', () => {
    const path = buildBezierPath({ x: 0, y: 0, depth: 0, angle: 0 }, { x: 100, y: 40, depth: 1, angle: 0 })
    expect(path).toMatch(/^M 0\.00 0\.00 C [-\d.]+ [-\d.]+, [-\d.]+ [-\d.]+, 100\.00 40\.00$/)
  })

  test('OPML 2.0 导出包含嵌套 outline 与 XML 转义', () => {
    const mindmap: MindMapData = {
      id: 'mm-1',
      title: '成都理工大学 - 学习思维导图',
      sourceDocs: ['doc-1'],
      createdAt: Date.now(),
      root: { ...tree, label: '转专业 <政策> & 规则' },
    }
    const opml = mindMapToOpml(mindmap, new Date('2026-10-13T12:00:00Z'))
    expect(opml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(opml).toContain('<opml version="2.0">')
    expect(opml).toContain('转专业 &lt;政策&gt; &amp; 规则')
    expect(opml).toContain('text="硬性限制条件"')
    expect(opml).toContain('_note="核心教务规则"')
    expect(opml).toContain('Tue, 13 Oct 2026 12:00:00 GMT')
  })

  test('点击气泡生成的伴学 Prompt 含主题与自测要求', () => {
    const prompt = buildNodeStudyPrompt({ id: 'a', label: '硬性限制条件' }, '转专业政策')
    expect(prompt).toContain('"硬性限制条件"')
    expect(prompt).toContain('self-test questions')
  })
})

describe('对话流 ```mindmap 代码块解析（§7.2）', () => {
  test('解析 Mermaid mindmap 缩进语法并按层级构建节点树', () => {
    const code = [
      'mindmap',
      '  root((转专业政策))',
      '    硬性限制条件',
      '      成绩排名',
      '      无违纪记录',
      '    平转与降转规则',
    ].join('\n')
    const root = parseMindMapText(code)
    expect(root).not.toBeNull()
    expect(root!.label).toBe('转专业政策')
    expect(root!.children?.map((n) => n.label)).toEqual(['硬性限制条件', '平转与降转规则'])
    expect(root!.children?.[0]?.children?.map((n) => n.label)).toEqual(['成绩排名', '无违纪记录'])
  })

  test('解析 JSON 树容错形态（label/text/name 与 children/nodes）', () => {
    const json = JSON.stringify({
      title: '课程大纲',
      root: { label: '第一章', children: [{ text: '概念' }, { name: '方法', nodes: [{ label: '步骤一' }] }] },
    })
    const root = parseMindMapText(json)
    expect(root).not.toBeNull()
    expect(root!.label).toBe('第一章')
    expect(flattenMindMap(root!).map((n) => n.label)).toEqual(['第一章', '概念', '方法', '步骤一'])
  })

  test('剥离 Mermaid 形状包装与前置换行 id', () => {
    expect(stripMermaidNodeLabel('root((带圆角))')).toBe('带圆角')
    expect(stripMermaidNodeLabel('a1[方括号]')).toBe('方括号')
    expect(stripMermaidNodeLabel('{{菱形}}')).toBe('菱形')
    expect(stripMermaidNodeLabel('裸文本')).toBe('裸文本')
  })

  test('空输入 / 无有效行时返回 null（供调用方回退为普通代码块）', () => {
    expect(parseMindMapText('')).toBeNull()
    expect(parseMindMapText('   \n  \n')).toBeNull()
  })
})

describe('思维导图整齐布局与径向连线（连线交错修复）', () => {
  const tree: MindMapNode = {
    id: 'root',
    label: '根',
    children: [
      { id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1' }, { id: 'a2', label: 'A2' }] },
      { id: 'b', label: 'B', children: [{ id: 'b1', label: 'B1' }, { id: 'b2', label: 'B2' }, { id: 'b3', label: 'B3' }] },
      { id: 'c', label: 'C' },
    ],
  }

  test('按叶子占比切分扇区后所有节点坐标互不重合', () => {
    const pos = layoutMindMap(tree, { centerX: 500, centerY: 500, diskRadius: 420, baseRadius: 140 })
    const keys = new Set<string>()
    for (const point of pos.values()) keys.add(`${point.x},${point.y}`)
    expect(keys.size).toBe(pos.size)
  })

  test('同级子节点角度单调递增', () => {
    const pos = layoutMindMap(tree, { centerX: 0, centerY: 0 })
    const a = pos.get('a')!
    const b = pos.get('b')!
    const c = pos.get('c')!
    expect(a.angle).toBeLessThan(b.angle)
    expect(b.angle).toBeLessThan(c.angle)
  })

  test('提供圆心时径向弧线切向辐射（同角度父子连线为直线，杜绝 S 形回绕）', () => {
    const path = buildBezierPath(
      { x: 500, y: 400, depth: 1, angle: 0 },
      { x: 500, y: 300, depth: 2, angle: 0 },
      { x: 500, y: 500 },
    )
    // 父在上方、子更远且同角度 → 切向单位向量均沿极径向外，控制点 x 恒为 500，
    // 曲线退化为沿半径的直线（现代切向几何向量算法：u0/u1 各自沿极径放射）
    expect(path).toMatch(/^M 500\.00 400\.00 C 500\.00 [-\d.]+, 500\.00 [-\d.]+, 500\.00 300\.00$/)
  })

  test('未提供圆心时按相对几何向量自适应（避免固定水平切线）', () => {
    const path = buildBezierPath({ x: 0, y: 0, depth: 0, angle: 0 }, { x: 0, y: 100, depth: 1, angle: 0 })
    // 竖直连线水平分量为零 → S 曲线控制点退化到两端点，仍落在同一直线上不回绕
    expect(path).toBe('M 0.00 0.00 C 0.00 0.00, 0.00 100.00, 0.00 100.00')
  })
})

describe('标题识别正则精细化（防年份/数量词误升格）', () => {
  test('真编号标题被规范化为 Markdown 标题', () => {
    const input = '1.1 极限的定义\n\n1. 导数与微分\n\n第一章 绪论'
    const output = normalizeToMarkdown(input)
    expect(output).toContain('### 1.1 极限的定义')
    expect(output).toContain('## 1. 导数与微分')
    expect(output).toContain('## 第一章 绪论')
  })

  test('年份、数量词与普通陈述句绝不误升格为标题', () => {
    const input = '2023年招生简章\n\n3.5 万人参加考试\n\n这是一个关于 3.14 的完整陈述句。'
    const output = normalizeToMarkdown(input)
    expect(output).not.toContain('# 2023年')
    expect(output).not.toContain('# 3.5')
    expect(output).not.toContain('# 这是一个')
    expect(output).toContain('2023年招生简章')
    expect(output).toContain('3.5 万人参加考试')
    expect(output).toContain('这是一个关于 3.14 的完整陈述句。')
  })

  test('单空格单级编号标题被识别，但计量单位行不被误升格', () => {
    const input = '1 引言\n\n5 分钟完成本章练习'
    const output = normalizeToMarkdown(input)
    expect(output).toContain('## 1 引言')
    expect(output).not.toContain('# 5 分钟')
    expect(output).toContain('5 分钟完成本章练习')
  })
})
