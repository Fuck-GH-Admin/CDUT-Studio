/**
 * 顶层调度管道（Pipeline Facade）
 *
 * 串联：图元提取 → TrapDoc 过滤 → 几何分段 → Category D 对齐 → Category C 表格重构
 *       → 学术增强 → 水平分带拓扑 + Category B 最大悔标排序 → 公式视觉兜底 → 双层序列化。
 *
 * 对外只暴露一个 `parsePdfDocument(buffer, options)`，返回全要素文档 AST；
 * 任何阶段失败都由调用方（document-parser）捕获并回退传统解析，不在此处吞异常。
 *
 * 失败即如实降级：OCR 端口不可用、视觉识别失败、几何逆求失败——
 * 一律回落纯几何路径并写入 metrics，绝不伪造识别结果，绝不让主流程崩溃。
 */

import type { DocumentLayoutAST, DocumentLayoutPage, PdfParseAccuracy } from '@profer/shared'
import { normalizePointBBox } from '@profer/shared'
import type {
  FormulaModeConfig,
  LayoutNode,
  NativeMathTag,
  PdfEngineOptions,
  PdfPageGeometry,
} from './types'
import { FORMULA_MODE_DEFAULT, toDocumentLayoutBlock } from './types'
import { extractPdfGeometry } from './pdf-stream-extractor'
import { filterGhostGlyphs } from './trapdoc-guard'
import { segmentPageIntoBoxes } from './native-segmenter'
import { alignGlyphsToBoxes } from './source-preserving-aligner'
import { decomposeTable } from './table-decomposer'
import { enrichAcademicNodes } from './academic-enricher'
import { analyzePageTopology } from './max-regret-router'
import { bridgeRegionToOcr } from './ocr-bridge'
import { finalizeAstText } from './document-serializer'

/**
 * 用户准度档位 → 公式解析配置。
 *
 * 三档对应「快速 / 均衡 / 精细」大白话选项（见 shared 的 PDF_PARSE_ACCURACY_OPTIONS）。
 */
export function resolveFormulaMode(accuracy: PdfParseAccuracy): FormulaModeConfig {
  switch (accuracy) {
    case 'fast':
      return { enableFormulaOcr: false, complexityThreshold: Number.POSITIVE_INFINITY, maxFormulaOcrCalls: 0 }
    case 'thorough':
      return { enableFormulaOcr: true, complexityThreshold: 1.8, maxFormulaOcrCalls: 60 }
    case 'balanced':
    default:
      return { ...FORMULA_MODE_DEFAULT }
  }
}

/** 单页处理的中间统计 */
interface PageProcessResult {
  page: DocumentLayoutPage
  orderedMainFlow: LayoutNode[]
  alignmentMs: number
  maxRegretSortMs: number
  tableParseMs: number
  bandCount: number
  ocrRecognized: number
  ocrUnavailable: number
}

interface PageProcessContext {
  formulaMode: FormulaModeConfig
  ocrPorts: PdfEngineOptions['ocrPorts']
  pdfPath?: string
  nativeMathTags?: readonly NativeMathTag[]
  /** 公式视觉识别剩余配额（跨页共享） */
  formulaBudget: { remaining: number; calls: number; skipped: number; fromPix2Text: number }
}

