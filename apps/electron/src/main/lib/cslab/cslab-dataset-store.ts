/**
 * 数字化图表与数据表落盘
 *
 * 将前端确认后的曲线保存为六维资产：
 *   lit (来源文献) -> fig (框选图像) -> table (数字化数值表)
 *
 * 红线：数据必须来自用户确认的 series，绝不在主进程重新拟合或补点。
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type {
  CsLabColumn,
  CsLabDigitizedFigureInput,
  CsLabDigitizedFigureResult,
} from '@profer/shared'
import { writeDatasetParquet, writeDatasetPreview } from './cslab-columnar'
import { buildDataset, type ParsedDataset } from './cslab-formats/types'
import {
  getCsLabDatabase,
  insertEdge,
  nextLabRevision,
  upsertEntity,
  upsertTable,
  withTransaction,
  type CsLabDatabase,
  type CsLabEntityRecord,
} from './cslab-db'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import { writeBufferAtomic } from './cslab-atomic'

interface CleanSeries {
  label: string
  points: Array<[number, number]>
}

function cleanSeries(raw: CsLabDigitizedFigureInput['series']): CleanSeries[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((series, index) => {
      const points = (Array.isArray(series.points) ? series.points : [])
        .filter(
          (point): point is [number, number] =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1])),
        )
        .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
        .sort((a, b) => a[0] - b[0])
      return {
        label: series.label?.trim() || `Y${index + 1}`,
        points,
      }
    })
    .filter((series) => series.points.length >= 2)
}

/** 将不同长度的曲线按主 X 轴线性插值对齐（仅用于同图多曲线）。 */
function alignSeries(series: CleanSeries[]): ParsedDataset | null {
  if (series.length === 0) return null
  const primary = series.reduce((best, current) =>
    current.points.length > best.points.length ? current : best,
  )
  const xGrid = primary.points.map((point) => point[0])

  const interpolate = (points: Array<[number, number]>, x: number): number => {
    if (x <= points[0]![0]) return points[0]![1]
    if (x >= points[points.length - 1]![0]) return points[points.length - 1]![1]
    let low = 0
    let high = points.length - 1
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (points[middle]![0] <= x) low = middle
      else high = middle
    }
    const left = points[low]!
    const right = points[high]!
    const span = right[0] - left[0]
    if (span === 0) return left[1]
    const ratio = (x - left[0]) / span
    return left[1] + ratio * (right[1] - left[1])
  }

  const ySeries = series.map((item) => xGrid.map((x) => interpolate(item.points, x)))
  return buildDataset({
    format: 'digitized',
    xLabel: 'X',
    seriesLabels: series.map((item) => ({ label: item.label })),
    x: xGrid,
    series: ySeries,
    metadata: { source: 'plot-digitizer', series: String(series.length) },
  })
}

function decodePng(dataUrl: string): Buffer {
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('框选图像格式无效')
  const buffer = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64')
  if (buffer.length === 0) throw new Error('框选图像为空')
  return buffer
}

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

export async function persistDigitizedFigure(
  input: CsLabDigitizedFigureInput,
): Promise<CsLabDigitizedFigureResult> {
  const labId = assertLabId(input.labId)
  const series = cleanSeries(input.series)
  if (series.length === 0) throw new Error('没有可保存的数字化曲线')
  const dataset = alignSeries(series)
  if (!dataset) throw new Error('曲线点不足，无法生成数据表')

  const title = input.title?.trim() || '数字化图表'
  const image = decodePng(input.imageDataUrl)
  const now = Date.now()
  const figUuid = `fig-${randomUUID().slice(0, 8)}`
  const tableUuid = `table-${randomUUID().slice(0, 8)}`
  const figUri = buildCsLabUri(labId, 'fig', figUuid)
  const tableUri = buildCsLabUri(labId, 'table', tableUuid)
  const figRelPath = `vault/figures/${figUuid}.png`
  const tableRelPath = `vault/tables/${tableUuid}.parquet`
  const previewRelPath = `vault/tables/${tableUuid}.preview.json`
  const sha256 = createHash('sha256').update(image).digest('hex')

  await writeBufferAtomic(resolveLabRelativePath(labId, figRelPath), image)
  const parquet = await writeDatasetParquet(dataset, resolveLabRelativePath(labId, tableRelPath))
  await writeDatasetPreview(dataset, resolveLabRelativePath(labId, previewRelPath))

  const db = labDb(labId)
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    const figEntity: CsLabEntityRecord = {
      uri: figUri,
      labId,
      layerType: 'fig',
      entityUuid: figUuid,
      title: `${title} · 框选图像`,
      format: 'png',
      relPath: figRelPath,
      sha256,
      bytes: image.length,
      revision,
      locked: false,
      createdAt: now,
      updatedAt: now,
    }
    const tableEntity: CsLabEntityRecord = {
      uri: tableUri,
      labId,
      layerType: 'table',
      entityUuid: tableUuid,
      title: `${title} · 数字化数据`,
      format: 'digitized',
      relPath: tableRelPath,
      sha256,
      bytes: parquet.bytes,
      revision,
      locked: true,
      createdAt: now,
      updatedAt: now,
    }
    upsertEntity(db, figEntity)
    upsertEntity(db, tableEntity)
    upsertTable(db, {
      uri: tableUri,
      parquetRelPath: tableRelPath,
      previewRelPath,
      columnsJson: JSON.stringify(dataset.columns as CsLabColumn[]),
      rowCount: dataset.rowCount,
      revision,
    })
    if (input.sourceUri) {
      insertEdge(db, labId, input.sourceUri, figUri, 'digitized_from', {
        calibration: input.calibration,
        capturedAt: now,
      })
    }
    insertEdge(db, labId, figUri, tableUri, 'derived_from', {
      rowCount: dataset.rowCount,
      series: series.length,
    })
    return revision
  })

  return {
    figUri,
    tableUri,
    rowCount: dataset.rowCount,
    message: `已保存 ${series.length} 条曲线、${dataset.rowCount} 行数据`,
  }
}
