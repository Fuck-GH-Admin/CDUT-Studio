/**
 * CSLab 论文 Obsidian Vault 笔记束生成器测试
 *
 * 测试红线：只测纯 builder 与 writeNoteBundle（os.tmpdir() 临时目录），
 * 绝不加载 node:sqlite（即不触发 vault-index 真实刷新）。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PaperVaultInput } from './cslab-paper-vault-generator'
import {
  buildFiguresNote,
  buildMetricsNote,
  buildOverviewNote,
  buildProtocolsNote,
  buildTaxonomyNote,
  sanitizeNoteDirName,
  writeNoteBundle,
} from './cslab-paper-vault-generator'

let rootDir = ''

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-paper-vault-'))
})

afterAll(() => {
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放时交给系统回收。
  }
})

function createInput(overrides: Partial<PaperVaultInput> = {}): PaperVaultInput {
  return {
    labId: 'vault-lab-001',
    uri: 'cslab://vault-lab-001/lit/paper-0001',
    paperSlug: 'seismic-imaging-2024',
    title: 'Seismic Imaging: "Deep" Benchmarks',
    authors: ['Ada Lovelace', 'Alan Turing'],
    doi: '10.1000/xyz123',
    venue: 'IEEE TGRS',
    year: '2024',
    abstract: '本文提出了一种深度波形反演成像方法。\n在 Marmousi 模型上验证。',
    taxonomy: ['Earth Sciences', 'Geophysics', 'Seismic Imaging'],
    conceptGraph: {
      concepts: [
        {
          id: 'c1',
          name: 'Seismic migration',
          definition: '将反射波归位到真实空间位置。',
          relatedConceptIds: ['c2'],
        },
        { id: 'c2', name: 'Velocity model', definition: '地下速度结构模型。' },
      ],
      methods: [
        {
          id: 'm1',
          name: 'Full Waveform Inversion',
          role: 'proposed',
          description: '全波形反演成像。',
          dependsOn: ['m2'],
        },
        { id: 'm2', name: 'Ray Tomography', role: 'baseline', description: '走时层析成像。' },
      ],
    },
    protocols: [
      {
        id: 'proto-0001',
        name: '高温固相合成',
        category: 'synthesis',
        steps: ['称取前驱体并研磨混合', '800 °C 煅烧 12 小时'],
        parameters: { temperature: 800, duration: '12 h' },
        instruments: ['管式炉', '电子天平'],
      },
    ],
    metrics: [
      { name: 'PSNR', value: 32.5, unit: 'dB', baseline: 30.1, condition: 'Set5', page: 6 },
      { name: 'SSIM', value: 0.98, condition: 'Set5', page: 7 },
    ],
    figureAssets: [
      {
        id: 'fig-1',
        caption: 'Marmousi 模型成像结果',
        pageNumber: 1,
        relPath: 'attachments/seismic-imaging-2024/fig_p1_1.png',
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
    ],
    relatedPaperTitles: ['Ray Tomography Revisited'],
    ...overrides,
  }
}

function extractFrontmatter(note: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(note)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('buildOverviewNote', () => {
  test('frontmatter 三横线定界与 YAML 引号', () => {
    const note = buildOverviewNote(createInput())
    expect(note.startsWith('---\n')).toBe(true)

    const frontmatter = extractFrontmatter(note)
    // 标题含 `:` 与引号时必须整体双引号并转义内部引号。
    expect(frontmatter).toContain('title: "Seismic Imaging: \\"Deep\\" Benchmarks"')
    expect(frontmatter).toContain('authors:')
    expect(frontmatter).toContain('  - "Ada Lovelace"')
    expect(frontmatter).toContain('doi: "10.1000/xyz123"')
    expect(frontmatter).toContain('year: "2024"')
    expect(frontmatter).toContain('tags: [paper, literature/seismic-imaging]')
  })

  test('摘要 callout 与四个章节互链', () => {
    const note = buildOverviewNote(createInput())
    expect(note).toContain('> [!abstract] 摘要')
    expect(note).toContain('> 本文提出了一种深度波形反演成像方法。')
    expect(note).toContain('[[Protocols]]')
    expect(note).toContain('[[Taxonomy & Concepts]]')
    expect(note).toContain('[[Evaluation Metrics]]')
    expect(note).toContain('[[Figures & Tables]]')
    expect(note).toContain('[[Ray Tomography Revisited]]')
  })

  test('末尾 Dataview key:: value 行', () => {
    const note = buildOverviewNote(createInput())
    expect(note).toContain('doi:: 10.1000/xyz123')
    expect(note).toContain('year:: 2024')
    expect(note.trimEnd().endsWith('enriched:: true')).toBe(true)
  })
})

describe('buildProtocolsNote', () => {
  test('步骤 checklist、参数表与仪器列表', () => {
    const note = buildProtocolsNote(createInput())
    expect(note).toContain('## 高温固相合成')
    expect(note).toContain('分类：synthesis')
    expect(note).toContain('- [ ] 称取前驱体并研磨混合')
    expect(note).toContain('- [ ] 800 °C 煅烧 12 小时')
    expect(note).toContain('| 参数 | 值 |')
    expect(note).toContain('| temperature | 800 |')
    expect(note).toContain('| duration | 12 h |')
    expect(note).toContain('- 管式炉')
  })

  test('空协议如实写明未抽取到', () => {
    const note = buildProtocolsNote(createInput({ protocols: [] }))
    expect(note).toContain('未抽取到实验协议')
  })
})

describe('buildTaxonomyNote', () => {
  test('层级树标签、概念双链与方法角色列', () => {
    const note = buildTaxonomyNote(createInput())
    expect(note).toContain('#literature/seismic-imaging')
    expect(note).toContain('- Earth Sciences')
    expect(note).toContain('  - Geophysics')
    expect(note).toContain('    - Seismic Imaging')
    expect(note).toContain('[[Velocity model]]')
    expect(note).toContain('| 方法 | 角色 | 说明 | 依赖 |')
    expect(note).toContain('proposed')
    expect(note).toContain('baseline')
    expect(note).toContain('[[Ray Tomography]]')
  })
})

describe('buildMetricsNote', () => {
  test('指标对比表与 key:: value 注释', () => {
    const note = buildMetricsNote(createInput())
    expect(note).toContain('| name | value | unit | baseline | condition | page |')
    expect(note).toContain('| PSNR | 32.5 | dB | 30.1 | Set5 | 6 |')
    expect(note).toContain('metric:: PSNR value:: 32.5 unit:: dB page:: 6')
    expect(note).toContain('metric:: SSIM value:: 0.98')
  })
})

describe('buildFiguresNote', () => {
  test('image-xobject 直嵌 relPath 并带图注与页码', () => {
    const note = buildFiguresNote(createInput())
    expect(note).toContain('![[attachments/seismic-imaging-2024/fig_p1_1.png]]')
    expect(note).toContain('图注：Marmousi 模型成像结果')
    expect(note).toContain('第 1 页')
    expect(note).toContain('第 3 页·矢量图表（未采样）')
  })

  test('vector-unsampled 只留图注引用，绝无占位图', () => {
    const note = buildFiguresNote(
      createInput({
        figureAssets: [
          {
            id: 'fig-2',
            caption: '速度模型收敛曲线',
            pageNumber: 3,
            renderSource: 'vector-unsampled',
          },
        ],
      }),
    )
    expect(note).not.toContain('![[')
    expect(note).not.toContain('占位')
    expect(note).toContain('图注：速度模型收敛曲线')
    expect(note).toContain('第 3 页·矢量图表（未采样）')
  })
})

describe('writeNoteBundle', () => {
  test('临时目录落盘 5 个文件且内容含关键标记', () => {
    const outputDir = join(rootDir, 'bundle')
    const files = writeNoteBundle(outputDir, createInput())

    expect([...files].sort()).toEqual(
      [
        'Overview.md',
        'Protocols.md',
        'Taxonomy & Concepts.md',
        'Evaluation Metrics.md',
        'Figures & Tables.md',
      ].sort(),
    )
    expect(readdirSync(outputDir).sort()).toEqual([...files].sort())

    expect(readFileSync(join(outputDir, 'Overview.md'), 'utf-8')).toContain('enriched:: true')
    expect(readFileSync(join(outputDir, 'Protocols.md'), 'utf-8')).toContain('- [ ]')
    expect(readFileSync(join(outputDir, 'Taxonomy & Concepts.md'), 'utf-8')).toContain(
      '#literature/seismic-imaging',
    )
    expect(readFileSync(join(outputDir, 'Evaluation Metrics.md'), 'utf-8')).toContain('metric:: PSNR')
    expect(readFileSync(join(outputDir, 'Figures & Tables.md'), 'utf-8')).toContain('![[')
  })

  test('非法字符标题 sanitize 与限长', () => {
    const dirtyTitle = 'Seismic Imaging: 2024 / Final?'
    const sanitized = sanitizeNoteDirName(dirtyTitle)
    expect(sanitized).toBe('Seismic Imaging 2024 Final')
    expect(sanitized).not.toMatch(/[\\/:*?"<>|]/)

    const outputDir = join(rootDir, sanitized)
    const files = writeNoteBundle(outputDir, createInput({ title: dirtyTitle }))
    expect(basename(outputDir)).toBe('Seismic Imaging 2024 Final')
    expect(readdirSync(outputDir).sort()).toEqual([...files].sort())

    expect(sanitizeNoteDirName('x'.repeat(200)).length).toBe(120)
  })
})
