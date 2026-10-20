/**
 * HeaderDataSeparator — 科研仪器 ASCII 导出的启发式表头/数据分离器
 *
 * 移植自技术研报算法：
 * 1. 前 100 行按候选分隔符切分，选择列数方差最小者；
 * 2. 使用 3 行前瞻窗口确认连续数值矩阵的真实起始行；
 * 3. 起始行之前提取 key:value 元数据，上一行提取列名与物理单位；
 * 4. 数值行遇到无法解析的行即停止（处理机台尾部附加信息）。
 */

import { buildDataset, splitLabelUnit, type ParsedDataset } from './types'

export type TextDelimiter = ',' | '\t' | ';' | '|' | ' '

const CANDIDATE_DELIMITERS: TextDelimiter[] = [',', '\t', ';', '|', ' ']
const COMMENT_SENTINELS = ['#', ';', '//', '*']

export interface DelimitedParseResult {
  dataset: ParsedDataset
  delimiter: TextDelimiter
  dataStartRow: number
  metadata: Record<string, string>
  headers: string[]
}

function tokenize(line: string, delimiter: TextDelimiter): string[] {
  const clean = line.trim()
  if (!clean) return []
  if (delimiter === ' ') return clean.split(/\s+/).filter(Boolean)
  return clean.split(delimiter).map((token) => token.trim()).filter(Boolean)
}

function normalizeNumericToken(token: string): string {
  // 兼容欧洲本地化小数逗号（如 1,05E-3），但不误伤分隔逗号。
  return /^-?\d+,\d+([eE][+-]?\d+)?$/.test(token) ? token.replace(',', '.') : token
}

function isNumericToken(token: string): boolean {
  const normalized = normalizeNumericToken(token)
  if (!normalized) return false
  return Number.isFinite(Number(normalized))
}

export function isNumericRow(line: string, delimiter: TextDelimiter): boolean {
  const tokens = tokenize(line, delimiter)
  if (tokens.length === 0) return false
  return tokens.every(isNumericToken)
}

/** 依据列数方差推断分隔符；信息不足时回退逗号。 */
export function detectDelimiter(lines: string[]): TextDelimiter {
  const sample = lines.slice(0, 100).filter((line) => line.trim().length > 0)
  if (sample.length === 0) return ','

  let best: TextDelimiter = ','
  let minVariance = Number.POSITIVE_INFINITY
  let bestMultiColumnLines = 0

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sample
      .map((line) => tokenize(line, delimiter).length)
      .filter((count) => count > 1)
    // 小样本（如 3~5 行仪器导出）同样应参与评估；只要求至少 2 行形成多列。
    if (counts.length < 2) continue

    const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length
    const variance = counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / counts.length

    if (
      variance < minVariance ||
      (variance === minVariance && counts.length > bestMultiColumnLines)
    ) {
      minVariance = variance
      best = delimiter
      bestMultiColumnLines = counts.length
    }
  }

  return best
}

/** 使用 3 行前瞻窗口定位连续数值矩阵的起始行。 */
export function findDataStart(
  lines: string[],
  delimiter: TextDelimiter,
  lookahead = 3,
): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!trimmed) continue
    if (COMMENT_SENTINELS.some((sentinel) => trimmed.startsWith(sentinel))) continue
    if (!isNumericRow(line, delimiter)) continue

    let isMatrix = true
    for (let offset = 1; offset <= lookahead; offset += 1) {
      const next = lines[i + offset]
      if (next == null || !next.trim()) continue
      if (!isNumericRow(next, delimiter)) {
        isMatrix = false
        break
      }
    }
    if (isMatrix) return i
  }

  return -1
}

function parsePreambleMetadata(lines: string[]): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const line of lines) {
    const clean = line.trim().replace(/^[#;*/\s]+/, '')
    if (!clean) continue
    const match = clean.match(/^([^:=]{1,80})\s*[:=]\s*(.+)$/)
    if (!match) continue
    const key = match[1]?.trim() ?? ''
    const value = match[2]?.trim() ?? ''
    if (!key || !value) continue
    // 纯数字时间（如 08:00）不拆分为键值。
    if (/^\d+$/.test(key)) continue
    metadata[key] = value
  }
  return metadata
}

function coerceHeaderTokens(line: string | undefined, delimiter: TextDelimiter, expected: number): string[] {
  if (!line) return []
  const tokens = tokenize(line, delimiter)
  if (tokens.length !== expected) return []
  if (tokens.every(isNumericToken)) return []
  return tokens
}

/**
 * 解析任意仪器 ASCII 导出（.txt/.csv/.dat/.asc/.dpt/.mpt）。
 */
export function parseDelimitedText(text: string, format = 'text'): DelimitedParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const delimiter = detectDelimiter(lines)
  const dataStartRow = findDataStart(lines, delimiter)

  if (dataStartRow < 0) {
    throw new Error('未检测到连续数值矩阵：该文本可能是纯日志或缺少二维数据列')
  }

  const headerLine = dataStartRow > 0 ? lines[dataStartRow - 1] : undefined
  const firstRowTokens = tokenize(lines[dataStartRow] ?? '', delimiter)
  const rawHeaders = coerceHeaderTokens(headerLine, delimiter, firstRowTokens.length)

  const rows: number[][] = []
  for (let i = dataStartRow; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const tokens = tokenize(line, delimiter)
    if (tokens.length !== firstRowTokens.length) break
    const numbers = tokens.map((token) => Number(normalizeNumericToken(token)))
    if (numbers.some((value) => !Number.isFinite(value))) break
    rows.push(numbers)
  }

  if (rows.length === 0) throw new Error('数值矩阵为空')

  const firstRow = rows[0] ?? []
  const metadata = parsePreambleMetadata(lines.slice(0, headersExpectedStart(dataStartRow, rawHeaders)))
  const headers = rawHeaders.length === firstRow.length ? rawHeaders : []

  const xValues = rows.map((row, index) => (firstRow.length > 1 ? row[0] ?? index : index))
  const seriesCount = Math.max(1, firstRow.length - 1)
  const seriesLabels = Array.from({ length: seriesCount }, (_, index) => {
    const raw = headers[index + 1] ?? (firstRow.length > 1 ? `Y${index + 1}` : headers[index] ?? 'Y1')
    return splitLabelUnit(raw)
  })
  const xHeader = headers[0] ? splitLabelUnit(headers[0]) : { label: 'X', unit: undefined }

  const series = seriesLabels.map((_, index) =>
    rows.map((row) => (firstRow.length > 1 ? row[index + 1] ?? Number.NaN : row[0] ?? Number.NaN)),
  )

  const dataset = buildDataset({
    format,
    xLabel: firstRow.length > 1 ? xHeader.label || 'X' : 'Index',
    xUnit: firstRow.length > 1 ? xHeader.unit : undefined,
    seriesLabels,
    x: xValues,
    series,
    metadata,
  })

  return { dataset, delimiter, dataStartRow, metadata, headers }
}

function headersExpectedStart(dataStartRow: number, rawHeaders: string[]): number {
  return rawHeaders.length > 0 ? Math.max(0, dataStartRow - 1) : dataStartRow
}
