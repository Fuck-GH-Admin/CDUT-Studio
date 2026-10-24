/**
 * SKLGP 演示内容纯构建器测试
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canvasToDagGraph, parseCanvasDocument, serializeCanvasDocument } from '@profer/shared'
import {
  SKLGP_CANVAS_TITLE,
  SKLGP_HYDROGRAPH_FILE,
  buildSkLgpCanvasDocument,
  buildSkLgpDemoPapers,
  buildSkLgpResearchNote,
  buildSkLgpThesisDocJson,
  renderDemoHydrographPng,
  resolveThesisCapsuleRows,
  type ThesisCapsuleSeed,
} from './cslab-demo-geohazard-content'

const DEMO_DIR = fileURLToPath(
  new URL('../../../../resources/cslab/demo-geohazard', import.meta.url),
)

const CAPSULES: ThesisCapsuleSeed[] = [
  {
    id: 'cap-demo-peak-discharge',
    label: '峰值流量（示例时程）',
    value: '112.43',
    unit: 'm³/s',
    tableUri: 'cslab://demo-lab/table/table-demo',
    column: 'y1',
    rowIndex: 20,
    revisionAtBind: 1,
  },
  {
    id: 'cap-demo-max-depth',
    label: '最大水深（示例时程）',
    value: '2.95',
    unit: 'm',
    tableUri: 'cslab://demo-lab/table/table-demo',
    column: 'y2',
    rowIndex: 20,
    revisionAtBind: 1,
  },
]

function walkNodes(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visit)
    return
  }
  const node = value as Record<string, unknown>
  visit(node)
  if (Array.isArray(node.content)) walkNodes(node.content, visit)
}

describe('SKLGP 演示内容构建器', () => {
  test('Given 两个胶囊 When 生成论文 docJson Then 标题层级、胶囊与 4 条批注齐备', () => {
    const doc = buildSkLgpThesisDocJson(CAPSULES)
    const levels = new Set<number>()
    const capsuleIds = new Set<string>()
    let commentCount = 0
    const commentAttrs: Array<Record<string, unknown>> = []

    walkNodes(doc, (node) => {
      if (node.type === 'heading') {
        levels.add(Number((node.attrs as Record<string, unknown> | undefined)?.level))
      }
      if (node.type === 'scienceCapsule') {
        const attrs = (node.attrs ?? {}) as Record<string, unknown>
        capsuleIds.add(String(attrs.capsuleId ?? ''))
      }
      if (Array.isArray(node.marks)) {
        for (const mark of node.marks as Array<Record<string, unknown>>) {
          if (mark.type !== 'comment') continue
          commentCount += 1
          commentAttrs.push((mark.attrs ?? {}) as Record<string, unknown>)
        }
      }
    })

    expect(levels.has(1)).toBe(true)
    expect(levels.has(2)).toBe(true)
    expect(levels.has(3)).toBe(true)
    // 摘要与 4.3 各引用一次，同一胶囊去重后必须是 2 个。
    expect(capsuleIds.size).toBe(2)
    expect(commentCount).toBe(4)
    for (const attrs of commentAttrs) {
      expect(typeof attrs.suggestionId).toBe('string')
      expect(typeof attrs.personaType).toBe('string')
      expect(typeof attrs.authorName).toBe('string')
      expect(typeof attrs.commentText).toBe('string')
      expect(typeof attrs.createdAt).toBe('number')
    }

    const plain = JSON.stringify(doc)
    expect(plain).toContain('【待补】')
    expect(plain).toContain('但尚未完成参数敏感性分析，')
  })

  test('Given 演示时程 CSV When 解析峰值 Then 峰值流量与最大水深均在 rowIndex 20', () => {
    const csv = readFileSync(`${DEMO_DIR}/debris_flow_timeseries.csv`, 'utf-8')
    const rows = resolveThesisCapsuleRows(csv)
    expect(rows.peakDischargeRow).toBe(20)
    expect(rows.maxDepthRow).toBe(20)
  })

  test('Given 画布构建器 When 序列化并解析 Then 7 节点 6 边且含 OR 与 dead_end', () => {
    const document = buildSkLgpCanvasDocument({
      tableUri: 'cslab://demo-lab/table/table-demo',
      demUri: 'cslab://demo-lab/geo/geo-demo',
    })
    const parsed = parseCanvasDocument(serializeCanvasDocument(document))
    expect(parsed.nodes).toHaveLength(7)
    expect(parsed.edges).toHaveLength(6)

    const graph = canvasToDagGraph(parsed)
    expect(graph.nodes).toHaveLength(7)
    expect(graph.edges).toHaveLength(6)
    expect(graph.nodes.some((node) => node.operator === 'OR')).toBe(true)
    expect(graph.nodes.some((node) => node.state === 'dead_end')).toBe(true)
  })

  test('Given 研究日志构建器 When 生成 Then 含画布双链与 TODO', () => {
    const note = buildSkLgpResearchNote({
      demUri: 'cslab://demo-lab/geo/geo-demo',
      tableUri: 'cslab://demo-lab/table/table-demo',
      thesisTitle: '演示论文初稿',
      canvasTitle: SKLGP_CANVAS_TITLE,
    })
    expect(note).toContain(`[[${SKLGP_CANVAS_TITLE}]]`)
    expect(note).toContain('- [ ]')
  })

  test('Given 过程线渲染器 When 连续调用 Then PNG 魔数与字节完全一致', () => {
    const first = renderDemoHydrographPng()
    const second = renderDemoHydrographPng()
    expect(first[0]).toBe(0x89)
    expect(first[1]).toBe(0x50)
    expect(first[2]).toBe(0x4e)
    expect(first[3]).toBe(0x47)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    expect(first.length).toBeGreaterThan(5000)
  })

  test('Given 演示 PDF 构建器 When 生成 Then 3 篇且均标注 SYNTHETIC', () => {
    const papers = buildSkLgpDemoPapers()
    expect(papers).toHaveLength(3)
    expect(papers.map((paper) => paper.fileName)).toEqual([
      'sklgp-demo-paper.pdf',
      'wenjia-id-thresholds-demo.pdf',
      'voellmy-runout-demo.pdf',
    ])
    for (const paper of papers) {
      expect(paper.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      // 主论文复用既有构建器，声明为 "Synthetic data"；新增两篇为全大写。
      expect(paper.buffer.toString('latin1').toLowerCase()).toContain('synthetic')
    }
  })

  test('Given 文件常量 When 检查 Then 过程线文件名与画布标题稳定', () => {
    expect(SKLGP_HYDROGRAPH_FILE).toBe('wenjia_gully_hydrographs.png')
    expect(SKLGP_CANVAS_TITLE).toBe('汶家沟泥石流推演')
  })
})
