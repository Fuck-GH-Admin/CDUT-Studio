/**
 * CSLab 论文入库流水线：实证解析与图表抽取（阶段一）
 *
 * 职责：
 * - 从论文 Markdown 表格块抽取数值型实证指标（含单位归一化、± 不确定度、基线/条件列）；
 * - 用 node:zlib 手工封装合法 PNG（IHDR/IDAT/IEND + CRC32），供裸像素图像落盘；
 * - 从 PDF 原生图像流提取内嵌位图，与版面 AST 的 figure 块配对后写入
 *   vault/notes/attachments/<paperSlug>/，产出 Obsidian 可引用的 PaperFigureAsset。
 *
 * 红线：
 * 1. 主进程无 Canvas/DOM/OffscreenCanvas：严禁 page.render() 与任何 canvas API，
 *    只允许 getOperatorList() + paintImageXObject / paintJpegXObject / paintImageMaskXObject；
 * 2. 所有失败路径只 console.warn 并跳过该项，绝不抛出中断入库
 *    （仅 encodePngFromRgba 的参数校验属于纯函数契约，明确 throw）；
 * 3. 文件写入一律 .tmp + rename 原子化（对齐 cslab-paths 的 manifest 写法）；
 * 4. 不引入任何三方图像依赖：PNG 编码只用 node:zlib 的 deflateSync + 手写 CRC32；
 * 5. pdfjs 以非字面量说明符动态 import（对齐 packages/core pdf-stream-extractor），
 *    且允许测试注入假 pdfjs 模块，测试绝不解析真实 PDF。
 *
 * 不确定度取舍：数值带 ± 时 value 以字符串保留「主值 ± 不确定度」（主值在前），
 * 无不确定度时 value 为纯数字；unit 统一归一化后单独存放。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { EmpiricalMetric, PaperFigureAsset } from '@profer/shared'
import { resolveLabDir, sanitizeFileName } from './cslab-paths'

// ===== A. 数值指标抽取（纯函数） =====

/** 每页指标上限，防止超大表格把内存/IPC 打爆。 */
const MAX_METRICS_PER_PAGE = 200

type ColumnRole = 'name' | 'value' | 'unit' | 'baseline' | 'condition' | 'ignore'

const HEADER_ROLE_KEYWORDS: Array<{ role: ColumnRole; keywords: string[] }> = [
  { role: 'unit', keywords: ['unit', 'units', '单位', '量纲'] },
  { role: 'baseline', keywords: ['baseline', 'reference', 'ref', 'control', '基线', '对照', '参考', '对比', '参照'] },
  { role: 'condition', keywords: ['condition', 'conditions', 'setting', 'settings', 'environment', '工况', '条件', '环境', '状态'] },
  { role: 'value', keywords: ['value', 'values', 'result', 'results', 'measured', 'measurement', '数值', '值', '结果', '测量值', '实测', '量值'] },
  { role: 'name', keywords: ['metric', 'metrics', 'parameter', 'parameters', 'name', 'item', 'quantity', 'measurand', '指标', '参数', '名称', '项目'] },
]

/** 单位别名表：键为小写/去空白后的比较基准，值为规范写法。 */
const UNIT_ALIASES: Record<string, string> = {
  '%': '%',
  '％': '%',
  percent: '%',
  ev: 'eV',
  '°c': '°C',
  '℃': '°C',
  degc: '°C',
  celsius: '°C',
  摄氏度: '°C',
  k: 'K',
  kelvin: 'K',
  开尔文: 'K',
  'å': 'Å',
  angstrom: 'Å',
  angstroms: 'Å',
  埃: 'Å',
  nm: 'nm',
  nanometer: 'nm',
  nanometre: 'nm',
  纳米: 'nm',
  'µm': 'µm',
  um: 'µm',
  micrometer: 'µm',
  micrometre: 'µm',
  micron: 'µm',
  微米: 'µm',
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  mpa: 'MPa',
  兆帕: 'MPa',
  gpa: 'GPa',
  吉帕: 'GPa',
  kpa: 'kPa',
  pa: 'Pa',
  pascal: 'Pa',
  帕: 'Pa',
  'm/s': 'm/s',
  'ms^-1': 'm/s',
  'km/s': 'km/s',
  'km/h': 'km/h',
  'kg/m^3': 'kg/m³',
  'g/cm^3': 'g/cm³',
  s: 's',
  ms: 'ms',
  ns: 'ns',
  hz: 'Hz',
  khz: 'kHz',
  mhz: 'MHz',
  ghz: 'GHz',
  v: 'V',
  mv: 'mV',
  ma: 'mA',
  'kj/mol': 'kJ/mol',
  'kcal/mol': 'kcal/mol',
  'wt%': 'wt%',
  'at%': 'at%',
}

