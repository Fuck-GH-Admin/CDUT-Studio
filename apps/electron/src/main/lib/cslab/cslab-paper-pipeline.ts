/**
 * CSLab 论文自动入库流水线（静默后台编排）
 *
 * 串联：结构富化（deferIndexRebuild）→ 实证解析（图表直提 + 指标抽取）
 *      → 语义增强（LLM 严格 schema / 确定性回退）→ Obsidian Vault 五文件束
 *      → 统一触发 GraphRAG 索引重建。
 *
 * 红线：
 * 1. 全程静默异步（限流 ≤2、单文献单飞），绝不阻断 UI 与入笼主流程；
 * 2. 任何阶段失败仅 console.warn，不抛出、不中断后续阶段（重建仍会调度）；
 * 3. GraphRAG 索引重建推迟到全部阶段完成后统一触发一次（500ms 防抖单飞），
 *    杜绝结构解析完成即重建与 Vault/图表阶段的重复锁竞争；
 * 4. 不生成占位数据：LLM 缺席走确定性回退，矢量图表如实标记 vector-unsampled。
 */

import { broadcastCsLabEvent } from './cslab-events'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import { listLiterature, readLiteratureBuffer } from './cslab-literature'
import {
  enrichLiteratureInBackground,
  getLiteratureStructure,
  type LiteratureStructureFile,
} from './cslab-literature-structure'
import {
  extractPaperFigures,
  parseEmpiricalMetricsFromMarkdown,
  type FigureBlock,
} from './cslab-empirical-parser'
import {
  enrichPaperSemantics,
  type PaperSemanticEnrichment,
} from './cslab-semantic-enricher'
import {
  sanitizeNoteDirName,
  synthesizePaperVault,
} from './cslab-paper-vault-generator'
import { buildPaperTopology, saveTopology } from './cslab-3d-topology'
import type { EmpiricalMetric, PaperFigureAsset } from '@profer/shared'

/** 重任务（图表扫描/LLM 调用）并发上限。 */
const MAX_CONCURRENT_PIPELINES = 2
/** PDF 读取上限（与结构解析一致）。 */
const MAX_PDF_BYTES = 160 * 1024 * 1024
/** 互链相关论文数量上限。 */
const MAX_RELATED_PAPERS = 10

interface PipelineJob {
  labId: string
  uri: string
  resolve: () => void
  reject: (error: unknown) => void
}

const pipelineQueue: PipelineJob[] = []
const inFlightPipelines = new Map<string, Promise<void>>()
let activePipelines = 0

function drainPipelineQueue(): void {
  while (activePipelines < MAX_CONCURRENT_PIPELINES && pipelineQueue.length > 0) {
    const job = pipelineQueue.shift()!
    activePipelines += 1
    void runPipelineOnce(job.labId, job.uri)
      .then(job.resolve, job.reject)
      .finally(() => {
        activePipelines -= 1
        drainPipelineQueue()
      })
  }
}

/** 单篇入箱流水线入口：限流 ≤2、同一文献单飞；入笼/同步钩子统一走这里。 */
export function runPaperIngestionPipeline(labId: string, uri: string): Promise<void> {
  const key = `${labId}|${uri}`
  const existing = inFlightPipelines.get(key)
  if (existing) return existing
  const task = new Promise<void>((resolve, reject) => {
    pipelineQueue.push({ labId, uri, resolve, reject })
    drainPipelineQueue()
  })
  inFlightPipelines.set(key, task)
  void task.then(
    () => inFlightPipelines.delete(key),
    () => inFlightPipelines.delete(key),
  )
  return task
}

