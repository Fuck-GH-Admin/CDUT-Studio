/**
 * ocr-engine.ts — 100% 纯本地离线 OCR 引擎（图片 / 无文本层扫描件纯化）
 *
 * 红线约束：
 *   - 绝对不向任何云端上传原始图片；识别全程在本地 CPU 完成；
 *   - 依赖探测采用「诚实降级」：本机缺少 tesseract.js 或语言包时返回 null，
 *     由调用方如实标注不可用，绝不用猜测内容冒充识别结果。
 *
 * 版面启发式重构：
 *   - 依据行高与纵向间距判定标题 / 段落；
 *   - 字号显著较大或命中「第一章 / 1.1 / 一、」等序号正则的行判为 Heading 并补 `#`；
 *   - 行间距过近的断行合并为连续段落，行间距较大的保留分段。
 */

/** Tesseract.js 最小结构（避免引入类型依赖） */
interface TesseractBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface TesseractWord {
  text?: string
  bbox: TesseractBBox
  confidence?: number
}
interface TesseractLine {
  text?: string
  bbox?: TesseractBBox
  words?: TesseractWord[]
}
interface TesseractPageData {
  text?: string
  lines?: TesseractLine[]
  words?: TesseractWord[]
}
interface TesseractRecognizeResult {
  data?: TesseractPageData
}
interface TesseractModule {
  recognize(image: string, langs: string, options?: Record<string, unknown>): Promise<TesseractRecognizeResult>
}

/** 依赖探测缓存：只探测一次 */
let tesseractModulePromise: Promise<TesseractModule | null> | null = null

/** 探测 tesseract.js 是否可加载（失败返回 null，不抛出） */
async function loadTesseract(): Promise<TesseractModule | null> {
  if (!tesseractModulePromise) {
    tesseractModulePromise = (async () => {
      try {
        // 动态说明符：tesseract.js 为可选依赖，缺失时业务走降级路径
        const specifier = 'tesseract.js'
        const mod = (await import(specifier)) as unknown as { default?: TesseractModule } & TesseractModule
        const resolved = (mod.default ?? mod) as TesseractModule
        return typeof resolved.recognize === 'function' ? resolved : null
      } catch {
        return null
      }
    })()
  }
  return tesseractModulePromise
}

/** 单行 OCR 结果（附带版面几何信息） */
interface OcrLine {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  height: number
  centerY: number
}

/** 从识别结果提取文本行（优先 lines，缺失时按 words 纵向聚合） */
function extractLines(page: TesseractPageData): OcrLine[] {
  const lines: OcrLine[] = []
  const pushLine = (text: string, box: TesseractBBox): void => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return
    lines.push({
      text: normalized,
      x0: box.x0,
      y0: box.y0,
      x1: box.x1,
      y1: box.y1,
      height: Math.max(1, box.y1 - box.y0),
      centerY: (box.y0 + box.y1) / 2,
    })
  }

  if (page.lines && page.lines.length > 0) {
    for (const line of page.lines) {
      const words = line.words ?? []
      const text = line.text ?? words.map((word) => word.text ?? '').join('')
      const box = line.bbox ?? unionBBox(words.map((word) => word.bbox))
      if (box) pushLine(text, box)
    }
    return lines.sort((a, b) => a.centerY - b.centerY)
  }

  // 兜底：按 words 的纵向位置聚合为行
  const words = (page.words ?? []).filter((word) => (word.text ?? '').trim().length > 0)
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  let group: TesseractWord[] = []
  let groupY = Number.NaN
  const flush = (): void => {
    if (group.length === 0) return
    const box = unionBBox(group.map((word) => word.bbox))
    if (box) pushLine(group.map((word) => word.text ?? '').join(''), box)
    group = []
  }
  for (const word of sorted) {
    const tolerance = Math.max(6, (word.bbox.y1 - word.bbox.y0) * 0.6)
    if (Number.isNaN(groupY) || Math.abs(word.bbox.y0 - groupY) <= tolerance) {
      group.push(word)
      groupY = Number.isNaN(groupY) ? word.bbox.y0 : (groupY + word.bbox.y0) / 2
    } else {
      flush()
      group = [word]
      groupY = word.bbox.y0
    }
  }
  flush()
  return lines.sort((a, b) => a.centerY - b.centerY)
}

function unionBBox(boxes: TesseractBBox[]): TesseractBBox | null {
  const valid = boxes.filter((box) => box && Number.isFinite(box.x0))
  if (valid.length === 0) return null
  return {
    x0: Math.min(...valid.map((box) => box.x0)),
    y0: Math.min(...valid.map((box) => box.y0)),
    x1: Math.max(...valid.map((box) => box.x1)),
    y1: Math.max(...valid.map((box) => box.y1)),
  }
}

/** 序号标题识别（第一章 / 1.1 / 一、 / （一）等，排除普通陈述句与数量/年份行） */
function looksLikeHeading(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 60 || /[。！？；]$/.test(trimmed)) return false
  return (
    /^第\s*[0-9一二三四五六七八九十百零两]+\s*[章节讲篇部]/.test(trimmed) ||
    /^\d+(?:\.\d+)+(?:\s*[\s、.．:：]|\s+)(?![年月日万亿个条项名人元点%度是为])\S/.test(trimmed) ||
    /^[一二三四五六七八九十]+[、.．]/.test(trimmed) ||
    /^[（(][一二三四五六七八九十0-9]+[）)]\s*(?![年月日万亿个条项名人元点%度是为])\S/.test(trimmed)
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * 版面启发式重构：把带几何信息的 OCR 行还原为 Markdown 段落与标题。
 */
export function reconstructMarkdownFromLines(lines: OcrLine[]): string {
  if (lines.length === 0) return ''
  const medianHeight = median(lines.map((line) => line.height)) || 1
  const blocks: string[] = []
  let paragraph: string[] = []
  let lastY1 = Number.NaN

  const flushParagraph = (): void => {
    const text = paragraph.join('').trim()
    if (text) blocks.push(text)
    paragraph = []
  }

  for (const line of lines) {
    const isHeading = line.height >= medianHeight * 1.25 || looksLikeHeading(line.text)
    const gap = Number.isNaN(lastY1) ? Infinity : line.y0 - lastY1
    const newParagraph = gap > medianHeight * 0.6
    if (isHeading) {
      flushParagraph()
      blocks.push(`## ${line.text}`)
      lastY1 = line.y1
      continue
    }
    if (newParagraph && paragraph.length > 0) flushParagraph()
    paragraph.push(line.text)
    lastY1 = line.y1
  }
  flushParagraph()

  return blocks.join('\n\n')
}

/**
 * 对单张图片 / 扫描页执行本地 OCR 并重构为 Markdown。
 *
 * @returns 成功返回 Markdown 纯文本；依赖缺失或识别失败返回 null（如实降级）
 */
export async function ocrImageToMarkdown(filePath: string): Promise<string | null> {
  const mod = await loadTesseract()
  if (!mod) {
    console.warn('[速课堂OCR] 本地 OCR 运行时不可用（tesseract.js 未安装），降级处理')
    return null
  }
  try {
    const result = await mod.recognize(filePath, 'chi_sim+eng')
    const page = result.data ?? {}
    const lines = extractLines(page)
    if (lines.length === 0) {
      const text = (page.text ?? '').trim()
      return text ? text : null
    }
    const markdown = reconstructMarkdownFromLines(lines)
    return markdown.trim() ? markdown : null
  } catch (error) {
    console.warn('[速课堂OCR] 本地 OCR 识别失败，降级处理:', error)
    return null
  }
}