/** 空值占位（破折号、N/A 等）视为「无值」。 */
const EMPTY_MARKER_RE = /^(?:-{1,}|—|–|\/|n\/?a\.?|无|未测)$/i

interface NumericCell {
  /** 主值 */
  main: number
  /** 主值原始数字串（保留科学计数法/小数位写法） */
  mainText: string
  /** 不确定度原始数字串（有 ± 时存在） */
  uncertaintyText?: string
  /** 从数值单元格尾部识别出的单位（已归一化） */
  unit?: string
}

function isEmptyMarker(text: string): boolean {
  return text === '' || EMPTY_MARKER_RE.test(text)
}

/** 表格行 → 单元格数组（支持 \| 转义，容忍首尾竖线）。 */
function splitTableRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** Markdown 表格分隔行（|---|:---:| 之类）。 */
function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

function roleOfHeader(header: string): ColumnRole {
  const normalized = header
    .toLowerCase()
    .replace(/\(.*?\)|（.*?）/g, '')
    .replace(/[\s_\-/:]/g, '')
  for (const entry of HEADER_ROLE_KEYWORDS) {
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) return entry.role
  }
  return 'ignore'
}

/** 单位归一化：识别常见写法（含全角/上标/微符号变体），未知单位原样保留。 */
export function normalizeUnit(raw: string): string {
  const trimmed = raw.trim().replace(/^[([]|[)\]]$/g, '').replace(/^[$`]+|[$`]+$/g, '')
  if (!trimmed) return ''
  const canonical = trimmed
    .replace(/μ/g, 'µ')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/⁻¹/g, '^-1')
    .replace(/⁻²/g, '^-2')
  const key = canonical.toLowerCase().replace(/\s+/g, '')
  return UNIT_ALIASES[key] ?? trimmed
}

/** 仅在别名表命中时返回规范单位（用于指标名括号里的单位猜测）。 */
function lookupUnit(raw: string): string | null {
  const key = raw.trim().replace(/μ/g, 'µ').toLowerCase().replace(/\s+/g, '')
  return UNIT_ALIASES[key] ?? null
}

/** 归一化数值文本：全角数字/符号、各种减号与近似符统一。 */
function normalizeNumericText(text: string): string {
  return text
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/％/g, '%')
    .replace(/[−–]/g, '-')
    .replace(/＋/g, '+')
    .replace(/＋\/－/g, '+/-')
    .replace(/^[~≈∼约]+/, '')
    .trim()
}

/**
 * 解析数值型单元格：主值（含科学计数法）+ 可选 ± 不确定度 + 可选单位。
 * 非数值（文本、破折号、N/A）返回 null，由调用方跳过整行。
 */
function parseNumericCell(raw: string): NumericCell | null {
  const text = normalizeNumericText(raw)
  if (!text || isEmptyMarker(text)) return null
  // 整体包裹括号先剥掉：`(95.2 ± 0.3)` → `95.2 ± 0.3`
  const unwrapped = /^\(.*\)$|^\[.*\]$/.test(text) ? text.slice(1, -1).trim() : text
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s*(?:±|\+\/-|\+-)\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?\s*(.*)$/.exec(unwrapped)
  if (!match) return null
  const mainText = match[1]!
  const uncertaintyText = match[2]
  const rest = (match[3] ?? '').trim().replace(/^[([]|[)\]]$/g, '')
  // 尾部只允许短单位记号（含上标/℃/％ 等符号）；出现长文本/句子则判为非数值行
  if (rest && (rest.length > 12 || !/^[\p{L}\p{N}%°Ååµμ·/\-^()+\s²³¹⁻℃％]+$/u.test(rest))) return null
  const main = Number(mainText)
  if (!Number.isFinite(main)) return null
  return {
    main,
    mainText,
    uncertaintyText,
    unit: rest ? normalizeUnit(rest) : undefined,
  }
}