/** 等待所有在途流水线结束（删除/重置实验室前释放文件句柄）。 */
export async function waitForPaperIngestionPipelines(timeoutMs = 8_000): Promise<void> {
  const pending = [...inFlightPipelines.values()]
  if (pending.length === 0) return
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/** 从结构中拼出参考文献区原始文本（识别 References/参考文献 标题章节）。 */
function pickReferencesText(structure: LiteratureStructureFile): string | undefined {
  const section = structure.sections.find((item) => /^(references|参考文献|bibliography)$/i.test(item.title.trim()))
  const text = section?.text?.trim()
  return text && text.length > 0 ? text : undefined
}

function pickRelatedPaperTitles(labId: string, selfUri: string): string[] {
  try {
    return listLiterature(labId)
      .filter((item) => item.uri !== selfUri && item.title.trim().length > 0)
      .slice(0, MAX_RELATED_PAPERS)
      .map((item) => item.title.trim())
  } catch (error) {
    console.warn('[CSLab] 论文流水线：相关论文列表读取失败:', error)
    return []
  }
}

async function runPipelineOnce(labId: string, uri: string): Promise<void> {
  // ===== 阶段 1：结构富化（标题/作者/摘要/DOI/章节/公式/表格/图表块），重建推迟 =====
  try {
    await enrichLiteratureInBackground(labId, uri, { deferIndexRebuild: true })
  } catch (error) {
    console.warn(`[CSLab] 论文流水线：结构富化失败 (${uri}):`, error)
  }
  const structure = await getLiteratureStructure(labId, uri)
  if (!structure) {
    // 结构不可用仍调度重建（BM25/社群索引不依赖结构 sidecar），保持入库可检索。
    scheduleRebuild(labId)
    return
  }

  const paperSlug = sanitizeNoteDirName(structure.title) || uri.split('/').pop() || 'paper'

  // ===== 阶段 2：实证解析（PDF 内嵌图像直提 + 表格指标抽取）=====
  let figureAssets: PaperFigureAsset[] = []
  let metrics: EmpiricalMetric[] = []
  try {
    const pdfBytes = await readLiteratureBuffer(labId, uri, MAX_PDF_BYTES)
    if (pdfBytes) {
      const figureBlocks: FigureBlock[] = (structure.figures ?? []).map((figure) => ({
        pageNumber: figure.page,
        bbox: figure.bbox,
        caption: figure.caption,
      }))
      figureAssets = await extractPaperFigures({ labId, paperSlug, pdfBytes, figureBlocks })
    }
    for (const table of structure.tables) {
      metrics.push(...parseEmpiricalMetricsFromMarkdown(table.markdown, table.page))
    }
  } catch (error) {
    console.warn(`[CSLab] 论文流水线：实证解析失败 (${uri}):`, error)
  }

  // ===== 阶段 3：语义增强（LLM 严格 schema；缺席/失败回退确定性解析）=====
  let enrichment: PaperSemanticEnrichment = {
    taxonomy: [],
    conceptGraph: { concepts: [], methods: [] },
    protocols: [],
    references: [],
    enrichmentSource: 'deterministic',
  }
  try {
    enrichment = await enrichPaperSemantics({
      title: structure.title,
      abstract: structure.abstract,
      keywords: structure.keywords,
      sections: structure.sections,
      referencesText: pickReferencesText(structure),
      tablesMarkdown: structure.tables.map((table) => table.markdown).join('\n\n'),
    })
  } catch (error) {
    console.warn(`[CSLab] 论文流水线：语义增强失败 (${uri}):`, error)
  }

  // ===== 阶段 4：Obsidian Vault 五文件束合成 =====
  try {
    const result = await synthesizePaperVault({
      labId,
      uri,
      paperSlug,
      title: structure.title,
      authors: structure.authors,
      doi: structure.doi,
      venue: structure.publication,
      year: structure.year,
      abstract: structure.abstract,
      taxonomy: enrichment.taxonomy,
      conceptGraph: enrichment.conceptGraph,
      protocols: enrichment.protocols,
      metrics,
      figureAssets,
      references: enrichment.references,
      relatedPaperTitles: pickRelatedPaperTitles(labId, uri),
    })
    if (!result.ok) {
      console.warn(`[CSLab] 论文流水线：Vault 合成未完成 (${uri}): ${result.message}`)
    }
  } catch (error) {
    console.warn(`[CSLab] 论文流水线：Vault 合成失败 (${uri}):`, error)
  }

  // ===== 阶段 5：分层 3D 拓扑构建（宏观/中观/微观 Z 分层）并原子落盘 =====
  try {
    saveTopology(
      labId,
      buildPaperTopology({
        uri,
        title: structure.title,
        authors: structure.authors,
        venue: structure.publication,
        year: structure.year,
        taxonomy: enrichment.taxonomy,
        conceptGraph: enrichment.conceptGraph,
        protocols: enrichment.protocols,
        metrics,
        figureAssets,
        references: enrichment.references,
      }),
    )
  } catch (error) {
    console.warn(`[CSLab] 论文流水线：3D 拓扑构建失败 (${uri}):`, error)
  }

  // ===== 收尾：统一调度 GraphRAG 索引重建（防抖单飞）+ 非侵入事件 =====
  scheduleRebuild(labId)
  try {
    broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_ASSET_CHANGED, {
      labId,
      uri,
      kind: 'updated',
    })
  } catch (error) {
    console.warn('[CSLab] 论文流水线：完成事件广播失败:', error)
  }
}

function scheduleRebuild(labId: string): void {
  void import('./cslab-graphrag-router')
    .then((module) => module.scheduleLiteratureIndexRebuild(labId))
    .catch((error) => console.warn('[CSLab] 论文流水线：索引重建调度失败:', error))
}
