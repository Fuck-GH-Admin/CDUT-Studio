/**
 * CSLab 实验室拼音首字母模糊搜索测试
 */

import { describe, expect, test } from 'bun:test'
import type { CsLabLab } from '../types/cslab'
import { getPinyinInitials, matchLabFuzzy } from './cslab-fuzzy-search'

function makeLab(overrides: Partial<CsLabLab> = {}): CsLabLab {
  return {
    id: 'lab-test',
    code: 'CSLAB-TEST',
    name: '测试实验室',
    description: '',
    tags: [],
    members: 1,
    status: '运行中',
    rootPath: '/tmp/lab-test',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('拼音首字母', () => {
  test('中文转首字母并保留 ASCII 字母数字', () => {
    expect(getPinyinInitials('演示实验室')).toBe('yssys')
    expect(getPinyinInitials('地球物理学院')).toBe('dqwlxy')
    expect(getPinyinInitials('CSLab-1')).toBe('cslab1')
  })
})

describe('实验室多字段模糊搜索', () => {
  test('拼音首字母命中名称', () => {
    const lab = makeLab({ name: '演示实验室' })
    expect(matchLabFuzzy(lab, 'ys').matched).toBe(true)
    expect(matchLabFuzzy(lab, 'yssys').matched).toBe(true)
  })

  test('院系名称首字母命中', () => {
    const lab = makeLab({ name: '地球物理学院' })
    expect(matchLabFuzzy(lab, 'dqwlxy').matched).toBe(true)
  })

  test('编号、标签与描述均可命中', () => {
    const lab = makeLab({
      code: 'CSLAB-BATTERY',
      tags: ['电化学', '界面'],
      description: '固态电池循环稳定性研究',
    })
    expect(matchLabFuzzy(lab, 'battery').matched).toBe(true)
    expect(matchLabFuzzy(lab, 'dhx').matched).toBe(true)
    expect(matchLabFuzzy(lab, 'gtdc').matched).toBe(true)
  })

  test('无关键返回未命中', () => {
    const lab = makeLab()
    expect(matchLabFuzzy(lab, 'zzzz').matched).toBe(false)
  })

  test('置顶项在同等命中时得分更高', () => {
    const normal = makeLab({ name: '能源材料实验室' })
    const pinned = makeLab({ name: '能源材料实验室', pinned: true })
    expect(matchLabFuzzy(pinned, 'nycl').score).toBeGreaterThan(
      matchLabFuzzy(normal, 'nycl').score,
    )
  })

  test('含空格的复合查询按 token AND 匹配', () => {
    const lab = makeLab({
      name: '固态电池界面实验室',
      tags: ['电化学', '界面'],
    })
    expect(matchLabFuzzy(lab, '固态 电池').matched).toBe(true)
    expect(matchLabFuzzy(lab, '界面 电化学').matched).toBe(true)
  })

  test('多 token 中任一未命中即整体未命中', () => {
    const lab = makeLab({ name: '固态电池界面实验室' })
    expect(matchLabFuzzy(lab, '固态 zzzz').matched).toBe(false)
  })

  test('tags 缺失时不抛异常', () => {
    const lab = makeLab({ name: '演示实验室' })
    const broken = { ...lab, tags: undefined as unknown as string[] }
    expect(() => matchLabFuzzy(broken, 'ys')).not.toThrow()
    expect(matchLabFuzzy(broken, 'ys').matched).toBe(true)
  })
})