/** 指标名尾部括号里的单位（如 `Band gap (eV)`），仅别名表命中时采纳。 */
function splitNameUnit(name: string): { name: string; unit?: string } {
  const match = /^(.*?)[\s]*[([]([^()[\]]{1,12})[)\]]\s*$/.exec(name.trim())
  if (!match) return { name: name.trim() }
  const unit = lookupUnit(match[2]!)
  if (!unit) return { name: name.trim() }
  return { name: match[1]!.trim() || name.trim(), unit }
}

function cleanCellText(text: string): string {
  return text.trim()
}

/** 单列基线：纯数字 → number，其余文本原样保留，空占位省略。 */
function parseBaselineCell(text: string): string | number | undefined {
  const trimmed = cleanCellText(text)
  if (isEmptyMarker(trimmed)) return undefined
  const normalized = normalizeNumericText(trimmed)
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(normalized)) return Number(normalized)
  return trimmed
}

interface ParsedTable {
  headerRoles: ColumnRole[]
  rows: string[][]
}

/** 定位 Markdown 表格块（表头 + 分隔行 + 数据行），跳过其余文本。 */
function collectTables(markdown: string): ParsedTable[] {
  const lines = markdown.split(/\r?\n/)
  const tables: ParsedTable[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const next = lines[index + 1] ?? ''
    if (!line.includes('|') || !isDelimiterRow(next)) {
      index += 1
      continue
    }
    const headerRoles = splitTableRow(line).map(roleOfHeader)
    const rows: string[][] = []
    let cursor = index + 2
    while (cursor < lines.length) {
      const bodyLine = lines[cursor] ?? ''
      if (!bodyLine.includes('|') || bodyLine.trim() === '') break
      rows.push(splitTableRow(bodyLine))
      cursor += 1
    }
    tables.push({ headerRoles, rows })
    index = cursor
  }
  return tables
}

function resolveColumns(table: ParsedTable): { nameIdx: number; valueIdx: number; unitIdx: number; baselineIdx: number; conditionIdx: number } | null {
  const { headerRoles, rows } = table
  const firstOf = (role: ColumnRole): number => headerRoles.indexOf(role)
  let nameIdx = firstOf('name')
  let valueIdx = firstOf('value')
  // 未识别表头时的兜底：数据驱动找首个以数值为主的列作 value
  if (valueIdx === -1) {
    for (let col = 0; col < headerRoles.length; col += 1) {
      if (col === nameIdx) continue
      let numericCount = 0
      let total = 0
      for (const row of rows) {
        const cell = row[col] ?? ''
        if (!cell || isEmptyMarker(cell)) continue
        total += 1
        if (parseNumericCell(cell)) numericCount += 1
      }
      if (total > 0 && numericCount / total >= 0.5) {
        valueIdx = col
        break
      }
    }
  }
  if (valueIdx === -1) return null
  if (nameIdx === -1) {
    nameIdx = headerRoles.findIndex((_role, idx) => idx !== valueIdx && idx !== firstOf('unit'))
  }
  if (nameIdx === -1) return null
  return {
    nameIdx,
    valueIdx,
    unitIdx: firstOf('unit'),
    baselineIdx: firstOf('baseline'),
    conditionIdx: firstOf('condition'),
  }
}

/**
 * 从论文 Markdown 中抽取数值型实证指标（每页上限 200 条）。
 *
 * 只处理 Markdown 表格块；表头识别 metric/指标/parameter/value/baseline/基线/
 * condition/条件/单位/unit 等常见列名，未识别时按数据列推断。文本型行跳过。
 *
 * @param markdown 论文（或单页）Markdown 文本
 * @param page 页码（1 起），原样写入每条指标
 */