/** 处理单个页面 */
async function processPage(
  geometry: PdfPageGeometry,
  ctx: PageProcessContext,
): Promise<PageProcessResult> {
  const { pageNumber, width, height } = geometry

  // 1. TrapDoc 幽灵字符拦截
  const { glyphs: cleanGlyphs, filteredCount } = filterGhostGlyphs(geometry.glyphs, {
    pageWidth: width,
    pageHeight: height,
  })

  // 2. 降级页（纯扫描 / ToUnicode 乱码）：优先走本地学术 OCR 整页重构
  const health = geometry.health
  const degraded = health?.isPageDegraded === true
  let nodes: LayoutNode[] = []
  let tableParseMs = 0
  let alignmentMs = 0
  let ocrRecognized = 0
  let ocrUnavailable = 0

  if (degraded && ctx.pdfPath) {
    const mapping = await bridgeRegionToOcr({
      pdfPath: ctx.pdfPath,
      pageNumber,
      regionBBox: [0, 0, 1, 1],
      kind: 'text',
      port: ctx.ocrPorts?.region,
      pageWidth: width,
      pageHeight: height,
    })
    if (mapping.performed && mapping.nodes.length > 0) {
      nodes = mapping.nodes
      ocrRecognized = 1
    } else {
      // 端口不可用 / 识别失败：如实记账，回落几何分段
      ocrUnavailable = 1
      console.warn(
        `[PDF引擎] 第 ${pageNumber} 页为降级页（${health?.reason ?? 'unknown'}），OCR 降级不可用：${mapping.reason ?? '未知原因'}`,
      )
    }
  }

  if (nodes.length === 0) {
    const alignStart = Date.now()
    // 3. 几何分段 → 候选框
    const boxes = segmentPageIntoBoxes({
      glyphs: cleanGlyphs,
      vectorLines: geometry.vectorLines,
      pageWidth: width,
      pageHeight: height,
      pageNumber,
    })

    // 4. Category D 源保持对齐
    const groups = alignGlyphsToBoxes(
      cleanGlyphs,
      boxes.map((box) => ({ id: box.id, bbox: box.bbox })),
    )
    alignmentMs = Date.now() - alignStart

    const boxById = new Map(boxes.map((box) => [box.id, box]))

    // 5. 组装节点（表格走 Category C 重构）
    for (const group of groups) {
      const box = boxById.get(group.boxId)
      if (!box) continue
      const text = group.text.replace(/\s+/g, ' ').trim()
      const pointBbox = group.bbox ?? box.bbox

      if (box.kindHint === 'table') {
        const tableStart = Date.now()
        const structure = decomposeTable({
          region: box.bbox,
          glyphs: group.glyphs,
          vectorLines: geometry.vectorLines,
          pageWidth: width,
          pageHeight: height,
        })
        tableParseMs += Date.now() - tableStart
        nodes.push({
          id: box.id,
          pageNumber,
          kind: 'table',
          text: structure.markdown,
          bbox: normalizePointBBox(pointBbox, width, height),
          pointBbox,
          confidence: 0.85,
          readingStreamId: 0,
          readingOrderIndex: 0,
          fontSize: box.fontSize,
          glyphs: group.glyphs,
          table: structure,
        })
        continue
      }

      if (text.length === 0) continue

      nodes.push({
        id: box.id,
        pageNumber,
        kind: box.kindHint,
        text,
        bbox: normalizePointBBox(pointBbox, width, height),
        pointBbox,
        confidence: 0.9,
        readingStreamId: 0,
        readingOrderIndex: 0,
        fontSize: box.fontSize,
        // 保留逐字形几何：行内公式与上下标逆求完全依赖它
        glyphs: group.glyphs,
      })
    }
  }

  // 6. 学术增强（页眉页脚/脚注/公式/标题级别/行内公式）
  //    注意：页眉页脚的剥离发生在 analyzePageTopology 之前，避免污染分带与投影聚类
  enrichAcademicNodes(nodes, {
    pageWidth: width,
    pageHeight: height,
    pageNumber,
    vectorLines: geometry.vectorLines,
    bodyFontSize: undefined,
    nativeMathTags: ctx.nativeMathTags,
  })

  // 7. 公式视觉兜底（仅高复杂度 + 用户准度允许 + 配额未尽）
  await applyFormulaOcrFallback(nodes, ctx)

  // 8. 水平分带拓扑 + Category B 最大悔标排序（仅主正文流）
  const mainFlow = nodes.filter((node) => node.readingStreamId >= 0)
  const sortStart = Date.now()
  const topology = analyzePageTopology(mainFlow)
  const maxRegretSortMs = Date.now() - sortStart

  const page: DocumentLayoutPage = {
    pageNumber,
    width,
    height,
    columnCount: topology.bands.reduce((acc, band) => Math.max(acc, band.columnCount), 1),
    blocks: nodes.map(toDocumentLayoutBlock),
    trappedTokensFiltered: filteredCount,
  }

  return {
    page,
    orderedMainFlow: topology.ordered,
    alignmentMs,
    maxRegretSortMs,
    tableParseMs,
    bandCount: topology.bands.length,
    ocrRecognized,
    ocrUnavailable,
  }
}

/**
 * 高复杂度公式的视觉识别兜底。
 *
 * 只在「用户准度允许 + 判定为 high + 配额未尽 + 已提供文档路径」时调用；
 * 失败或超配额即跳过并记账，绝不伪造 LaTeX。
 */
