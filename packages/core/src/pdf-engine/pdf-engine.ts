/**
 * 顶层调度管道（Pipeline Facade）
 *
 * 串联：图元提取 → TrapDoc 过滤 → 几何分段 → Category D 对齐 → Category C 表格重构
 *       → 学术增强 → Category B 最大悔标排序 → 双层序列化。
 *
 * 对外只暴露一个 `parsePdfDocument(buffer, options)`，返回全要素文档 AST；
 * 任何阶段失败都由调用方（document-parser）捕获并回退传统解析，不在此处吞异常。
 */

import type { DocumentLayoutAST, DocumentLayoutPage } from '@profer/shared'
import { normalizePointBBox } from '@profer/shared'
import type { LayoutNode, PdfEngineOptions, PdfPageGeometry } from './types'
import { toDocumentLayoutBlock } from './types'
import { extractPdfGeometry } from './pdf-stream-extractor'
import { filterGhostGlyphs } from './trapdoc-guard'
import { segmentPageIntoBoxes } from './native-segmenter'
import { alignGlyphsToBoxes } from './source-preserving-aligner'
import { decomposeTable } from './table-decomposer'
import { enrichAcademicNodes } from './academic-enricher'
import { columnIndexOf, detectColumnLayout, solveMaxRegretReadingOrder } from './max-regret-router'
import { finalizeAstText } from './document-serializer'

/** 单页对齐 + 路由的中间统计 */
interface PageProcessResult {
  page: DocumentLayoutPage
  orderedMainFlow: LayoutNode[]
  alignmentMs: number
  maxRegretSortMs: number
  tableParseMs: number
}

/** 处理单个页面 */
function processPage(
  geometry: PdfPageGeometry,
): PageProcessResult {
  const { pageNumber, width, height } = geometry

  // 1. TrapDoc 幽灵字符拦截
  const { glyphs: cleanGlyphs, filteredCount } = filterGhostGlyphs(geometry.glyphs, {
    pageWidth: width,
    pageHeight: height,
  })

  // 2. 几何分段 → 候选框
  const boxes = segmentPageIntoBoxes({
    glyphs: cleanGlyphs,
    vectorLines: geometry.vectorLines,
    pageWidth: width,
    pageHeight: height,
    pageNumber,
  })

  // 3. Category D 源保持对齐
  const alignStart = Date.now()
  const groups = alignGlyphsToBoxes(
    cleanGlyphs,
    boxes.map((box) => ({ id: box.id, bbox: box.bbox })),
  )
  const alignmentMs = Date.now() - alignStart

  const boxById = new Map(boxes.map((box) => [box.id, box]))

  // 4. 组装节点（表格走 Category C 重构）
  let tableParseMs = 0
  const nodes: LayoutNode[] = []
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
    })
  }

  // 5. 学术增强（页眉页脚/脚注/公式/标题级别）
  enrichAcademicNodes(nodes, { pageWidth: width, pageHeight: height, pageNumber })

  // 6. Category B 最大悔标排序（仅主正文流）
  const mainFlow = nodes.filter((node) => node.readingStreamId >= 0)
  const sortStart = Date.now()
  const orderedMainFlow = solveMaxRegretReadingOrder(mainFlow)
  const maxRegretSortMs = Date.now() - sortStart

  // 7. 回填栏归属
  const columns = detectColumnLayout(mainFlow)
  for (const node of mainFlow) {
    node.readingStreamId = columnIndexOf(node, columns)
  }

  const page: DocumentLayoutPage = {
    pageNumber,
    width,
    height,
    columnCount: columns.columnCount,
    blocks: nodes.map(toDocumentLayoutBlock),
    trappedTokensFiltered: filteredCount,
  }

  return { page, orderedMainFlow, alignmentMs, maxRegretSortMs, tableParseMs }
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

  const extraction = await extractPdfGeometry(buffer, { maxPages: options.maxPages })

  const pages: DocumentLayoutPage[] = []
  const orderedBlocks: LayoutNode[] = []
  let alignmentMs = 0
  let maxRegretSortMs = 0
  let tableParseMs = 0
  let trapDocFilteredCount = 0

  for (const geometry of extraction.pages) {
    const result = processPage(geometry)
    pages.push(result.page)
    orderedBlocks.push(...result.orderedMainFlow)
    alignmentMs += result.alignmentMs
    maxRegretSortMs += result.maxRegretSortMs
    tableParseMs += result.tableParseMs
    trapDocFilteredCount += result.page.trappedTokensFiltered
  }

  // 全局阅读顺序索引
  orderedBlocks.forEach((node, index) => {
    node.readingOrderIndex = index
  })

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
    },
  }

  return finalizeAstText(ast)
}