export function parseEmpiricalMetricsFromMarkdown(markdown: string, page: number): EmpiricalMetric[] {
  const metrics: EmpiricalMetric[] = []
  if (typeof markdown !== 'string' || markdown.trim() === '') return metrics
  const pageNumber = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1

  for (const table of collectTables(markdown)) {
    if (metrics.length >= MAX_METRICS_PER_PAGE) break
    const columns = resolveColumns(table)
    if (!columns) continue
    for (const row of table.rows) {
      if (metrics.length >= MAX_METRICS_PER_PAGE) break
      const rawName = cleanCellText(row[columns.nameIdx] ?? '')
      if (isEmptyMarker(rawName)) continue
      const numeric = parseNumericCell(row[columns.valueIdx] ?? '')
      // 只抽数值型行：文本型跳过
      if (!numeric) continue

      const unitCell = columns.unitIdx >= 0 ? cleanCellText(row[columns.unitIdx] ?? '') : ''
      const nameSplit = splitNameUnit(rawName)
      const unit = !isEmptyMarker(unitCell)
        ? normalizeUnit(unitCell)
        : numeric.unit ?? nameSplit.unit

      const metric: EmpiricalMetric = {
        name: nameSplit.name,
        // ± 不确定度并入 value 字符串（主值在前）；无不确定度时为纯数字
        value: numeric.uncertaintyText !== undefined
          ? `${numeric.mainText} ± ${numeric.uncertaintyText}`
          : numeric.main,
        page: pageNumber,
      }
      if (unit) metric.unit = unit
      const baseline = columns.baselineIdx >= 0 ? parseBaselineCell(row[columns.baselineIdx] ?? '') : undefined
      if (baseline !== undefined) metric.baseline = baseline
      const condition = columns.conditionIdx >= 0 ? cleanCellText(row[columns.conditionIdx] ?? '') : ''
      if (!isEmptyMarker(condition)) metric.condition = condition
      metrics.push(metric)
    }
  }
  return metrics
}

// ===== B. PNG 合法封装（纯函数，只用 node:zlib） =====

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = (table[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * 把裸 RGB/RGBA 像素封装为合法 PNG（签名 + IHDR + IDAT + IEND，含 CRC32）。
 * 滤波器固定 0（None），IDAT 为 deflateSync 压缩的原始扫描线，可无损还原。
 *
 * @throws 尺寸/通道/像素长度不合法时抛出（纯函数契约，其余模块不抛）
 */
export function encodePngFromRgba(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG 尺寸非法')
  }
  if (channels !== 3 && channels !== 4) {
    throw new Error('PNG 通道数非法')
  }
  if (pixels.length !== width * height * channels) {
    throw new Error('PNG 像素数据长度与尺寸不符')
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = channels === 4 ? 6 : 2 // colorType：6=RGBA，2=RGB
  ihdr[10] = 0 // 压缩方法
  ihdr[11] = 0 // 滤波方法
  ihdr[12] = 0 // 非隔行

  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // 滤波器 0（None），保证 inflate 后可逐字节还原
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), rowStart + 1)
  }
  const idat = deflateSync(raw)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ===== C. PDF 原生图像流提取（动态注入 pdfjs，绝不渲染） =====

/** 版面 AST 中 kind === 'figure' 的节点（bbox 用 pointBbox，caption 用其 text）。 */
export interface FigureBlock {
  pageNumber: number
  bbox: [number, number, number, number]
  caption: string
}

/** pdfjs 模块最小契约（只声明用到的字段，便于测试注入假模块）。 */
export interface PdfJsLike {
  OPS: Record<string, number>
  getDocument(src: {
    data: Uint8Array
    disableFontFace?: boolean
    isEvalSupported?: boolean
    useWorkerFetch?: boolean
  }): { promise: Promise<PdfJsDocumentLike> }
}

interface PdfJsDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfJsPageLike>
  destroy?(): Promise<void> | void
}

interface PdfJsPageLike {
  view?: number[]
  getViewport?(params: { scale: number }): { width: number; height: number }
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
  objs?: { get(id: unknown): unknown }
}