async function applyFormulaOcrFallback(
  nodes: readonly LayoutNode[],
  ctx: PageProcessContext,
): Promise<void> {
  const budget = ctx.formulaBudget
  const port = ctx.ocrPorts?.formula
  for (const node of nodes) {
    if (node.kind !== 'equation' || !node.equation) continue
    if (node.equation.complexity !== 'high') continue

    if (!ctx.formulaMode.enableFormulaOcr || !ctx.pdfPath || !port || !port.available) {
      budget.skipped += 1
      continue
    }
    if (budget.remaining <= 0) {
      budget.skipped += 1
      continue
    }

    budget.remaining -= 1
    budget.calls += 1
    try {
      const result = await port.recognizeFormula({
        pdfPath: ctx.pdfPath,
        pageNumber: node.pageNumber,
        regionBBox: node.bbox,
      })
      if (result.ok && result.latex && result.latex.trim()) {
        node.equation.latex = result.latex.trim()
        node.equation.source = 'pix2text'
        budget.fromPix2Text += 1
      } else {
        budget.skipped += 1
      }
    } catch (error) {
      budget.skipped += 1
      console.warn('[PDF引擎] 公式视觉识别失败，回落几何结果:', error)
    }
  }
}

/**
 * 解析 PDF 文档为全要素 AST。
 *
 * @param buffer PDF 字节
 * @param options 引擎配置
 */
export async function parsePdfDocument(
  buffer: Uint8Array | ArrayBuffer,
  options: PdfEngineOptions = {},
): Promise<DocumentLayoutAST> {
  const fileName = options.fileName ?? 'document.pdf'
  const totalStart = Date.now()
  const formulaMode = options.formulaMode ?? FORMULA_MODE_DEFAULT

  const extraction = await extractPdfGeometry(buffer, { maxPages: options.maxPages })
  const nativeMathTags = options.nativeMathTags ?? extraction.nativeMathTags ?? []

  const pages: DocumentLayoutPage[] = []
  const orderedBlocks: LayoutNode[] = []
  let alignmentMs = 0
  let maxRegretSortMs = 0
  let tableParseMs = 0
  let trapDocFilteredCount = 0
  let bandCount = 0
  let ocrRecognizedPages = 0
  let ocrUnavailablePages = 0

  const formulaBudget = {
    remaining: formulaMode.maxFormulaOcrCalls,
    calls: 0,
    skipped: 0,
    fromPix2Text: 0,
  }

  const ctx: PageProcessContext = {
    formulaMode,
    ocrPorts: options.ocrPorts,
    pdfPath: options.pdfPath,
    nativeMathTags,
    formulaBudget,
  }

  for (const geometry of extraction.pages) {
    const result = await processPage(geometry, ctx)
    pages.push(result.page)
    orderedBlocks.push(...result.orderedMainFlow)
    alignmentMs += result.alignmentMs
    maxRegretSortMs += result.maxRegretSortMs
    tableParseMs += result.tableParseMs
    trapDocFilteredCount += result.page.trappedTokensFiltered
    bandCount += result.bandCount
    ocrRecognizedPages += result.ocrRecognized
    ocrUnavailablePages += result.ocrUnavailable
  }

  // 全局阅读顺序索引
  orderedBlocks.forEach((node, index) => {
    node.readingOrderIndex = index
  })

  // 公式来源分账
  let mathFromNative = 0
  let mathFromGeometric = 0
  for (const node of orderedBlocks) {
    if (node.kind !== 'equation' || !node.equation) continue
    if (node.equation.source === 'native') mathFromNative += 1
    else if (node.equation.source === 'geometric') mathFromGeometric += 1
  }

  const ast: DocumentLayoutAST = {
    fileName,
    pageCount: extraction.pageCount,
    pages,
    readingOrderedBlocks: orderedBlocks.map(toDocumentLayoutBlock),
    outline: [],
    markdown: '',
    metrics: {
      totalExtractionMs: Date.now() - totalStart,
      alignmentMs,
      maxRegretSortMs,
      tableParseMs,
      trapDocFilteredCount,
      formulaOcrCalls: formulaBudget.calls,
      formulaOcrSkipped: formulaBudget.skipped,
      ocrRecognizedPages,
      ocrUnavailablePages,
      nativeMathTagCount: nativeMathTags.length,
      mathFromNative,
      mathFromGeometric,
      mathFromPix2Text: formulaBudget.fromPix2Text,
      bandCount,
    },
  }

  return finalizeAstText(ast)
}
