/**
 * 最小文本 PDF 生成器（仅用于演示实验室与解析测试）
 *
 * 生成 PDF 1.4、Helvetica 标准字体、多页纯文本，可被 pdfjs / @profer/core/pdf-engine 解析。
 * 不支持中文与嵌入字体；演示论文使用英文。
 */

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '')
}

function wrapLine(text: string, maxChars = 88): string[] {
  if (text.length <= maxChars) return [text]
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (`${current} ${word}`.length > maxChars) {
      lines.push(current)
      current = word
    } else {
      current += ` ${word}`
    }
  }
  if (current) lines.push(current)
  return lines
}

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 56
const TOP_Y = 786
const LINE_HEIGHT = 14
const LINES_PER_PAGE = 49

/**
 * 把按页组织的文本行编译为 PDF。
 *
 * 语法：以 `# ` 开头的行为标题（14pt，额外留白），用于演示/测试中让解析器
 * 能按字号与间距识别章节。其余行为正文 11pt。
 *
 * @param pages 每页一组文本行（空行用 '' 表示）
 */
export function buildTextPdf(pages: string[][]): Buffer {
  const inputPages = pages.length > 0 ? pages : [['']]
  const normalizedPages: string[][] = []

  for (const input of inputPages) {
    let y = TOP_Y
    let ops: string[] = []
    const flush = (): void => {
      if (ops.length > 0) {
        normalizedPages.push(ops)
        ops = []
      }
      y = TOP_Y
    }
    for (const rawLine of input) {
      const isHeading = rawLine.startsWith('# ')
      const text = (isHeading ? rawLine.slice(2) : rawLine).trim()
      if (!text) {
        // 空行是段落分隔信号：给足间距，避免分段器把相邻段落并成一块。
        y -= 30
        if (y < 60) flush()
        continue
      }
      if (isHeading) y -= 12
      for (const line of wrapLine(text)) {
        if (y < 60) flush()
        // 末尾空格保证跨行拼接时词间不被吞掉。
        ops.push(`BT /F1 ${isHeading ? 16 : 11} Tf 1 0 0 1 ${MARGIN_X} ${y} Tm (${escapePdfText(`${line} `)}) Tj ET`)
        y -= isHeading ? LINE_HEIGHT + 4 : LINE_HEIGHT
      }
      if (isHeading) y -= 18
    }
    flush()
  }
  if (normalizedPages.length === 0) normalizedPages.push([])

  const pageContents = normalizedPages.map((lines) => lines.join('\n'))

  const objects: string[] = []
  const pageObjectIds = normalizedPages.map((_, index) => 4 + index * 2)
  const fontObjectId = 3
  const pagesObjectId = 2
  const catalogObjectId = 1

  objects[catalogObjectId] = `<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`
  objects[pagesObjectId] = `<< /Type /Pages /Count ${normalizedPages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  objects[fontObjectId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  normalizedPages.forEach((_, index) => {
    const pageId = pageObjectIds[index]!
    const contentId = pageId + 1
    const stream = pageContents[index] ?? ''
    objects[pageId] = `<< /Type /Page /Parent ${pagesObjectId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id]
    if (!body) continue
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${body}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  const maxId = objects.length - 1
  pdf += `xref\n0 ${maxId + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets[id] ?? 0
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root ${catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

export interface TwoColumnPdfSection {
  heading: string
  paragraphs: string[]
}

export interface TwoColumnPdfInput {
  title: string
  subtitle?: string
  sections: TwoColumnPdfSection[]
}

/**
 * A4 双栏演示 PDF（Helvetica，ASCII 公式）。
 *
 * 仅用于旗舰演示实验室的文献阅读链路；不嵌入字体、不支持中文。
 */
export function buildTwoColumnTextPdf(input: TwoColumnPdfInput): Buffer {
  const leftX = 50
  const rightX = 307
  const columnWidthChars = 46
  const bottomY = 58
  const topY = 770
  const pages: string[][] = []
  let ops: string[] = []
  let column: 0 | 1 = 0
  let y = topY

  const flushPage = (): void => {
    if (ops.length > 0) pages.push(ops)
    ops = []
    column = 0
    y = topY
  }
  const ensurePage = (): void => {
    if (ops.length === 0) {
      ops.push(`BT /F2 16 Tf 1 0 0 1 ${leftX} 800 Tm (${escapePdfText(input.title)}) Tj ET`)
      if (input.subtitle) {
        ops.push(`BT /F1 9 Tf 1 0 0 1 ${leftX} 782 Tm (${escapePdfText(input.subtitle)}) Tj ET`)
      }
      y = topY
    }
  }
  const advance = (lineHeight: number): void => {
    y -= lineHeight
    if (y >= bottomY) return
    if (column === 0) {
      column = 1
      y = topY
      return
    }
    flushPage()
  }
  const emit = (text: string, font: 'F1' | 'F2', size: number, lineHeight: number): void => {
    ensurePage()
    advance(lineHeight)
    const x = column === 0 ? leftX : rightX
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdfText(`${text} `)}) Tj ET`)
  }

  for (const section of input.sections) {
    emit(section.heading, 'F2', 12, 18)
    for (const paragraph of section.paragraphs) {
      for (const line of wrapLine(paragraph, columnWidthChars)) emit(line, 'F1', 9.5, 12)
      advance(6)
    }
    advance(4)
  }
  flushPage()
  if (pages.length === 0) pages.push([])

  const objects: string[] = []
  const fontBodyId = 3
  const fontBoldId = 4
  const pagesObjectId = 2
  const catalogObjectId = 1
  const pageObjectStart = 5
  const pageObjectIds = pages.map((_, index) => pageObjectStart + index * 2)

  objects[catalogObjectId] = `<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`
  objects[pagesObjectId] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  objects[fontBodyId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[fontBoldId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'

  pages.forEach((pageOps, index) => {
    const pageId = pageObjectIds[index]!
    const contentId = pageId + 1
    const stream = pageOps.join('\n')
    objects[pageId] = `<< /Type /Page /Parent ${pagesObjectId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontBodyId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id]
    if (!body) continue
    offsets[id] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${id} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  const maxId = objects.length - 1
  pdf += `xref\n0 ${maxId + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets[id] ?? 0
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root ${catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** SKLGP 泥石流演示论文（合成数据，明确标注 DEMO）。 */
export function buildSkLgpDemoPaperPdf(): Buffer {
  return buildTextPdf([
    [
      'DEMO',
      '',
      'Wenjia Gully Debris Flow: Rainfall Thresholds and Voellmy Runout Simulation (DEMO)',
      'SKLGP Demonstration Paper - Synthetic data for CDUT Science onboarding',
      '',
      '# Abstract',
      'Debris flows in the Wenchuan earthquake area are triggered by short, intense rainfall and amplified by abundant loose material on steep gully beds. This demonstration paper combines a 20 m DEM of a synthetic Wenjia-like gully with an empirical intensity-duration threshold and a depth-averaged Voellmy runout model. The example is intended to exercise the CDUT Science literature, DEM analysis and debris-flow toolchain; it is not a field investigation.',
      '',
      'Keywords: debris flow; rainfall threshold; Voellmy; DEM; runout; SKLGP',
      '',
      '# 1 Introduction',
      'Post-earthquake gullies in the Longmen Mountains deliver sediment pulses to towns and infrastructure. Rainfall intensity-duration (I-D) envelopes are widely used for early warning, while runout models estimate the exposed area downstream. This demo illustrates both steps.',
      '',
      '# 2 Study Area and DEM',
      'The synthetic DEM contains a main gully and two tributaries with a relief of about 420 m. Grid cells are 20 m. Slope, aspect and D8 flow accumulation are derived with standard finite-difference operators. The suggested source cell is the highest cell of the main channel network.',
      '',
      '# 3 Rainfall Thresholds',
      'The empirical threshold follows I = alpha * D^(-beta), where I is mean intensity in mm/h and D is duration in minutes. For the demonstration we use alpha = 30 and beta = 0.6. Local calibration is required before operational use.',
      '',
      '# 4 Voellmy Simulation',
      'The depth-averaged shallow-water solver uses Voellmy basal resistance:',
      '',
      'tau = mu * rho * g * h * cos(theta) + rho * g * |u|^2 / xi',
      '',
      'with mu = 0.20 and xi = 400 m/s^2. A released volume of 2.0e5 m3 is imposed at the source cell over a short hydrograph. The solver uses a CFL-limited explicit time step.',
      '',
      '# 5 Results',
      'The simulated flow reaches the fan within several minutes. Maximum depth occurs in the channel bend, and the deposition lobe extends downstream of the gully mouth. Table 1 lists the demonstration metrics.',
      '',
      'Metric | Value',
      'Released volume | 2.0e5 m3',
      'Peak discharge | 85 m3/s',
      'Maximum depth | 3.1 m',
      'Runout distance | 1250 m',
      '',
      '# 6 Limitations',
      'This demonstration uses a synthetic DEM and a simplified rheology. It ignores entrainment, bed erosion, woody debris and channel blockage. Results must not be used for engineering design or evacuation planning without field calibration and a certified simulator.',
      '',
      '# References',
      '[1] Iverson, R.M. (1997) The physics of debris flows. Reviews of Geophysics.',
      '[2] Rickenmann, D. (1999) Empirical relationships for debris flows. Natural Hazards.',
      '[3] SKLGP demonstration notes (synthetic, 2026).',
    ],
  ])
}