export interface ExtractPaperFiguresOptions {
  labId: string
  paperSlug: string
  pdfBytes: Uint8Array
  figureBlocks: FigureBlock[]
  /** 测试注入的假 pdfjs 模块；缺省时动态加载 pdfjs-dist legacy 构建。 */
  pdfjsModule?: PdfJsLike
}

/** 扫描页数上限（防御超大 PDF 拖垮主进程；超限页面只保留 figureBlock 矢量占位）。 */
const MAX_SCAN_PAGES = 300

interface ExtractedImage {
  /** 相对 vault/notes 的路径（Obsidian ![[...]] 用） */
  relPath: string
  /** 图像绘制位置（左上原点、y 向下的 points 框）；无法确定时缺省 */
  placement?: [number, number, number, number]
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** CTM 级联：cm 矩阵左乘当前 CTM。 */
function multiply(m: Matrix, c: Matrix): Matrix {
  return [
    m[0] * c[0] + m[2] * c[1],
    m[1] * c[0] + m[3] * c[1],
    m[0] * c[2] + m[2] * c[3],
    m[1] * c[2] + m[3] * c[3],
    m[0] * c[4] + m[2] * c[5] + m[4],
    m[1] * c[4] + m[3] * c[5] + m[5],
  ]
}

function readMatrix(args: unknown[]): Matrix | null {
  const values = args.slice(0, 6).map((v) => (typeof v === 'number' ? v : Number.NaN))
  if (values.length < 6 || values.some((v) => !Number.isFinite(v))) return null
  return [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!]
}

/** 单位正方形经 CTM 映射为图像放置框（用户空间，y 向上）。 */
function placementFromCtm(ctm: Matrix, pageHeight: number): [number, number, number, number] | undefined {
  if (!(pageHeight > 0)) return undefined
  const [a, b, c, d, e, f] = ctm
  const xs = [e, a + e, a + c + e, c + e]
  const ys = [f, b + f, b + d + f, d + f]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  if (![minX, maxX, minY, maxY].every((v) => Number.isFinite(v))) return undefined
  // PDF 用户空间 y 向上 → 与 figureBBox 一致的左上原点 y 向下
  return [minX, pageHeight - maxY, maxX, pageHeight - minY]
}

function detectPageHeight(page: PdfJsPageLike): number {
  if (Array.isArray(page.view) && page.view.length === 4) {
    const height = Math.abs((page.view[3] ?? 0) - (page.view[1] ?? 0))
    if (height > 0) return height
  }
  try {
    const viewport = page.getViewport?.({ scale: 1 })
    if (viewport && Number.isFinite(viewport.height) && viewport.height > 0) return viewport.height
  } catch {
    // 视口不可用时退回顺序配对。
  }
  return 0
}

function isByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function isJpegBytes(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
}

function isPngBytes(data: Uint8Array): boolean {
  return data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
}

/** 从算子参数取 objId（args[0]），内联图像则直接是对象。 */
function resolveImageObject(page: PdfJsPageLike, args: unknown[]): unknown {
  const first = args[0]
  if (first && typeof first === 'object' && !isByteArray(first)) {
    return first
  }
  if (first === undefined || first === null) return null
  try {
    return page.objs?.get?.(first) ?? null
  } catch (error) {
    console.warn('[CSLab] 图表抽取：objs.get 读取图像对象失败，已跳过:', error)
    return null
  }
}

/**
 * 把 pdfjs 图像对象物化为可落盘字节：
 * JPEG 魔数 FF D8 → 直存 .jpg；PNG 魔数 → 直存 .png；
 * 裸 RGB/RGBA 像素 → encodePngFromRgba 封装 .png。格式不明则跳过。
 */
function materializeImage(page: PdfJsPageLike, args: unknown[]): { ext: 'jpg' | 'png'; buffer: Buffer } | null {
  const raw = resolveImageObject(page, args)
  if (!raw) return null
  const record = (isByteArray(raw) ? {} : raw) as Record<string, unknown>
  const data = isByteArray(raw)
    ? raw
    : isByteArray(record.data)
      ? record.data
      : record.data instanceof ArrayBuffer
        ? new Uint8Array(record.data)
        : null
  if (!data || data.length === 0) {
    console.warn('[CSLab] 图表抽取：图像对象缺少字节数据，已跳过')
    return null
  }

  if (isJpegBytes(data)) return { ext: 'jpg', buffer: Buffer.from(data) }
  if (isPngBytes(data)) return { ext: 'png', buffer: Buffer.from(data) }

  const width = typeof record.width === 'number' ? record.width : typeof args[1] === 'number' ? args[1] : 0
  const height = typeof record.height === 'number' ? record.height : typeof args[2] === 'number' ? args[2] : 0
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    console.warn('[CSLab] 图表抽取：裸像素图像缺少宽高，已跳过')
    return null
  }
  let channels: 3 | 4 | 0 = 0
  if (data.length === width * height * 4) channels = 4
  else if (data.length === width * height * 3) channels = 3
  else if (typeof record.kind === 'number' && (record.kind === 3 || record.kind === 4) && data.length === width * height * record.kind) {
    channels = record.kind
  }
  if (channels === 0) {
    console.warn('[CSLab] 图表抽取：未知图像格式（非 JPEG/PNG 且无法识别通道），已跳过')
    return null
  }
  try {
    return { ext: 'png', buffer: encodePngFromRgba(data, width, height, channels) }
  } catch (error) {
    console.warn('[CSLab] 图表抽取：PNG 封装失败，已跳过:', error)
    return null
  }
}

