/**
 * XRD 常见格式解析：Rigaku .ras / Panalytical .xrdml / Bruker .brml XML / Bruker 二进制 .raw
 *
 * Bruker 二进制 .raw 的官方块结构随版本差异极大，本实现采用「先识别 RAW 头，再在限定窗口内
 * 寻找严格单调、等步长的数值序列」的启发式恢复；无法可信恢复时明确抛 Unsupported，
 * 交由可选 Python 增强通道（geddes）处理，绝不伪造数据。
 */

import { buildDataset, CsLabUnsupportedFormatError, type ParsedDataset } from './types'

/** Rigaku .ras 文本格式。 */
export function parseRigakuRas(text: string): ParsedDataset {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const metadata: Record<string, string> = {}
  let dataStart = -1

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (/^\*RAS_DATA_START\*?$/i.test(line)) {
      dataStart = i + 1
      break
    }
    const meta = line.match(/^\*([A-Z0-9_]+)\s+"?([^"]*)"?$/i)
    if (meta?.[1] && meta[2] != null) metadata[meta[1]] = meta[2].trim()
  }

  if (dataStart < 0) {
    // 兼容缺少 RAS 标记的纯文本导出。
    const numericStart = lines.findIndex((line) => {
      const tokens = line.trim().split(/[\s,;\t]+/).filter(Boolean)
      return tokens.length >= 2 && tokens.every((token) => Number.isFinite(Number(token)))
    })
    if (numericStart < 0) throw new Error('Rigaku .ras 文件缺少数据块')
    dataStart = numericStart
  }

  const x: number[] = []
  const y: number[] = []
  for (let i = dataStart; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (!line || line.startsWith('*')) continue
    const tokens = line.split(/[\s,;\t]+/).filter(Boolean)
    if (tokens.length < 2) continue
    const xValue = Number(tokens[0])
    const yValue = Number(tokens[1])
    if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) continue
    x.push(xValue)
    y.push(yValue)
  }

  if (x.length === 0) throw new Error('Rigaku .ras 数据块为空')

  return buildDataset({
    format: 'rigaku-ras',
    xLabel: '2θ',
    xUnit: '°',
    seriesLabels: [{ label: 'Intensity', unit: metadata.INTENSITY_UNIT }],
    x,
    series: [y],
    metadata,
  })
}

/** Panalytical / Bruker brml 共用的 XML 扫描数据提取。 */
export function parseXrdXml(xml: string, format: string): ParsedDataset {
  const metadata: Record<string, string> = {}

  const capture = (tag: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    return match?.[1]?.trim()
  }

  const startPosition = Number(capture('startPosition') ?? Number.NaN)
  const endPosition = Number(capture('endPosition') ?? Number.NaN)
  if (Number.isFinite(startPosition)) metadata.startPosition = String(startPosition)
  if (Number.isFinite(endPosition)) metadata.endPosition = String(endPosition)

  const countBlocks = [...xml.matchAll(/<counts[^>]*>([\s\S]*?)<\/counts>/gi)].map(
    (match) => match[1] ?? '',
  )
  const positionBlocks = [...xml.matchAll(/<positions[^>]*axis="([^"]*)"[^>]*>([\s\S]*?)<\/positions>/gi)]

  const toNumbers = (text: string): number[] =>
    text
      .split(/[\s,;\t]+/)
      .map((token) => Number(token))
      .filter((value) => Number.isFinite(value))

  const intensities = countBlocks.flatMap(toNumbers)
  if (intensities.length === 0) throw new Error(`${format} XML 中未找到扫描强度数据`)

  let x: number[]
  const thetaBlock = positionBlocks.find((match) => /2theta/i.test(match[1] ?? '')) ?? positionBlocks[0]
  const positions = thetaBlock ? toNumbers(thetaBlock[2] ?? '') : []
  if (positions.length === intensities.length) {
    x = positions
  } else if (Number.isFinite(startPosition) && Number.isFinite(endPosition) && intensities.length > 1) {
    const step = (endPosition - startPosition) / (intensities.length - 1)
    x = intensities.map((_, index) => startPosition + step * index)
  } else {
    x = intensities.map((_, index) => index)
  }

  return buildDataset({
    format,
    xLabel: '2θ',
    xUnit: '°',
    seriesLabels: [{ label: 'Intensity' }],
    x,
    series: [intensities],
    metadata,
  })
}

