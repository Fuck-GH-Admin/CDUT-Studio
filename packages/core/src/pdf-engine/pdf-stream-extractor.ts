/**
 * 基于 pdfjs-dist 的字符流与矢量指令提取器
 *
 * 职责：把 PDF 字节流解析为「页面级几何图元」——逐字符的绝对坐标框 + 页面矢量线段。
 * 这是 Category D「源保持对齐」的原材料：后续所有文本都从原始字符流反查得到，
 * 不经过 OCR 二次生成，从根上消除字符级拼写幻觉。
 *
 * 依赖加载：pdfjs-dist 以「非字面量说明符」动态 import，避免被渲染进程打包器静态解析
 * （本模块只服务 Electron 主进程），未就绪时抛出可被上层捕获并回退的错误。
 *
 * 诚实声明：pdfjs 的 getTextContent 不暴露字符级 Tr 渲染模式与填充透明度，
 * 故默认按「可见」处理（renderingMode=0 / colorAlpha=1）；TrapDocGuard 仍会拦截
 * 零尺寸、越界、控制字符等类别。若未来接入原始算子流提取器，可填回真实可见性字段。
 */

import type { PdfGeometryExtractResult, PdfGlyphItem, PdfPageGeometry, VectorLine } from './types'

/** pdfjs 文本项（只声明用到的字段，避免绑定具体版本类型） */
interface PdfJsTextItem {
  str: string
  transform: number[]
  width: number
  height?: number
  fontName?: string
  hasEOL?: boolean
}

interface PdfJsPage {
  /** 页面可视区（cropBox ∩ mediaBox，用户空间 [x0, y0, x1, y1]） */
  view?: number[]
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] }
  getTextContent(): Promise<{ items: unknown[] }>
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
}

interface PdfJsDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfJsPage>
  destroy(): Promise<void> | void
}

interface PdfJsModule {
  Util: { transform(m1: number[], m2: number[]): number[] }
  OPS: Record<string, number>
  getDocument(src: {
    data: Uint8Array
    disableFontFace?: boolean
    isEvalSupported?: boolean
    useWorkerFetch?: boolean
  }): { promise: Promise<PdfJsDocument> }
}

function isPdfJsTextItem(item: unknown): item is PdfJsTextItem {
  return (
    typeof item === 'object'
    && item !== null
    && 'str' in item
    && typeof (item as { str: unknown }).str === 'string'
    && 'transform' in item
    && Array.isArray((item as { transform: unknown }).transform)
  )
}

/** 动态加载 pdfjs-dist legacy 构建（主进程可用） */
async function loadPdfJs(): Promise<PdfJsModule> {
  // 非字面量说明符：阻止打包器静态解析，交由运行时 Node 解析
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs'
  const mod = (await import(specifier)) as unknown as PdfJsModule
  if (!mod || typeof mod.getDocument !== 'function') {
    throw new Error('pdfjs-dist 加载失败：缺少 getDocument 接口')
  }
  return mod
}

/**
 * 估算单个字符的相对排版宽度权重：全角/宽字符（CJK、假名、谚文、全角形式）按 2 个半角位计，
 * 其余（拉丁字母、数字、半角标点）按 1 计。用于混排行按比例分配总宽，替代均匀切分。
 */
function estimateCharWidthWeight(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) || // 谚文 Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首 · 标点 · 假名 · 注音
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII 与符号
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B 及以后
  ) {
    return 2
  }
  return 1
}

