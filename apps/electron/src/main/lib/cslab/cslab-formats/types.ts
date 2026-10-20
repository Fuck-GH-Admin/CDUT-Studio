/**
 * CSLab 多格式解析的统一数据契约
 *
 * 所有解析器最终都归一化为「一维 X + 若干 Y 序列」的二维连续坐标矩阵，
 * 由 cslab-columnar 写入 Parquet 并生成预览。
 */

import type { CsLabColumn } from '@profer/shared'

export interface ParsedDataset {
  /** 用于 UI 与血缘展示的格式标识，如 'csv' / 'bruker-raw' / 'thermo-spc'。 */
  format: string
  columns: CsLabColumn[]
  x: number[]
  series: Record<string, number[]>
  metadata: Record<string, string>
  rowCount: number
}

/** 明确表达「该变体当前无法解析」，用于诚实降级，绝不伪造数据。 */
export class CsLabUnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsLabUnsupportedFormatError'
  }
}

export function buildDataset(input: {
  format: string
  xLabel: string
  xUnit?: string
  seriesLabels: Array<{ label: string; unit?: string }>
  x: number[]
  series: number[][]
  metadata?: Record<string, string>
}): ParsedDataset {
  const columns: CsLabColumn[] = [{ key: 'x', label: input.xLabel || 'X', unit: input.xUnit }]
  const seriesMap: Record<string, number[]> = {}

  input.seriesLabels.forEach((item, index) => {
    const key = `y${index + 1}`
    columns.push({ key, label: item.label || `Y${index + 1}`, unit: item.unit })
    seriesMap[key] = input.series[index] ?? []
  })

  return {
    format: input.format,
    columns,
    x: input.x,
    series: seriesMap,
    metadata: input.metadata ?? {},
    rowCount: input.x.length,
  }
}

/** 从标签中拆出物理单位：`Temperature (K)` / `Current / mA` / `2θ [deg]`。 */
export function splitLabelUnit(raw: string): { label: string; unit?: string } {
  const text = raw.trim()
  if (!text) return { label: '' }

  const bracket = text.match(/^(.*?)[\s]*[\[(（]([^\]()（）]+)[\])）]\s*$/)
  if (bracket?.[1] && bracket[2]) {
    return { label: bracket[1].trim(), unit: bracket[2].trim() }
  }

  const slash = text.match(/^(.*?)\s*\/\s*([A-Za-z°%‰µμ][\w°%‰µμ/·.^\-]*)$/)
  if (slash?.[1] && slash[2]) {
    return { label: slash[1].trim(), unit: slash[2].trim() }
  }

  return { label: text }
}
