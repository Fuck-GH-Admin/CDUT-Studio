/**
 * 图表逆向数字化 TS 包装层
 *
 * 职责：校验渲染进程传入的 dataURL、落临时文件、调用 Python 脚本、归一化 JSON。
 * 红线：Python 不可用或失败时返回 ok:false 与原因，绝不生成伪造曲线。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CsLabDigitizedSeries,
  CsLabPlotDigitizeInput,
  CsLabPlotDigitizeResult,
} from '@profer/shared'
import { assertLabId } from './cslab-paths'
import {
  defaultCsLabPythonRunner,
  type CsLabPythonRunner,
} from './cslab-python-runtime'

const MAX_IMAGE_BYTES = 24 * 1024 * 1024

interface RawDigitizePayload {
  ok?: boolean
  message?: string
  width?: number
  height?: number
  rotationDeg?: number
  axisFit?: {
    x?: { scale?: string; r2?: number }
    y?: { scale?: string; r2?: number }
  }
  series?: Array<{
    label?: string
    points?: Array<[number, number]>
    pixels?: Array<[number, number]>
  }>
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; extension: string } {
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('框选图像格式无效（仅支持 PNG/JPEG dataURL）')
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1]!
  const buffer = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64')
  if (buffer.length === 0) throw new Error('框选图像为空')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('框选图像超过 24MB，请缩小框选范围')
  return { buffer, extension }
}

function normalizeSeries(raw: RawDigitizePayload['series']): CsLabDigitizedSeries[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index) => {
      const points = Array.isArray(item.points)
        ? item.points
            .filter(
              (point): point is [number, number] =>
                Array.isArray(point) &&
                point.length >= 2 &&
                Number.isFinite(Number(point[0])) &&
                Number.isFinite(Number(point[1])),
            )
            .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
        : []
      const pixels = Array.isArray(item.pixels)
        ? item.pixels
            .filter(
              (point): point is [number, number] =>
                Array.isArray(point) &&
                point.length >= 2 &&
                Number.isFinite(Number(point[0])) &&
                Number.isFinite(Number(point[1])),
            )
            .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
        : []
      return {
        label: item.label ?? `series-${index + 1}`,
        points,
        pixels,
      }
    })
    .filter((item) => item.points.length >= 2)
}

function normalizeScale(value: string | undefined): 'linear' | 'log' {
  return value === 'log' ? 'log' : 'linear'
}

export async function digitizePlot(
  input: CsLabPlotDigitizeInput,
  runner: CsLabPythonRunner = defaultCsLabPythonRunner,
): Promise<CsLabPlotDigitizeResult> {
  const labId = assertLabId(input.labId)
  const image = parseDataUrl(input.imageDataUrl)

  if (!input.calibration?.x?.ticks || !input.calibration?.y?.ticks) {
    throw new Error('缺少坐标轴标定刻度')
  }
  if (input.calibration.x.ticks.length < 2 || input.calibration.y.ticks.length < 2) {
    throw new Error('X/Y 轴各至少需要 2 个标定刻度')
  }

  const tempDir = await fs.mkdtemp(join(tmpdir(), 'cslab-plot-'))
  const imagePath = join(tempDir, `crop-${randomUUID().slice(0, 8)}.${image.extension}`)
  try {
    await fs.writeFile(imagePath, image.buffer)
    const args = [
      '--input',
      imagePath,
      '--calibration',
      JSON.stringify(input.calibration),
      '--mode',
      input.mode,
      '--tolerance',
      String(Math.max(8, Math.min(60, input.tolerance ?? 28))),
    ]
    if (input.color) args.push('--color', input.color)

    const stdout = await runner.runPython(labId, 'cslab-plot-digitizer.py', args, {
      timeoutMs: 120_000,
    })
    const payload = JSON.parse(stdout.trim()) as RawDigitizePayload
    const series = normalizeSeries(payload.series)

    if (!payload.ok || series.length === 0) {
      return {
        ok: false,
        message: payload.message ?? '未能从框选区域提取到有效曲线',
        width: Number(payload.width ?? 0),
        height: Number(payload.height ?? 0),
        series: [],
      }
    }

    return {
      ok: true,
      width: Number(payload.width ?? 0),
      height: Number(payload.height ?? 0),
      rotationDeg: Number(payload.rotationDeg ?? 0),
      axisFit: {
        x: {
          scale: normalizeScale(payload.axisFit?.x?.scale),
          r2: Number(payload.axisFit?.x?.r2 ?? 0),
        },
        y: {
          scale: normalizeScale(payload.axisFit?.y?.scale),
          r2: Number(payload.axisFit?.y?.r2 ?? 0),
        },
      },
      series,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '图表数字化失败',
      width: 0,
      height: 0,
      series: [],
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