/** 把一个 pdfjs 文本项切分为逐字符图元（宽度按字符类别比例分配，中英混排不再均匀近似） */
function toGlyphs(
  item: PdfJsTextItem,
  pdfjs: PdfJsModule,
  viewportTransform: number[],
  viewportWidth: number,
  viewportHeight: number,
): PdfGlyphItem[] {
  // 用页面视口变换把文本矩阵映射到设备空间（左上角原点，y 向下）
  const tx = pdfjs.Util.transform(viewportTransform, item.transform)
  const fontHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || item.height || 0
  const left = tx[4] ?? 0
  const baseline = tx[5] ?? 0
  const top = baseline - fontHeight
  const totalWidth = item.width
  const chars = Array.from(item.str)
  if (chars.length === 0) return []

  // 字符类别比例分配：全角字占 2 份、半角字占 1 份（全半角同行时与均匀切分显著不同）
  const weights = chars.map(estimateCharWidthWeight)
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || chars.length
  const charWidths = weights.map((w) => (totalWidth * w) / totalWeight)

  const glyphs: PdfGlyphItem[] = []
  let cursor = left
  for (let index = 0; index < chars.length; index += 1) {
    const charWidth = charWidths[index] ?? totalWidth / chars.length
    const charLeft = cursor
    const charRight = charLeft + charWidth
    cursor = charRight
    const bbox: PdfGlyphItem['bbox'] = [charLeft, top, charRight, baseline]
    glyphs.push({
      char: chars[index] ?? '',
      fontName: item.fontName ?? 'unknown',
      fontSize: fontHeight,
      originX: charLeft,
      originY: baseline,
      width: charWidth,
      height: fontHeight,
      bbox,
      renderingMode: 0,
      colorAlpha: 1,
      isOutOfCanvas:
        charRight < 0 || baseline < 0 || charLeft > viewportWidth || top > viewportHeight,
    })
  }
  return glyphs
}

/** 用户空间点 → 设备空间点（左上角原点，y 向下） */
function transformPoint(pdfjs: PdfJsModule, viewport: { transform: number[] }, x: number, y: number): { x: number; y: number } {
  const tx = pdfjs.Util.transform(viewport.transform, [1, 0, 0, 1, x, y])
  return { x: tx[4] ?? 0, y: tx[5] ?? 0 }
}

/** 从绘制指令中尽力提取水平/垂直线段（失败则返回空数组，不阻塞主流程） */
async function extractVectorLines(page: PdfJsPage, pdfjs: PdfJsModule): Promise<VectorLine[]> {
  try {
    const { fnArray, argsArray } = await page.getOperatorList()
    const OPS = pdfjs.OPS
    if (!OPS || typeof OPS.moveTo !== 'number') return []
    const viewport = page.getViewport({ scale: 1 })
    const lines: VectorLine[] = []

    const pushSegment = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      if (length < 2) return
      const isHorizontal = Math.abs(dy) <= Math.max(1, Math.abs(dx) * 0.02)
      const isVertical = Math.abs(dx) <= Math.max(1, Math.abs(dy) * 0.02)
      if (!isHorizontal && !isVertical) return
      lines.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, isHorizontal, thickness: 1 })
    }

    for (let opIndex = 0; opIndex < fnArray.length; opIndex += 1) {
      const fn = fnArray[opIndex]
      const rawArgs = argsArray[opIndex]
      if (!rawArgs || !Array.isArray(rawArgs)) continue

      if (fn === OPS.rectangle) {
        const x = rawArgs[0] as number
        const y = rawArgs[1] as number
        const w = rawArgs[2] as number
        const h = rawArgs[3] as number
        if ([x, y, w, h].some((v) => typeof v !== 'number')) continue
        const corners = [
          transformPoint(pdfjs, viewport, x, y),
          transformPoint(pdfjs, viewport, x + w, y),
          transformPoint(pdfjs, viewport, x + w, y + h),
          transformPoint(pdfjs, viewport, x, y + h),
        ]
        for (let i = 0; i < 4; i += 1) {
          pushSegment(corners[i]!, corners[(i + 1) % 4]!)
        }
        continue
      }

      if (fn === OPS.constructPath) {
        const ops = rawArgs[0] as unknown
        const coords = rawArgs[1] as unknown
        if (!Array.isArray(ops) || !Array.isArray(coords)) continue
        let argPointer = 0
        let current: { x: number; y: number } | null = null
        for (const subOp of ops as number[]) {
          if (subOp === OPS.moveTo || subOp === OPS.lineTo) {
            const px = coords[argPointer] as number
            const py = coords[argPointer + 1] as number
            argPointer += 2
            if (typeof px !== 'number' || typeof py !== 'number') break
            const point = transformPoint(pdfjs, viewport, px, py)
            if (subOp === OPS.lineTo && current) pushSegment(current, point)
            current = point
          } else if (subOp === OPS.rectangle) {
            const px = coords[argPointer] as number
            const py = coords[argPointer + 1] as number
            const pw = coords[argPointer + 2] as number
            const ph = coords[argPointer + 3] as number
            argPointer += 4
            if ([px, py, pw, ph].some((v) => typeof v !== 'number')) break
            const corners = [
              transformPoint(pdfjs, viewport, px, py),
              transformPoint(pdfjs, viewport, px + pw, py),
              transformPoint(pdfjs, viewport, px + pw, py + ph),
              transformPoint(pdfjs, viewport, px, py + ph),
            ]
            for (let i = 0; i < 4; i += 1) pushSegment(corners[i]!, corners[(i + 1) % 4]!)
            current = corners[0] ?? null
          } else if (subOp === OPS.curveTo) {
            argPointer += 6
            current = null
          } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
            argPointer += 4
            current = null
          } else if (subOp === OPS.closePath) {
            current = null
          }
        }
      }
    }

    return lines
  } catch {
    // 矢量提取为增强项：任何结构差异都不应中断解析主链路
    return []
  }
}

