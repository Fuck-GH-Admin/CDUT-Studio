/**
 * CSLab 分层 3D 空间知识拓扑构建器测试
 *
 * 测试红线：只测纯 builder 与 os.tmpdir() 临时目录落盘，绝不加载 node:sqlite、不联网；
 * 确定性用例逐坐标比对，全程禁止 Math.random 干扰。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hierarchical3DGraphData, Hierarchical3DGraphNode } from '@profer/shared'
import {
  assignDeterministicPositions,
  buildCorpusTopology,
  buildPaperTopology,
  loadTopology,
  relaxLayerLayout,
  saveTopology,
  topologyRelPath,
  type PaperTopologyInput,
} from './cslab-3d-topology'

const LAB_ID = 'topo-lab-001'
let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-3d-topology-'))
})

afterAll(() => {
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放时交给系统回收。
  }
})

/** 含全部节点类型的单篇输入（macro/meso/micro 三层齐备）。 */
function createFullInput(overrides: Partial<PaperTopologyInput> = {}): PaperTopologyInput {
  return {
    uri: 'cslab://topo-lab-001/lit/paper-0001',
    title: 'Viscoacoustic Full Waveform Inversion for Seismic Imaging',
    authors: ['Ada Lovelace', 'Alan Turing'],
    venue: 'IEEE TGRS',
    year: '2024',
    taxonomy: ['Earth Sciences', 'Geophysics', 'Seismic Imaging'],
    conceptGraph: {
      concepts: [
        {
          id: 'c1',
          name: 'Seismic migration',
          definition: '将反射波归位到真实空间位置。',
          relatedConceptIds: ['c2'],
        },
        {
          id: 'c2',
          name: 'Velocity model',
          definition: '地下速度结构模型。',
          relatedConceptIds: ['c1'],
        },
      ],
      methods: [
        {
          id: 'm1',
          name: 'Full Waveform Inversion',
          role: 'proposed',
          description: '全波形反演成像。',
          dependsOn: ['m2', 'c2'],
        },
        { id: 'm2', name: 'Ray Tomography', role: 'baseline', description: '走时层析成像。' },
      ],
    },
    protocols: [
      {
        id: 'proto-0001',
        name: '全波形反演成像流程',
        category: 'computation',
        steps: ['构建初始速度模型', '运行 Full Waveform Inversion 迭代'],
        parameters: { iteration: 30 },
        instruments: ['GPU 集群'],
      },
    ],
    metrics: [
      {
        name: 'PSNR',
        value: 32.5,
        unit: 'dB',
        baseline: 30.1,
        condition: '全波形反演成像流程',
        page: 6,
      },
      { name: 'SSIM', value: 0.98, condition: 'Set5', page: 7 },
    ],
    figureAssets: [
      {
        id: 'fig-1',
        caption: 'Marmousi 模型成像结果',
        pageNumber: 1,
        relPath: 'attachments/paper-0001/fig_p1_1.png',
        renderSource: 'image-xobject',
      },
      {
        id: 'fig-2',
        caption: '速度模型收敛曲线',
        pageNumber: 3,
        renderSource: 'vector-unsampled',
      },
    ],
    references: [
      {
        title: 'Full waveform inversion of seismic data',
        authors: ['A. Tarantola'],
        year: '1984',
        venue: 'Geophysics',
        doi: '10.1190/geo1984-049.1',
      },
      { title: 'Ray Tomography Revisited', year: '2019', venue: 'Geophysics' },
    ],
    ...overrides,
  }
}

function nodeById(data: Hierarchical3DGraphData, id: string): Hierarchical3DGraphNode {
  const node = data.nodes.find((item) => item.id === id)
  expect(node).toBeDefined()
  return node!
}

