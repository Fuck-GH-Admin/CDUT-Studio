/**
 * 跨文档二分实体图单测：实体抽取与跨文档关系 Join。
 */
import { describe, expect, test } from 'bun:test'
import { buildEntityIndex, extractEntityMentions, findRelationalBridges } from './entity-graph'

describe('轻量跨文档二分实体图', () => {
  test('抽取学号 / 寝室号 / 班级名', () => {
    const mentions = extractEntityMentions('学号 202519110211，寝室 B3-315，班级 工程管理2025-02班')
    const kinds = new Set(mentions.map((mention) => mention.kind))
    expect(kinds.has('id')).toBe(true)
    expect(kinds.has('room')).toBe(true)
    expect(kinds.has('class')).toBe(true)
    expect(mentions.find((mention) => mention.kind === 'id')?.value).toBe('202519110211')
    expect(mentions.find((mention) => mention.kind === 'room')?.value).toBe('b3-315')
  })

  test('Given 两文档共享学号 When 以花名册切片为种子 Then 桥接到另一份文档', () => {
    // chunk0 = 花名册.xlsx（班级 + 学号）；chunk1/2 = 任职证明.docx（寝室长 + 学号 / 无关学生）
    const texts = [
      '| 202519110211 | 马晨超 | 工管2班 |',
      '寝室长 B3-315 202519110211',
      '普通记录 202519110299',
    ]
    const index = buildEntityIndex(texts)
    const docKeys = ['f1', 'f2', 'f2']

    const result = findRelationalBridges(index, [0], (chunkIndex) => docKeys[chunkIndex]!)
    expect(result.bridgeIndices).toContain(1)
    expect(result.sharedKeys).toContain('202519110211')
    // 不含共享学号的切片不应被桥接
    expect(result.bridgeIndices).not.toContain(2)
  })

  test('Given 同文档已有种子覆盖该键 When Join Then 不重复桥接同文档切片', () => {
    const texts = ['工管2班 202519110211', '同文档详情 202519110211', '其它文档 202519110211']
    const index = buildEntityIndex(texts)
    const docKeys = ['f1', 'f1', 'f2']
    const result = findRelationalBridges(index, [0], (chunkIndex) => docKeys[chunkIndex]!)
    expect(result.bridgeIndices).toEqual([2])
  })
})
