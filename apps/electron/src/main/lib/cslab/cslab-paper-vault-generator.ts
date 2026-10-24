/**
 * CSLab 论文 Obsidian Vault 笔记束生成器（论文自动入库流水线 · 阶段一）
 *
 * 把论文的结构化抽取结果渲染为标准 Obsidian 笔记束：
 * Overview / Protocols / Taxonomy & Concepts / Evaluation Metrics / Figures & Tables。
 *
 * 红线：
 * 1. Obsidian 100% 兼容：YAML frontmatter、Dataview `key:: value`、`[[wikilink]]`；
 * 2. 不造假数据：缺失字段如实标注「未抽取到…」，矢量图表绝不生成占位图；
 * 3. 落盘一律 `.tmp + rename` 原子写；
 * 4. 路径经 assertLabId / resolveLabDir 校验后才可拼接。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EmpiricalMetric,
  ExperimentalProtocol,
  PaperConceptGraph,
  PaperFigureAsset,
  PaperReference,
} from '@profer/shared'
import { assertLabId, resolveLabDir } from './cslab-paths'

/** 五文件束的固定文件名（顺序即写盘顺序）。 */
const NOTE_FILE_NAMES = [
  'Overview.md',
  'Protocols.md',
  'Taxonomy & Concepts.md',
  'Evaluation Metrics.md',
  'Figures & Tables.md',
] as const

/** 笔记目录名限长；目录名过长会在 Windows 下撞 MAX_PATH。 */
const MAX_DIR_NAME_LENGTH = 120

export interface PaperVaultInput {
  labId: string
  /** 论文实体 URI（仅作溯源标识，正文不落绝对路径）。 */
  uri: string
  /** 目录名/附件目录名，如 'seismic-imaging-2024'。 */
  paperSlug: string
  title: string
  authors: string[]
  doi?: string
  venue?: string
  year?: string
  abstract?: string
  taxonomy?: string[]
  conceptGraph?: PaperConceptGraph
  protocols?: ExperimentalProtocol[]
  metrics?: EmpiricalMetric[]
  figureAssets?: PaperFigureAsset[]
  references?: PaperReference[]
  /** 库内相关论文标题，用于 [[互链]]。 */
  relatedPaperTitles?: string[]
}

export interface PaperVaultResult {
  ok: boolean
  /** 相对实验室根，如 vault/notes/papers/<Title>。 */
  noteDirRelPath: string
  /** 生成的文件名。 */
  files: string[]
  message: string
}

/**
 * 标题清洗为合法目录名：去掉 Windows 非法字符、折叠空白、限长 120。
 * 纯函数，供测试直接断言。
 */
export function sanitizeNoteDirName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIR_NAME_LENGTH)
    .trim()
  return cleaned || 'paper-note'
}

/** YAML 标量统一双引号转义，杜绝 `:`/`#`/引号等破坏 frontmatter。 */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
  return `"${escaped}"`
}

/** 表格单元格转义：竖线转义、换行折叠，保证 GFM 表格不散架。 */
function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function formatScalar(value: number | string): string {
  return String(value)
}