export interface ExtractGeometryOptions {
  /** 最大页数（1 起），缺省解析全部 */
  maxPages?: number
}

/**
 * 提取整份 PDF 的页面几何图元。
 *
 * @param buffer PDF 字节
 * @param options 提取选项
 */
export async function extractPdfGeometry(
  buffer: Uint8Array | ArrayBuffer,
  options: ExtractGeometryOptions = {},
): Promise<PdfGeometryExtractResult> {
  const start = Date.now()
  const pdfjs = await loadPdfJs()
  // 统一为纯 Uint8Array 视图（Node Buffer 是子类，pdfjs 会对此告警）
  const data = buffer instanceof Uint8Array
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)

  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  })
  const pdf = await loadingTask.promise

  try {
    const limit = options.maxPages && options.maxPages > 0
      ? Math.min(options.maxPages, pdf.numPages)
      : pdf.numPages
    const pages: PdfPageGeometry[] = []

    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      // cropBox 语义对齐：pdfjs page.view 为 cropBox ∩ mediaBox 的用户空间可视区，
      // 视口变换已隐含其原点偏移；此处显式校验视口尺寸（异常时回退 cropBox 尺寸），
      // 保证字形/矢量线段的归一化坐标与渲染页原点一致
      const view = Array.isArray(page.view) && page.view.length === 4 ? page.view : undefined
      const cropWidth = view ? Math.abs((view[2] ?? 0) - (view[0] ?? 0)) : 0
      const cropHeight = view ? Math.abs((view[3] ?? 0) - (view[1] ?? 0)) : 0
      const pageWidth = Number.isFinite(viewport.width) && viewport.width > 0
        ? viewport.width
        : cropWidth > 0
          ? cropWidth
          : 612
      const pageHeight = Number.isFinite(viewport.height) && viewport.height > 0
        ? viewport.height
        : cropHeight > 0
          ? cropHeight
          : 792
      const content = await page.getTextContent()
      const glyphs: PdfGlyphItem[] = []
      for (const item of content.items) {
        if (!isPdfJsTextItem(item)) continue
        glyphs.push(...toGlyphs(item, pdfjs, viewport.transform, pageWidth, pageHeight))
      }
      const vectorLines = await extractVectorLines(page, pdfjs)
      pages.push({
        pageNumber,
        width: pageWidth,
        height: pageHeight,
        glyphs,
        vectorLines,
      })
    }

    return { pages, pageCount: pdf.numPages, extractMs: Date.now() - start }
  } finally {
    await pdf.destroy()
  }
}