describe('buildPaperTopology — Z 分层严格有序', () => {
  const data = buildPaperTopology(createFullInput())

  test('全部节点类型齐备，且 layer/type 映射符合分层约定', () => {
    const types = new Set(data.nodes.map((node) => node.type))
    for (const type of ['paper', 'author', 'venue', 'concept', 'method', 'protocol', 'metric', 'figure']) {
      expect(types.has(type as Hierarchical3DGraphNode['type'])).toBe(true)
    }

    for (const node of data.nodes) {
      if (node.type === 'metric' || node.type === 'figure') expect(node.layer).toBe('micro')
      if (node.type === 'method' || node.type === 'protocol') expect(node.layer).toBe('meso')
      if (node.type === 'author' || node.type === 'venue') expect(node.layer).toBe('macro')
      // 引用条目是宏观层 'paper'（label 为引用标题）。
      if (node.id.startsWith('ref:')) {
        expect(node.layer).toBe('macro')
        expect(node.type).toBe('paper')
      }
      // 研究领域节点是宏观层 'concept'。
      if (node.id.startsWith('field:')) {
        expect(node.layer).toBe('macro')
        expect(node.type).toBe('concept')
      }
      // 概念/方法/协议节点本体在中观层。
      if (node.id.startsWith('concept:') || node.id.startsWith('method:')) {
        expect(node.layer).toBe('meso')
      }
    }
  })

  test('macro z∈[150,250]、meso |z|≤50、micro z∈[-250,-150]', () => {
    const macro = data.nodes.filter((node) => node.layer === 'macro')
    const meso = data.nodes.filter((node) => node.layer === 'meso')
    const micro = data.nodes.filter((node) => node.layer === 'micro')
    expect(macro.length).toBeGreaterThan(0)
    expect(meso.length).toBeGreaterThan(0)
    expect(micro.length).toBeGreaterThan(0)

    for (const node of macro) {
      expect(node.z!).toBeGreaterThanOrEqual(150)
      expect(node.z!).toBeLessThanOrEqual(250)
      expect(node.zLevel).toBe(2)
    }
    for (const node of meso) {
      expect(Math.abs(node.z!)).toBeLessThanOrEqual(50)
      expect(node.zLevel).toBe(1)
    }
    for (const node of micro) {
      expect(node.z!).toBeLessThanOrEqual(-150)
      expect(node.z!).toBeGreaterThanOrEqual(-250)
      expect(node.zLevel).toBe(0)
    }
  })

  test('z_macro > z_meso > z_micro 全局严格有序', () => {
    const macroZ = data.nodes.filter((n) => n.layer === 'macro').map((n) => n.z!)
    const mesoZ = data.nodes.filter((n) => n.layer === 'meso').map((n) => n.z!)
    const microZ = data.nodes.filter((n) => n.layer === 'micro').map((n) => n.z!)
    expect(Math.min(...macroZ)).toBeGreaterThan(Math.max(...mesoZ))
    expect(Math.min(...mesoZ)).toBeGreaterThan(Math.max(...microZ))
  })

  test('details 携带可读弹窗详情（metric value/unit/page、figure relPath/renderSource/page、concept definition）', () => {
    const psnr = nodeById(data, 'metric:paper-0001:0')
    expect(psnr.details?.value).toBe(32.5)
    expect(psnr.details?.unit).toBe('dB')
    expect(psnr.details?.page).toBe(6)

    const figure = nodeById(data, 'figure:paper-0001:0')
    expect(figure.details?.relPath).toBe('attachments/paper-0001/fig_p1_1.png')
    expect(figure.details?.renderSource).toBe('image-xobject')
    expect(figure.details?.page).toBe(1)

    const concept = nodeById(data, 'concept:Seismic migration')
    expect(concept.details?.definition).toBe('将反射波归位到真实空间位置。')
  })
})

describe('buildPaperTopology — 边引用完整性', () => {
  const data = buildPaperTopology(createFullInput())

  test('所有边端点存在于 nodes，无自环、无重复 id', () => {
    const ids = new Set(data.nodes.map((node) => node.id))
    expect(ids.size).toBe(data.nodes.length)
    for (const edge of data.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
      expect(edge.source).not.toBe(edge.target)
    }
  })

  test('约定的 12 种关系齐全（宁可少连不可悬空的前提下）', () => {
    const relations = new Set(data.edges.map((edge) => edge.relation))
    for (const relation of [
      'authored',
      'published-in',
      'in-field',
      'mentions',
      'uses',
      'applies',
      'related',
      'depends-on',
      'uses-method',
      'measures',
      'figure-of',
      'cites',
    ]) {
      expect(relations.has(relation)).toBe(true)
    }

    const ids = new Set(data.nodes.map((node) => node.id))
    // concept↔concept 'related' 无向去重：双向声明只留一条。
    expect(data.edges.filter((edge) => edge.relation === 'related').length).toBe(1)
    // depends-on 覆盖方法依赖与概念依赖。
    expect(data.edges.some((e) => e.source === 'method:Full Waveform Inversion' && e.target === 'method:Ray Tomography' && e.relation === 'depends-on')).toBe(true)
    expect(data.edges.some((e) => e.source === 'method:Full Waveform Inversion' && e.target === 'concept:Velocity model' && e.relation === 'depends-on')).toBe(true)
    // metric 挂协议 / 回退挂论文。
    expect(data.edges.some((e) => e.source === 'metric:paper-0001:0' && e.target.startsWith('protocol:paper-0001:') && e.relation === 'measures')).toBe(true)
    expect(data.edges.some((e) => e.source === 'metric:paper-0001:1' && e.target === 'paper:paper-0001' && e.relation === 'measures')).toBe(true)
    // 单篇视角引用一律连引用条目节点。
    expect(data.edges.some((e) => e.source === 'paper:paper-0001' && e.target === 'ref:paper-0001:0' && e.relation === 'cites')).toBe(true)
    expect(ids.has('ref:paper-0001:1')).toBe(true)
    // protocol→method 'uses-method'（步骤文本命中方法名）。
    expect(data.edges.some((e) => e.relation === 'uses-method' && e.target === 'method:Full Waveform Inversion')).toBe(true)
  })
})