/** .tmp + rename 原子写入（对齐 cslab-paths 的 manifest 写法）。 */
function writeFileAtomic(targetPath: string, buffer: Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.tmp`
  writeFileSync(tmpPath, buffer)
  renameSync(tmpPath, targetPath)
}

/** 扫描单页算子流，提取内嵌图像并落盘（绝不调用 page.render）。 */
async function extractPageImages(
  page: PdfJsPageLike,
  pageNumber: number,
  OPS: Record<string, number>,
  outDir: string,
  slug: string,
): Promise<ExtractedImage[]> {
  const paintOps = new Set(
    [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject]
      .filter((id): id is number => typeof id === 'number'),
  )
  if (paintOps.size === 0) return []
  const hasSave = typeof OPS.save === 'number' ? OPS.save : null
  const hasRestore = typeof OPS.restore === 'number' ? OPS.restore : null
  const hasTransform = typeof OPS.transform === 'number' ? OPS.transform : null

  let list: { fnArray: number[]; argsArray: unknown[][] }
  try {
    list = await page.getOperatorList()
  } catch (error) {
    console.warn(`[CSLab] 图表抽取：第 ${pageNumber} 页算子表读取失败，已跳过:`, error)
    return []
  }
  const { fnArray, argsArray } = list ?? { fnArray: [], argsArray: [] }
  if (!Array.isArray(fnArray) || !Array.isArray(argsArray)) return []

  const pageHeight = detectPageHeight(page)
  const candidates: Array<{ args: unknown[]; placement?: [number, number, number, number] }> = []
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i]
    const args = Array.isArray(argsArray[i]) ? argsArray[i]! : []
    if (fn === hasSave) {
      stack.push(ctm)
      continue
    }
    if (fn === hasRestore) {
      ctm = stack.pop() ?? IDENTITY
      continue
    }
    if (fn === hasTransform) {
      const m = readMatrix(args)
      if (m) ctm = multiply(m, ctm)
      continue
    }
    if (typeof fn === 'number' && paintOps.has(fn)) {
      candidates.push({ args, placement: placementFromCtm(ctm, pageHeight) })
    }
  }

  const out: ExtractedImage[] = []
  for (const candidate of candidates) {
    const materialized = materializeImage(page, candidate.args)
    if (!materialized) continue
    const fileName = `fig_p${pageNumber}_${out.length + 1}.${materialized.ext}`
    try {
      writeFileAtomic(join(outDir, fileName), materialized.buffer)
    } catch (error) {
      console.warn(`[CSLab] 图表抽取：位图写盘失败，已跳过 ${fileName}:`, error)
      continue
    }
    out.push({ relPath: `attachments/${slug}/${fileName}`, placement: candidate.placement })
  }
  return out
}

function centerOf(bbox: [number, number, number, number]): { x: number; y: number } {
  return { x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 }
}

function containsPoint(bbox: [number, number, number, number], point: { x: number; y: number }): boolean {
  const x0 = Math.min(bbox[0], bbox[2])
  const x1 = Math.max(bbox[0], bbox[2])
  const y0 = Math.min(bbox[1], bbox[3])
  const y1 = Math.max(bbox[1], bbox[3])
  return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1
}

function normalizeBlocks(figureBlocks: FigureBlock[] | undefined): Array<{ pageNumber: number; bbox?: [number, number, number, number]; caption: string }> {
  if (!Array.isArray(figureBlocks)) return []
  const blocks: Array<{ pageNumber: number; bbox?: [number, number, number, number]; caption: string }> = []
  for (const block of figureBlocks) {
    if (!block || typeof block !== 'object') continue
    const pageNumber = Math.floor(Number(block.pageNumber))
    if (!Number.isFinite(pageNumber) || pageNumber < 1) continue
    const bbox = Array.isArray(block.bbox) && block.bbox.length === 4 && block.bbox.every((v) => Number.isFinite(v))
      ? ([...block.bbox] as [number, number, number, number])
      : undefined
    blocks.push({ pageNumber, bbox, caption: typeof block.caption === 'string' ? block.caption : '' })
  }
  return blocks
}

/** 图像 ↔ figureBlock 配对与资产组装：同页位置包含优先，顺序配对兜底。 */
function assembleAssets(
  blocks: Array<{ pageNumber: number; bbox?: [number, number, number, number]; caption: string }>,
  imagesByPage: Map<number, ExtractedImage[]>,
  slug: string,
): PaperFigureAsset[] {
  const pages = [...new Set([...blocks.map((b) => b.pageNumber), ...imagesByPage.keys()])].sort((a, b) => a - b)
  const assets: PaperFigureAsset[] = []
  const idCounters = new Map<number, number>()
  const nextId = (page: number): string => {
    const n = (idCounters.get(page) ?? 0) + 1
    idCounters.set(page, n)
    return `fig_${slug}_p${page}_${n}`
  }

  for (const page of pages) {
    const blocksOnPage = blocks.filter((b) => b.pageNumber === page)
    const images = [...(imagesByPage.get(page) ?? [])]
    const used = images.map(() => false)
    const pairOf = new Map<number, number>()

    // 第一轮：图像绘制位置中心落入 figure bbox（位置包含判断）
    for (let bi = 0; bi < blocksOnPage.length; bi += 1) {
      const bbox = blocksOnPage[bi]!.bbox
      if (!bbox) continue
      for (let ii = 0; ii < images.length; ii += 1) {
        if (used[ii] || !images[ii]!.placement) continue
        if (containsPoint(bbox, centerOf(images[ii]!.placement!))) {
          used[ii] = true
          pairOf.set(bi, ii)
          break
        }
      }
    }
    // 第二轮：同页按绘制顺序配对兜底
    for (let bi = 0; bi < blocksOnPage.length; bi += 1) {
      if (pairOf.has(bi)) continue
      const ii = used.findIndex((v) => !v)
      if (ii === -1) break
      used[ii] = true
      pairOf.set(bi, ii)
    }

    for (let bi = 0; bi < blocksOnPage.length; bi += 1) {
      const block = blocksOnPage[bi]!
      const image = pairOf.has(bi) ? images[pairOf.get(bi)!] : undefined
      const asset: PaperFigureAsset = {
        id: nextId(page),
        caption: block.caption,
        pageNumber: page,
        renderSource: image ? 'image-xobject' : 'vector-unsampled',
      }
      if (image) asset.relPath = image.relPath
      if (block.bbox) asset.bbox = block.bbox
      assets.push(asset)
    }
    // 提取出但未配对的图像：caption 留空，仍保留位图资产
    for (let ii = 0; ii < images.length; ii += 1) {
      if (used[ii]) continue
      const image = images[ii]!
      const asset: PaperFigureAsset = {
        id: nextId(page),
        caption: '',
        pageNumber: page,
        relPath: image.relPath,
        renderSource: 'image-xobject',
      }
      if (image.placement) asset.bbox = image.placement
      assets.push(asset)
    }
  }
  return assets
}

/** 动态加载 pdfjs-dist legacy 构建（非字面量说明符，阻止打包器静态解析）。 */
async function loadPdfJs(): Promise<PdfJsLike> {
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs'
  const mod = (await import(specifier)) as unknown as PdfJsLike
  if (!mod || typeof mod.getDocument !== 'function') {
    throw new Error('pdfjs-dist 加载失败：缺少 getDocument 接口')
  }
  return mod
}

/**
 * 提取 PDF 内嵌位图并与版面 figure 块配对，产出 PaperFigureAsset。
 *
 * 只走 getOperatorList() + paintImageXObject / paintJpegXObject / paintImageMaskXObject，
 * 绝不调用 page.render()（主进程无 Canvas）。位图写入
 * <lab>/vault/notes/attachments/<paperSlug>/fig_p<page>_<idx>.png|jpg，
 * relPath 为相对 vault/notes 的 `attachments/<paperSlug>/...`。
 * 任何一步失败只告警跳过，figureBlock 未配对时回填 vector-unsampled（不生成占位图）。
 */
export async function extractPaperFigures(options: ExtractPaperFiguresOptions): Promise<PaperFigureAsset[]> {
  const blocks = normalizeBlocks(options?.figureBlocks)
  const slug = sanitizeFileName(typeof options?.paperSlug === 'string' && options.paperSlug ? options.paperSlug : 'paper')

  let outDir = ''
  try {
    outDir = join(resolveLabDir(options.labId), 'vault', 'notes', 'attachments', slug)
  } catch (error) {
    console.warn('[CSLab] 图表抽取：实验室目录解析失败，位图将只保留矢量占位:', error)
  }

  let pdfjs: PdfJsLike | null = options.pdfjsModule ?? null
  if (!pdfjs) {
    try {
      pdfjs = await loadPdfJs()
    } catch (error) {
      console.warn('[CSLab] 图表抽取：pdfjs 加载失败，降级为矢量占位:', error)
    }
  }

  const imagesByPage = new Map<number, ExtractedImage[]>()
  // 位图目录不可用时不再扫描图像（无法落盘的图像资产没有意义），figureBlock 仍回填矢量占位
  if (pdfjs && outDir) {
    try {
      const data = new Uint8Array(options.pdfBytes ?? new Uint8Array(0))
      const loadingTask = pdfjs.getDocument({
        data,
        disableFontFace: true,
        isEvalSupported: false,
        useWorkerFetch: false,
      })
      const pdf = await (loadingTask?.promise ?? (loadingTask as unknown as Promise<PdfJsDocumentLike>))
      try {
        const numPages = Number.isFinite(pdf?.numPages) ? Math.max(0, Math.floor(pdf.numPages)) : 0
        const limit = Math.min(numPages, MAX_SCAN_PAGES)
        if (numPages > limit) {
          console.warn(`[CSLab] 图表抽取：页数 ${numPages} 超过扫描上限 ${MAX_SCAN_PAGES}，仅扫描前 ${limit} 页`)
        }
        for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
          try {
            const page = await pdf.getPage(pageNumber)
            const images = await extractPageImages(page, pageNumber, pdfjs!.OPS ?? {}, outDir, slug)
            if (images.length > 0) imagesByPage.set(pageNumber, images)
          } catch (error) {
            console.warn(`[CSLab] 图表抽取：第 ${pageNumber} 页处理失败，已跳过:`, error)
          }
        }
      } finally {
        try {
          await pdf?.destroy?.()
        } catch {
          // destroy 失败不影响结果。
        }
      }
    } catch (error) {
      console.warn('[CSLab] 图表抽取：PDF 打开失败，降级为矢量占位:', error)
    }
  }

  try {
    return assembleAssets(blocks, imagesByPage, slug)
  } catch (error) {
    console.warn('[CSLab] 图表抽取：资产组装失败:', error)
    return []
  }
}
