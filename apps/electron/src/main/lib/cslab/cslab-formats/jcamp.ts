/**
 * JCAMP-DX (.dx / .jdx) ASCII 波谱解析器
 *
 * 仅处理最常见的 ##XYDATA=(X++(Y..Y)) 与 ##XYPOINTS 数据块；
 * 其他块（峰表、注释）原样收录为 metadata。
 */

import { buildDataset, type ParsedDataset } from './types'

export function isJcampDx(text: string): boolean {
  return /^##TITLE=/im.test(text) || /^##JCAMP-DX=/im.test(text)
}

function toNumber(token: string): number {
  const cleaned = token.replace(/[()]/g, '')
  return Number(cleaned)
}

export function parseJcampDx(text: string): ParsedDataset {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r\n|\n|\r/)

  const metadata: Record<string, string> = {}
  const dataLines: string[] = []
  let dataMode = ''
  let inData = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('##')) {
      const match = line.match(/^##([^=]+)=(.*)$/)
      if (!match) continue
      const key = (match[1] ?? '').trim()
      const value = (match[2] ?? '').trim()

      if (key === 'XYDATA' || key === 'XYPOINTS') {
        inData = true
        dataMode = value
        metadata[key] = value
        continue
      }

      if (!inData) metadata[key] = value
      else inData = false
      continue
    }

    if (inData) dataLines.push(line)
  }

  if (dataLines.length === 0) {
    throw new Error('JCAMP-DX 文件缺少 XYDATA / XYPOINTS 数据块')
  }

  const compressed = /X\s*\+\+/.test(dataMode)
  const tokensPerLine = dataLines.map((line) => line.split(/[\s,;]+/).filter(Boolean))

  const yValues: number[] = []
  for (const tokens of tokensPerLine) {
    const relevant = compressed ? tokens.slice(1) : tokens
    for (const token of relevant) {
      const value = toNumber(token)
      if (Number.isFinite(value)) yValues.push(value)
      else if (token === '?' || token === '') yValues.push(Number.NaN)
    }
  }

  if (yValues.length === 0) throw new Error('JCAMP-DX 数据块为空')

  const firstX = Number(metadata.FIRSTX ?? metadata['FIRST X'] ?? Number.NaN)
  const lastX = Number(metadata.LASTX ?? metadata['LAST X'] ?? Number.NaN)
  const deltaX = Number(metadata.DELTAX ?? metadata['DELTA X'] ?? Number.NaN)

  let x: number[]
  if (Number.isFinite(firstX) && Number.isFinite(deltaX)) {
    x = yValues.map((_, index) => firstX + deltaX * index)
  } else if (Number.isFinite(firstX) && Number.isFinite(lastX) && yValues.length > 1) {
    const step = (lastX - firstX) / (yValues.length - 1)
    x = yValues.map((_, index) => firstX + step * index)
  } else {
    x = yValues.map((_, index) => index)
  }

  const xUnits = metadata.XUNITS ?? metadata['XUNITS'] ?? ''
  const yUnits = metadata.YUNITS ?? metadata['YUNITS'] ?? ''

  return buildDataset({
    format: 'jcamp-dx',
    xLabel: metadata.XLABEL ?? 'X',
    xUnit: xUnits || undefined,
    seriesLabels: [{ label: metadata.YLABEL ?? 'Y', unit: yUnits || undefined }],
    x,
    series: [yValues],
    metadata,
  })
}