describe('buildPaperTopology — 确定性布局', () => {
  test('同输入两次构建，节点坐标逐坐标完全一致', () => {
    const first = buildPaperTopology(createFullInput())
    const second = buildPaperTopology(createFullInput())
    expect(second.nodes.length).toBe(first.nodes.length)

    const secondById = new Map(second.nodes.map((node) => [node.id, node]))
    for (const node of first.nodes) {
      const twin = secondById.get(node.id)
      expect(twin).toBeDefined()
      expect(twin!.x).toBe(node.x)
      expect(twin!.y).toBe(node.y)
      expect(twin!.z).toBe(node.z)
      expect(twin!.zLevel).toBe(node.zLevel)
    }
    expect(second.edges).toEqual(first.edges)
  })

  test('力导向松弛只改 (x,y)，绝不破坏 z（build 前后 z 不变）', () => {
    const data = buildPaperTopology(createFullInput())
    const clone = data.nodes.map((node) => ({ ...node }))

    // 初始哈希布局给出的 z（即 build 内部松弛前的 z 基准）。
    assignDeterministicPositions(clone)
    const zBefore = clone.map((node) => node.z)
    const xyBefore = clone.map((node) => ({ x: node.x, y: node.y }))
    relaxLayerLayout(clone, data.edges)
    expect(clone.map((node) => node.z)).toEqual(zBefore)

    // 与 build 输出一致：build 内部的松弛同样没有改动 z。
    const zById = new Map(data.nodes.map((node) => [node.id, node.z]))
    for (const node of clone) {
      expect(node.z).toBe(zById.get(node.id))
    }

    // 松弛确实移动了部分 (x,y)（层内力导向生效），且最终坐标与 build 输出一致。
    const moved = clone.some(
      (node, index) => node.x !== xyBefore[index]!.x || node.y !== xyBefore[index]!.y,
    )
    expect(moved).toBe(true)
    const byId = new Map(data.nodes.map((node) => [node.id, node]))
    for (const node of clone) {
      expect(node.x).toBe(byId.get(node.id)!.x)
      expect(node.y).toBe(byId.get(node.id)!.y)
    }
  })
})

describe('saveTopology / loadTopology', () => {
  test('topologyRelPath 拼接与临时目录 round-trip（原子写不留 .tmp）', () => {
    expect(topologyRelPath('cslab://topo-lab-001/lit/paper-0001')).toBe('db/graph_3d_paper-0001.json')
    expect(topologyRelPath('corpus')).toBe('db/graph_3d_corpus.json')

    const data = buildPaperTopology(createFullInput())
    saveTopology(LAB_ID, data, rootDir)

    expect(readdirSync(join(rootDir, 'db')).sort()).toEqual(['graph_3d_paper-0001.json'])

    const loaded = loadTopology(LAB_ID, data.paperUri, rootDir)
    expect(loaded).not.toBeNull()
    expect(loaded!.paperUri).toBe(data.paperUri)
    expect(loaded!.builtAt).toBe(data.builtAt)
    expect(loaded!.nodes).toEqual(data.nodes)
    expect(loaded!.edges).toEqual(data.edges)
  })

  test('坏 JSON / 结构不合法 / 文件缺失一律返回 null 不抛出', () => {
    const target = join(rootDir, 'db', 'graph_3d_paper-0001.json')

    writeFileSync(target, '{ 这不是合法 JSON', 'utf-8')
    expect(loadTopology(LAB_ID, 'cslab://topo-lab-001/lit/paper-0001', rootDir)).toBeNull()

    writeFileSync(target, '{"nodes": "不是数组", "edges": []}', 'utf-8')
    expect(loadTopology(LAB_ID, 'cslab://topo-lab-001/lit/paper-0001', rootDir)).toBeNull()

    expect(loadTopology(LAB_ID, 'cslab://topo-lab-001/lit/paper-9999', rootDir)).toBeNull()

    // 非法 labId 只告警不抛（assertLabId 红线在失败路径同样不外抛）。
    expect(loadTopology('BAD LAB ID', 'cslab://topo-lab-001/lit/paper-0001', rootDir)).toBeNull()
  })
})