/** taxonomy 末级小写连字符化（如 'Seismic Imaging' -> 'seismic-imaging'）。 */
function deriveDomain(taxonomy?: string[]): string {
  const levels = (taxonomy ?? []).map((item) => item.trim()).filter(Boolean)
  const last = levels[levels.length - 1]
  if (!last) return ''
  return last
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 概念 id -> `[[名称]]` 双链；图谱中查不到时如实回退为原始 id。 */
function resolveConceptRef(graph: PaperConceptGraph | undefined, id: string): string {
  const concept = graph?.concepts.find((item) => item.id === id)
  return concept ? `[[${concept.name}]]` : id
}

/** 方法 id -> `[[名称]]` 双链；先查 methods 再查 concepts，查不到回退原始 id。 */
function resolveMethodRef(graph: PaperConceptGraph | undefined, id: string): string {
  const method = graph?.methods.find((item) => item.id === id)
  return method ? `[[${method.name}]]` : resolveConceptRef(graph, id)
}

/** Overview：frontmatter + 摘要 callout + 章节互链 + 相关论文互链 + Dataview 行。 */
export function buildOverviewNote(input: PaperVaultInput): string {
  const lines: string[] = []
  const domain = deriveDomain(input.taxonomy)

  lines.push('---')
  lines.push(`title: ${yamlQuote(input.title)}`)
  if (input.authors.length > 0) {
    lines.push('authors:')
    for (const author of input.authors) lines.push(`  - ${yamlQuote(author)}`)
  } else {
    lines.push('authors: []')
  }
  if (input.doi) lines.push(`doi: ${yamlQuote(input.doi)}`)
  if (input.venue) lines.push(`venue: ${yamlQuote(input.venue)}`)
  if (input.year) lines.push(`year: ${yamlQuote(input.year)}`)
  lines.push(`tags: [paper${domain ? `, literature/${domain}` : ''}]`)
  lines.push('---')
  lines.push('')

  lines.push(`# ${input.title}`)
  lines.push('')

  lines.push('> [!abstract] 摘要')
  const abstractText = (input.abstract ?? '').trim()
  if (abstractText) {
    for (const line of abstractText.split(/\r?\n/)) lines.push(`> ${line}`)
  } else {
    lines.push('> 未抽取到摘要。')
  }
  lines.push('')

  lines.push('## 笔记导航')
  lines.push('')
  lines.push('- [[Protocols]] — 实验协议')
  lines.push('- [[Taxonomy & Concepts]] — 学科分类与概念图谱')
  lines.push('- [[Evaluation Metrics]] — 评估指标')
  lines.push('- [[Figures & Tables]] — 图表资产')
  lines.push('')

  lines.push('## 相关论文')
  lines.push('')
  const related = (input.relatedPaperTitles ?? []).map((item) => item.trim()).filter(Boolean)
  if (related.length > 0) {
    for (const title of related) lines.push(`- [[${title}]]`)
  } else {
    lines.push('未关联库内相关论文。')
  }
  lines.push('')

  const references = input.references ?? []
  lines.push('## 参考文献')
  lines.push('')
  if (references.length > 0) {
    for (const reference of references) lines.push(`- ${formatReference(reference)}`)
  } else {
    lines.push('未抽取到参考文献。')
  }
  lines.push('')

  if (input.doi) lines.push(`doi:: ${input.doi}`)
  if (input.year) lines.push(`year:: ${input.year}`)
  lines.push('enriched:: true')
  lines.push('')

  return lines.join('\n')
}

function formatReference(reference: PaperReference): string {
  const parts = [reference.title]
  if (reference.authors && reference.authors.length > 0) parts.push(reference.authors.join('、'))
  if (reference.year) parts.push(reference.year)
  if (reference.venue) parts.push(reference.venue)
  if (reference.doi) parts.push(`DOI: ${reference.doi}`)
  return parts.map((part) => part.trim()).filter(Boolean).join(' · ')
}

/** Protocols：每协议一节（名称/category/步骤 checklist/参数表/仪器列表）。 */
export function buildProtocolsNote(input: PaperVaultInput): string {
  const lines: string[] = ['# Protocols', '']
  const protocols = input.protocols ?? []

  if (protocols.length === 0) {
    lines.push('未抽取到实验协议。')
    lines.push('')
    return lines.join('\n')
  }

  for (const protocol of protocols) {
    lines.push(`## ${protocol.name}`)
    lines.push('')
    lines.push(`- 分类：${protocol.category}`)
    lines.push('')

    lines.push('### 实验步骤')
    lines.push('')
    if (protocol.steps.length > 0) {
      for (const step of protocol.steps) lines.push(`- [ ] ${step}`)
    } else {
      lines.push('未抽取到实验步骤。')
    }
    lines.push('')

    lines.push('### 参数')
    lines.push('')
    const parameters = Object.entries(protocol.parameters)
    if (parameters.length > 0) {
      lines.push('| 参数 | 值 |')
      lines.push('| --- | --- |')
      for (const [key, value] of parameters) {
        lines.push(`| ${tableCell(key)} | ${tableCell(formatScalar(value))} |`)
      }
    } else {
      lines.push('未抽取到参数。')
    }
    lines.push('')

    lines.push('### 仪器')
    lines.push('')
    const instruments = (protocol.instruments ?? []).map((item) => item.trim()).filter(Boolean)
    if (instruments.length > 0) {
      for (const instrument of instruments) lines.push(`- ${instrument}`)
    } else {
      lines.push('未抽取到仪器信息。')
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Taxonomy & Concepts：学科层级树 + 概念定义表（双链）+ methods 表（角色列）。 */
export function buildTaxonomyNote(input: PaperVaultInput): string {
  const lines: string[] = ['# Taxonomy & Concepts', '']

  lines.push('## 学科分类')
  lines.push('')
  const taxonomy = (input.taxonomy ?? []).map((item) => item.trim()).filter(Boolean)
  const domain = deriveDomain(input.taxonomy)
  if (taxonomy.length > 0) {
    if (domain) {
      lines.push(`#literature/${domain}`)
      lines.push('')
    }
    taxonomy.forEach((level, index) => {
      lines.push(`${'  '.repeat(index)}- ${level}`)
    })
  } else {
    lines.push('未抽取到学科分类。')
  }
  lines.push('')

  const concepts = input.conceptGraph?.concepts ?? []
  lines.push('## 概念定义')
  lines.push('')
  if (concepts.length > 0) {
    lines.push('| 概念 | 定义 | 相关概念 |')
    lines.push('| --- | --- | --- |')
    for (const concept of concepts) {
      const related = (concept.relatedConceptIds ?? [])
        .map((id) => resolveConceptRef(input.conceptGraph, id))
        .join('、')
      lines.push(
        `| ${tableCell(concept.name)} | ${tableCell(concept.definition ?? '')} | ${tableCell(related)} |`,
      )
    }
  } else {
    lines.push('未抽取到概念定义。')
  }
  lines.push('')

  const methods = input.conceptGraph?.methods ?? []
  lines.push('## 方法')
  lines.push('')
  if (methods.length > 0) {
    lines.push('| 方法 | 角色 | 说明 | 依赖 |')
    lines.push('| --- | --- | --- | --- |')
    for (const method of methods) {
      const dependsOn = (method.dependsOn ?? [])
        .map((id) => resolveMethodRef(input.conceptGraph, id))
        .join('、')
      lines.push(
        `| ${tableCell(method.name)} | ${tableCell(method.role)} | ${tableCell(method.description ?? '')} | ${tableCell(dependsOn)} |`,
      )
    }
  } else {
    lines.push('未抽取到方法信息。')
  }
  lines.push('')

  return lines.join('\n')
}

/** Evaluation Metrics：指标对比表 + 每个指标一行 Dataview `key:: value` 注释。 */
export function buildMetricsNote(input: PaperVaultInput): string {
  const lines: string[] = ['# Evaluation Metrics', '']
  const metrics = input.metrics ?? []

  if (metrics.length === 0) {
    lines.push('未抽取到评估指标。')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('## 指标对比')
  lines.push('')
  lines.push('| name | value | unit | baseline | condition | page |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const metric of metrics) {
    lines.push(`| ${formatMetricRow(metric)} |`)
  }
  lines.push('')

  // GFM 表格行间无法插入文本，Dataview 注释按行序紧随表后逐行给出。
  lines.push('## Dataview 字段')
  lines.push('')
  for (const metric of metrics) {
    lines.push(formatMetricDataview(metric))
    lines.push('')
  }

  return lines.join('\n')
}

function formatMetricRow(metric: EmpiricalMetric): string {
  const cells = [
    metric.name,
    formatScalar(metric.value),
    metric.unit ?? '',
    metric.baseline !== undefined && metric.baseline !== null ? formatScalar(metric.baseline) : '',
    metric.condition ?? '',
    String(metric.page),
  ]
  return cells.map((cell) => tableCell(cell)).join(' | ')
}

function formatMetricDataview(metric: EmpiricalMetric): string {
  const parts = [`metric:: ${metric.name}`, `value:: ${formatScalar(metric.value)}`]
  if (metric.unit) parts.push(`unit:: ${metric.unit}`)
  parts.push(`page:: ${metric.page}`)
  return parts.join(' ')
}

/** Figures & Tables：位图直嵌 `![[relPath]]`；矢量图表只留图注引用，绝不生成占位图。 */
export function buildFiguresNote(input: PaperVaultInput): string {
  const lines: string[] = ['# Figures & Tables', '']
  const figures = input.figureAssets ?? []

  if (figures.length === 0) {
    lines.push('未抽取到图表资产。')
    lines.push('')
    return lines.join('\n')
  }

  figures.forEach((figure, index) => {
    lines.push(`## 图 ${index + 1}`)
    lines.push('')
    if (figure.renderSource === 'image-xobject' && figure.relPath) {
      lines.push(`![[${figure.relPath}]]`)
      lines.push('')
    }
    const caption = figure.caption.trim()
    lines.push(`- 图注：${caption || '未抽取到图注。'}`)
    if (figure.renderSource === 'vector-unsampled') {
      lines.push(`- 引用：第 ${figure.pageNumber} 页·矢量图表（未采样）`)
    } else {
      lines.push(`- 页码：第 ${figure.pageNumber} 页`)
      if (!figure.relPath) lines.push('- 说明：位图未导出，仅保留图注。')
    }
    lines.push('')
  })

  return lines.join('\n')
}

/** `.tmp + rename` 原子写（对齐 cslab-paths 的 manifest 写法）。 */
function atomicWriteFile(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp`
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, targetPath)
}

/**
 * 写出五文件束；outputDir 由调用方注入（测试可直接写 os.tmpdir() 临时目录），
 * 不触碰任何数据库。
 */
export function writeNoteBundle(outputDir: string, input: PaperVaultInput): string[] {
  mkdirSync(outputDir, { recursive: true })
  const contents: Record<string, string> = {
    'Overview.md': buildOverviewNote(input),
    'Protocols.md': buildProtocolsNote(input),
    'Taxonomy & Concepts.md': buildTaxonomyNote(input),
    'Evaluation Metrics.md': buildMetricsNote(input),
    'Figures & Tables.md': buildFiguresNote(input),
  }
  for (const name of NOTE_FILE_NAMES) {
    atomicWriteFile(join(outputDir, name), contents[name]!)
  }
  return [...NOTE_FILE_NAMES]
}

/** 论文笔记束落盘并刷新 Vault 索引；任何失败只返回结果对象，不抛出。 */
export async function synthesizePaperVault(input: PaperVaultInput): Promise<PaperVaultResult> {
  try {
    const labId = assertLabId(input.labId)
    const sanitizedTitle = sanitizeNoteDirName(input.title)
    const noteDirRelPath = `vault/notes/papers/${sanitizedTitle}`
    const outputDir = join(resolveLabDir(labId), 'vault', 'notes', 'papers', sanitizedTitle)
    const files = writeNoteBundle(outputDir, input)

    try {
      // 动态 import 避免与 cslab-vault-index 环形依赖；索引失败不影响笔记落盘。
      const vaultIndex = await import('./cslab-vault-index')
      await vaultIndex.rebuildVaultIndex(labId)
    } catch (error) {
      console.warn('[CSLab] 论文笔记束已生成，但 Vault 索引刷新失败:', error)
    }

    return {
      ok: true,
      noteDirRelPath,
      files,
      message: `已生成 ${files.length} 个论文笔记文件`,
    }
  } catch (error) {
    return {
      ok: false,
      noteDirRelPath: '',
      files: [],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