export function parseBrukerBrmlXml(xml: string): ParsedDataset {
  return parseXrdXml(xml, 'bruker-brml')
}

function isRawHeader(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 16).toString('latin1').toUpperCase()
  return head.startsWith('RAW') || head.startsWith('RAW1.01')
}

/**
 * 在二进制缓冲区内寻找可信的等步长 (x, y) 序列。
 * 仅在头部 8MB 内尝试 float64 / float32，两种字节序。
 */
function recoverNumericScan(buffer: Buffer): { x: number[]; y: number[]; step: number } | null {
  const scanLimit = Math.min(buffer.length, 8 * 1024 * 1024)
  const candidates: Array<{ x: number[]; y: number[]; step: number; score: number }> = []

  const evaluate = (width: 4 | 8, littleEndian: boolean, start: number): void => {
    const read = (offset: number): number => {
      if (offset + width > scanLimit) return Number.NaN
      if (width === 8) return littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset)
      return littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset)
    }

    const x0 = read(start)
    const y0 = read(start + width)
    const x1 = read(start + width * 2)
    const y1 = read(start + width * 3)
    if (![x0, y0, x1, y1].every(Number.isFinite)) return
    if (x0 < -360 || x0 > 360 || x1 <= x0) return
    if (Math.abs(x1 - x0) < 1e-6) return
    if (y0 < 0 || y1 < 0) return

    const step = x1 - x0
    const x: number[] = [x0]
    const y: number[] = [y0]
    let offset = start + width * 2

    while (offset + width * 2 <= scanLimit) {
      const cx = read(offset)
      const cy = read(offset + width)
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) break
      if (cy < 0 || cy > 1e12) break
      const delta = cx - (x[x.length - 1] ?? Number.NaN)
      if (Math.abs(delta - step) > Math.abs(step) * 0.05) break
      x.push(cx)
      y.push(cy)
      offset += width * 2
      if (x.length > 2_000_000) break
    }

    if (x.length < 50) return
    candidates.push({ x, y, step, score: x.length })
  }

  for (let offset = 0; offset + 64 < scanLimit; offset += 8) {
    evaluate(8, true, offset)
    evaluate(8, false, offset)
    evaluate(4, true, offset)
    evaluate(4, false, offset)
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best) return null
  return { x: best.x, y: best.y, step: best.step }
}

/**
 * Bruker 二进制 .raw（启发式恢复）。
 */
export function parseBrukerRaw(buffer: Buffer): ParsedDataset {
  if (!isRawHeader(buffer)) {
    throw new CsLabUnsupportedFormatError('未识别到 Bruker RAW 文件头')
  }

  const recovered = recoverNumericScan(buffer)
  if (!recovered) {
    throw new CsLabUnsupportedFormatError(
      '该 Bruker .raw 变体无法在当前内置解析器中可信恢复扫描数据，建议导出为 .uxd/.brml，或启用 Python(geddes) 增强通道',
    )
  }

  const head = buffer.subarray(0, 64).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').trim()

  return buildDataset({
    format: 'bruker-raw',
    xLabel: '2θ',
    xUnit: '°',
    seriesLabels: [{ label: 'Intensity' }],
    x: recovered.x,
    series: [recovered.y],
    metadata: {
      header: head,
      pointCount: String(recovered.x.length),
      step: String(recovered.step),
      parser: 'heuristic-equidistant-scan',
    },
  })
}