describe('buildCorpusTopology — 全库聚合', () => {
  const first = createFullInput()
  const second: PaperTopologyInput = {
    uri: 'cslab://topo-lab-001/lit/paper-0002',
    title: 'Ray Tomography Revisited',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    venue: 'Geophysics',
    year: '2019',
    taxonomy: ['Earth Sciences', 'Geophysics'],
    conceptGraph: {
      concepts: [{ id: 'c1', name: 'Velocity model', definition: '地下速度结构模型。' }],
      methods: [],
    },
    protocols: [],
    metrics: [],
    figureAssets: [],
    references: [{ title: 'Viscoacoustic Full Waveform Inversion for Seismic Imaging' }],
  }
  const corpus = buildCorpusTopology([first, second])

  test('各论文节点并入、无重复 id（同名作者/概念合并计数）', () => {
    expect(corpus.paperUri).toBe('corpus')
    const ids = new Set(corpus.nodes.map((node) => node.id))
    expect(ids.size).toBe(corpus.nodes.length)
    expect(ids.has('paper:paper-0001')).toBe(true)
    expect(ids.has('paper:paper-0002')).toBe(true)

    const ada = nodeById(corpus, 'author:Ada Lovelace')
    expect(ada.details?.count).toBe(2)
    expect(ada.details?.paperUris).toEqual([
      'cslab://topo-lab-001/lit/paper-0001',
      'cslab://topo-lab-001/lit/paper-0002',
    ])

    const velocity = nodeById(corpus, 'concept:Velocity model')
    expect(velocity.details?.count).toBe(2)

    const field = nodeById(corpus, 'field:Earth Sciences')
    expect(field.details?.count).toBe(2)

    // 未共享节点计数为 1。
    expect(nodeById(corpus, 'author:Alan Turing').details?.count).toBe(1)
  })

  test('引用命中库内同名标题直连论文，未命中仍连引用条目节点', () => {
    // paper-0002 引用 paper-0001 标题 -> paper→paper 'cites'。
    expect(
      corpus.edges.some(
        (e) =>
          e.source === 'paper:paper-0002' &&
          e.target === 'paper:paper-0001' &&
          e.relation === 'cites',
      ),
    ).toBe(true)
    // paper-0001 引用 paper-0002 标题 -> 直连 paper-0002。
    expect(
      corpus.edges.some(
        (e) =>
          e.source === 'paper:paper-0001' &&
          e.target === 'paper:paper-0002' &&
          e.relation === 'cites',
      ),
    ).toBe(true)
    // 命中库内同名标题的引用不再生成引用条目节点。
    expect(corpus.nodes.some((n) => n.id === 'ref:paper-0001:1')).toBe(false)
    // 未命中的引用仍连引用条目节点。
    expect(
      corpus.edges.some(
        (e) => e.source === 'paper:paper-0001' && e.target === 'ref:paper-0001:0' && e.relation === 'cites',
      ),
    ).toBe(true)
  })

  test('聚合后边引用完整，且 Z 分层依旧严格有序', () => {
    const ids = new Set(corpus.nodes.map((node) => node.id))
    for (const edge of corpus.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
      expect(edge.source).not.toBe(edge.target)
    }

    const macroZ = corpus.nodes.filter((n) => n.layer === 'macro').map((n) => n.z!)
    const mesoZ = corpus.nodes.filter((n) => n.layer === 'meso').map((n) => n.z!)
    const microZ = corpus.nodes.filter((n) => n.layer === 'micro').map((n) => n.z!)
    expect(Math.min(...macroZ)).toBeGreaterThan(Math.max(...mesoZ))
    expect(Math.min(...mesoZ)).toBeGreaterThan(Math.max(...microZ))
    for (const node of corpus.nodes) {
      expect(Number.isFinite(node.x!)).toBe(true)
      expect(Number.isFinite(node.y!)).toBe(true)
      expect(Number.isFinite(node.z!)).toBe(true)
    }
  })

  test('空输入返回空语料拓扑，paperUri 恒为 corpus', () => {
    const empty = buildCorpusTopology([])
    expect(empty.paperUri).toBe('corpus')
    expect(empty.nodes).toEqual([])
    expect(empty.edges).toEqual([])
  })
})
