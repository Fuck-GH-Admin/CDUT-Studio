/**
 * SKLGP 泥石流灾害动力学核心
 *
 * - ESRI ASCII Grid / GeoTIFF 高程栅格解析（NaN / NODATA 隔离）；
 * - 坡度、坡向、D8 流向与汇流累积；
 * - 经验幂律 I-D 临界降雨拟合；
 * - 二维深度积分浅水波 + Voellmy / Bingham 流变；
 * - 危险性分级 PNG 图版。
 *
 * 红线：这是工程简化模型，不是 FLO-2D / Massflow 认证结果；所有输出必须标注假设与局限。
 */

import { PNG } from 'pngjs'
import type {
  CsLabDebrisFlowRheology,
  CsLabDebrisFlowSimulationInput,
  CsLabDebrisFlowSimulationResult,
  CsLabDebrisFlowTimePoint,
  CsLabGeoRaster,
  CsLabGeoRasterMeta,
  CsLabRainfallPoint,
  CsLabRainfallThresholdResult,
} from '@profer/shared'

const GRAVITY = 9.81
const RHO = 2000
const MIN_DEPTH = 1e-4
const HAZARD_HIGH_DEPTH = 1.0
const HAZARD_MEDIUM_DEPTH = 0.3
const HAZARD_LOW_DEPTH = 0.05

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 解析 ESRI ASCII Grid。 */
export function parseEsriAsciiGrid(text: string): CsLabGeoRaster {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const header: Record<string, number> = {}
  let dataStart = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line) continue
    const match = /^([A-Za-z_]+)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line)
    if (!match) {
      dataStart = index
      break
    }
    header[match[1]!.toLowerCase()] = Number(match[2])
    dataStart = index + 1
  }

  const width = header.ncols
  const height = header.nrows
  if (!width || !height || width < 2 || height < 2) {
    throw new Error('ESRI ASCII Grid 缺少有效的 ncols/nrows')
  }
  const cellsize = header.cellsize ?? header.dx ?? 1
  const nodata = header.nodata_value
  const values = new Float32Array(width * height).fill(Number.NaN)

  let cursor = dataStart
  let written = 0
  while (cursor < lines.length && written < values.length) {
    const tokens = lines[cursor]!.trim().split(/\s+/).filter(Boolean)
    for (const token of tokens) {
      if (written >= values.length) break
      const value = Number(token)
      values[written] = Number.isFinite(value) && (nodata === undefined || value !== nodata)
        ? value
        : Number.NaN
      written += 1
    }
    cursor += 1
  }
  if (written < values.length) {
    throw new Error(`ESRI ASCII Grid 数据不足：期望 ${values.length} 个网格，实际 ${written} 个`)
  }

  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min)) throw new Error('ESRI ASCII Grid 不包含有效高程')

  return {
    meta: {
      width,
      height,
      cellsize,
      xllcorner: header.xllcorner ?? 0,
      yllcorner: header.yllcorner ?? 0,
      ...(nodata !== undefined ? { nodata } : {}),
      min,
      max,
      kind: 'esri-ascii',
    },
    values,
  }
}

/** 写出 ESRI ASCII Grid。 */
export function writeEsriAsciiGrid(meta: CsLabGeoRasterMeta, values: Float32Array): string {
  const nodata = meta.nodata ?? -9999
  const lines: string[] = [
    `ncols ${meta.width}`,
    `nrows ${meta.height}`,
    `xllcorner ${meta.xllcorner}`,
    `yllcorner ${meta.yllcorner}`,
    `cellsize ${meta.cellsize}`,
    `NODATA_value ${nodata}`,
  ]
  for (let row = 0; row < meta.height; row += 1) {
    const rowValues: string[] = []
    for (let col = 0; col < meta.width; col += 1) {
      const value = values[row * meta.width + col]
      rowValues.push(Number.isFinite(value) ? String(Math.round(value! * 1000) / 1000) : String(nodata))
    }
    lines.push(rowValues.join(' '))
  }
  return `${lines.join('\n')}\n`
}

interface UtifIfd {
  width?: number
  height?: number
  isLE?: boolean
  data?: Uint8Array
  t256?: number[]
  t257?: number[]
  t258?: number[]
  t259?: number[]
  t339?: number[]
  t33550?: number[]
  t33922?: number[]
  t42113?: string[]
}

/** 解析 GeoTIFF（优先 32-bit float，兼容 8/16-bit 整数）。 */
export async function parseGeoTiffGrid(buffer: Buffer): Promise<CsLabGeoRaster> {
  const utifModule = await import('utif')
  const UTIF = (utifModule as unknown as { default?: unknown }).default ?? utifModule
  const decoder = UTIF as {
    decode: (buffer: Uint8Array | ArrayBuffer) => UtifIfd[]
    decodeImage: (buffer: Uint8Array | ArrayBuffer, ifd: UtifIfd) => void
  }

  const ifds = decoder.decode(buffer)
  const ifd = ifds[0]
  if (!ifd) throw new Error('GeoTIFF 没有可读的 IFD')
  decoder.decodeImage(buffer, ifd)

  const width = ifd.width ?? ifd.t256?.[0] ?? 0
  const height = ifd.height ?? ifd.t257?.[0] ?? 0
  if (width < 2 || height < 2) throw new Error('GeoTIFF 尺寸非法')
  if (!ifd.data) throw new Error('GeoTIFF 像素数据解码失败')

  const bits = ifd.t258?.[0] ?? 8
  const sampleFormat = ifd.t339?.[0] ?? 1
  const count = width * height
  const values = new Float32Array(count).fill(Number.NaN)
  const warnings: string[] = []

  if (bits === 32 && sampleFormat === 3) {
    const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, Math.min(ifd.data.byteLength, count * 4))
    const little = ifd.isLE !== false
    for (let index = 0; index < view.byteLength / 4 && index < count; index += 1) {
      values[index] = view.getFloat32(index * 4, little)
    }
  } else if (bits === 16) {
    const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, Math.min(ifd.data.byteLength, count * 2))
    const little = ifd.isLE !== false
    for (let index = 0; index < count; index += 1) {
      const offset = index * 2
      if (offset + 2 > view.byteLength) break
      values[index] = sampleFormat === 2 ? view.getInt16(offset, little) : view.getUint16(offset, little)
    }
  } else {
    if (bits !== 8) warnings.push(`未识别的 ${bits}-bit 采样，按 8-bit 读取`)
    for (let index = 0; index < count && index < ifd.data.length; index += 1) {
      values[index] = ifd.data[index]!
    }
  }

  const nodataRaw = ifd.t42113?.[0]
  const nodata = nodataRaw !== undefined ? Number(String(nodataRaw).replace(/\0/g, '').trim()) : undefined
  let min = Infinity
  let max = -Infinity
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (!Number.isFinite(value) || (nodata !== undefined && value === nodata)) {
      values[index] = Number.NaN
      continue
    }
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min)) throw new Error('GeoTIFF 不包含有效高程')

  const scale = ifd.t33550
  const tiepoint = ifd.t33922
  const scaleX = isFiniteNumber(scale?.[0]) ? scale![0]! : 1
  const scaleY = isFiniteNumber(scale?.[1]) ? scale![1]! : 1
  const tieX = isFiniteNumber(tiepoint?.[3]) ? tiepoint![3]! : 0
  const tieY = isFiniteNumber(tiepoint?.[4]) ? tiepoint![4]! : 0
  const tieRow = isFiniteNumber(tiepoint?.[1]) ? tiepoint![1]! : 0
  if (!scale || !tiepoint) warnings.push('GeoTIFF 缺少 ModelPixelScale/ModelTiepoint，坐标按本地 0,0 处理')

  return {
    meta: {
      width,
      height,
      cellsize: Math.abs(scaleX) || 1,
      xllcorner: tieX - (tiepoint?.[0] ?? 0) * scaleX,
      yllcorner: tieY - (height - tieRow) * scaleY,
      ...(nodata !== undefined ? { nodata } : {}),
      min,
      max,
      kind: 'geotiff',
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    values,
  }
}

export async function parseGeoRasterBuffer(
  buffer: Buffer,
  fileName: string,
): Promise<CsLabGeoRaster> {
  if (/\.(tif|tiff)$/i.test(fileName)) return parseGeoTiffGrid(buffer)
  return parseEsriAsciiGrid(buffer.toString('utf-8'))
}

export interface DemAnalysis {
  meanSlopeDeg: number
  maxSlopeDeg: number
  dominantAspect: string
  flowDirectionCounts: Record<string, number>
  flowAccumulation: Float32Array
  channelThreshold: number
  channelCount: number
  suggestedSource: { row: number; col: number; elevation: number }
  validCells: number
}

const D8_DIRECTIONS: Array<{ name: string; dr: number; dc: number }> = [
  { name: 'N', dr: -1, dc: 0 },
  { name: 'NE', dr: -1, dc: 1 },
  { name: 'E', dr: 0, dc: 1 },
  { name: 'SE', dr: 1, dc: 1 },
  { name: 'S', dr: 1, dc: 0 },
  { name: 'SW', dr: 1, dc: -1 },
  { name: 'W', dr: 0, dc: -1 },
  { name: 'NW', dr: -1, dc: -1 },
]

function aspectLabel(degrees: number): string {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const index = Math.round(((degrees % 360) + 360) % 360 / 45) % 8
  return labels[index]!
}

/** 坡度/坡向/D8/汇流；所有差分先做 NaN 屏蔽。 */
export function analyzeDem(raster: CsLabGeoRaster): DemAnalysis {
  const { width, height, cellsize } = raster.meta
  const values = raster.values
  const valid = new Uint8Array(width * height)
  let validCells = 0
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(values[index])) {
      valid[index] = 1
      validCells += 1
    }
  }
  if (validCells === 0) throw new Error('DEM 没有有效高程')

  const slope = new Float32Array(width * height)
  const aspect = new Float32Array(width * height)
  const down = new Int32Array(width * height).fill(-1)
  const directionCounts: Record<string, number> = {}
  let slopeSum = 0
  let slopeMax = 0

  const at = (row: number, col: number): number => (
    row < 0 || row >= height || col < 0 || col >= width ? Number.NaN : values[row * width + col]!
  )

  for (let row = 1; row < height - 1; row += 1) {
    for (let col = 1; col < width - 1; col += 1) {
      const index = row * width + col
      if (!valid[index]) continue
      const z = values[index]!
      const z00 = at(row - 1, col - 1)
      const z01 = at(row - 1, col)
      const z02 = at(row - 1, col + 1)
      const z10 = at(row, col - 1)
      const z12 = at(row, col + 1)
      const z20 = at(row + 1, col - 1)
      const z21 = at(row + 1, col)
      const z22 = at(row + 1, col + 1)
      if (![z00, z01, z02, z10, z12, z20, z21, z22].every(Number.isFinite)) continue

      const dzdx = ((z02 + 2 * z12 + z22) - (z00 + 2 * z10 + z20)) / (8 * cellsize)
      const dzdy = ((z20 + 2 * z21 + z22) - (z00 + 2 * z01 + z02)) / (8 * cellsize)
      const slopeRad = Math.atan(Math.hypot(dzdx, dzdy))
      const slopeDeg = slopeRad * 180 / Math.PI
      slope[index] = slopeDeg
      slopeSum += slopeDeg
      if (slopeDeg > slopeMax) slopeMax = slopeDeg
      // 地形坐标：x 向东、y 向北；保证坡向 0=N、90=E。
      const aspectDeg = (Math.atan2(dzdx, -dzdy) * 180 / Math.PI + 360) % 360
      aspect[index] = aspectDeg

      let bestDirection = -1
      let bestGradient = 0
      for (let dirIndex = 0; dirIndex < D8_DIRECTIONS.length; dirIndex += 1) {
        const dir = D8_DIRECTIONS[dirIndex]!
        const neighbor = at(row + dir.dr, col + dir.dc)
        if (!Number.isFinite(neighbor)) continue
        const distance = Math.hypot(dir.dr, dir.dc) * cellsize
        const gradient = (z - neighbor) / distance
        if (gradient > bestGradient) {
          bestGradient = gradient
          bestDirection = dirIndex
        }
      }
      if (bestDirection >= 0) {
        const dir = D8_DIRECTIONS[bestDirection]!
        down[index] = (row + dir.dr) * width + (col + dir.dc)
        directionCounts[dir.name] = (directionCounts[dir.name] ?? 0) + 1
      }
    }
  }

  const accumulation = new Float32Array(width * height)
  const order: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    accumulation[index] = valid[index] ? 1 : 0
    if (valid[index]) order.push(index)
  }
  order.sort((a, b) => values[b]! - values[a]!)
  for (const index of order) {
    const downstream = down[index]!
    if (downstream >= 0) accumulation[downstream] = accumulation[downstream]! + accumulation[index]!
  }

  const channelThreshold = Math.max(50, Math.round(validCells * 0.02))
  let channelCount = 0
  let sourceIndex = -1
  let sourceElevation = -Infinity
  for (let index = 0; index < accumulation.length; index += 1) {
    if (!valid[index] || accumulation[index]! < channelThreshold) continue
    channelCount += 1
    const elevation = values[index]!
    if (elevation > sourceElevation) {
      sourceElevation = elevation
      sourceIndex = index
    }
  }
  if (sourceIndex < 0) {
    // 没有形成沟道时，用最高点作为源区，保证工具仍可给出可解释结果。
    for (let index = 0; index < values.length; index += 1) {
      if (!valid[index]) continue
      if (values[index]! > sourceElevation) {
        sourceElevation = values[index]!
        sourceIndex = index
      }
    }
  }

  let dominantAspect = 'N'
  const aspectCounts = new Map<string, number>()
  for (let index = 0; index < aspect.length; index += 1) {
    if (!valid[index]) continue
    const label = aspectLabel(aspect[index]!)
    aspectCounts.set(label, (aspectCounts.get(label) ?? 0) + 1)
  }
  let dominantCount = -1
  for (const [label, count] of aspectCounts) {
    if (count > dominantCount) {
      dominantCount = count
      dominantAspect = label
    }
  }

  return {
    meanSlopeDeg: slopeSum / Math.max(1, validCells),
    maxSlopeDeg: slopeMax,
    dominantAspect,
    flowDirectionCounts: directionCounts,
    flowAccumulation: accumulation,
    channelThreshold,
    channelCount,
    suggestedSource: {
      row: Math.floor(sourceIndex / width),
      col: sourceIndex % width,
      elevation: sourceElevation,
    },
    validCells,
  }
}

/** 经验幂律 I = alpha * D^(-beta) 的对数域最小二乘拟合。 */
export function fitRainfallThreshold(
  points: CsLabRainfallPoint[],
): { alpha: number; beta: number; rSquared: number } {
  const usable = points.filter((point) => (
    point.durationMin > 0 && point.intensityMmPerHour > 0
  ))
  if (usable.length < 2) throw new Error('至少需要 2 个有效的 I-D 临界点')
  const xs = usable.map((point) => Math.log10(point.durationMin))
  const ys = usable.map((point) => Math.log10(point.intensityMmPerHour))
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index]! - meanX) * (ys[index]! - meanY)
    denominator += (xs[index]! - meanX) ** 2
  }
  if (denominator === 0) throw new Error('I-D 临界点的历时完全重复，无法拟合')
  const slope = numerator / denominator
  const intercept = meanY - slope * meanX
  let ssRes = 0
  let ssTot = 0
  for (let index = 0; index < xs.length; index += 1) {
    const predicted = intercept + slope * xs[index]!
    ssRes += (ys[index]! - predicted) ** 2
    ssTot += (ys[index]! - meanY) ** 2
  }
  return {
    alpha: 10 ** intercept,
    beta: -slope,
    rSquared: ssTot > 0 ? 1 - ssRes / ssTot : 1,
  }
}

export function buildRainfallThresholdResult(
  input: { points?: CsLabRainfallPoint[]; alpha?: number; beta?: number; durationsMin?: number[] },
): CsLabRainfallThresholdResult {
  let alpha = input.alpha
  let beta = input.beta
  let rSquared: number | undefined
  let usedDefaultParameters = false
  if (input.points && input.points.length >= 2) {
    const fitted = fitRainfallThreshold(input.points)
    alpha = fitted.alpha
    beta = fitted.beta
    rSquared = fitted.rSquared
  }
  if (!isFiniteNumber(alpha) || !isFiniteNumber(beta) || alpha! <= 0 || beta! < 0) {
    alpha = 30
    beta = 0.6
    usedDefaultParameters = true
    rSquared = undefined
  }
  const durations = (input.durationsMin && input.durationsMin.length > 0
    ? input.durationsMin
    : [10, 20, 30, 60, 120, 180, 360, 720, 1440]
  ).filter((value) => value > 0).sort((a, b) => a - b)
  const curve = durations.map((durationMin) => ({
    durationMin,
    intensityMmPerHour: alpha! * durationMin ** (-beta!),
  }))
  return {
    ok: true,
    alpha: alpha!,
    beta: beta!,
    rSquared,
    curve,
    designIntensity: curve.find((point) => point.durationMin === 60)?.intensityMmPerHour
      ?? curve[Math.floor(curve.length / 2)]?.intensityMmPerHour,
    usedDefaultParameters,
    ...(usedDefaultParameters
      ? { message: '未提供足够的 I-D 临界点，已使用区域示例参数（alpha=30, beta=0.6），正式应用需本地校核。' }
      : {}),
  }
}

export interface SimulationGrid {
  width: number
  height: number
  cellsize: number
  z: Float32Array
  valid: Uint8Array
  h: Float32Array
  qx: Float32Array
  qy: Float32Array
  deposit: Float32Array
  maxH: Float32Array
  maxSpeed: Float32Array
  arrival: Float32Array
}

function createSimulationGrid(raster: CsLabGeoRaster): SimulationGrid {
  const { width, height, cellsize } = raster.meta
  const valid = new Uint8Array(width * height)
  for (let index = 0; index < raster.values.length; index += 1) {
    valid[index] = Number.isFinite(raster.values[index]) ? 1 : 0
  }
  return {
    width,
    height,
    cellsize,
    z: raster.values,
    valid,
    h: new Float32Array(width * height),
    qx: new Float32Array(width * height),
    qy: new Float32Array(width * height),
    deposit: new Float32Array(width * height),
    maxH: new Float32Array(width * height),
    maxSpeed: new Float32Array(width * height),
    arrival: new Float32Array(width * height).fill(Number.NaN),
  }
}

function boundaryClosedFlux(grid: SimulationGrid, row: number, col: number): boolean {
  return row < 0 || row >= grid.height || col < 0 || col >= grid.width || !grid.valid[row * grid.width + col]
}

function fluxX(grid: SimulationGrid, index: number, neighbor: number): { h: number; qx: number; qy: number } {
  const hL = grid.h[index]!
  const hR = grid.h[neighbor]!
  const uL = hL > MIN_DEPTH ? grid.qx[index]! / hL : 0
  const uR = hR > MIN_DEPTH ? grid.qx[neighbor]! / hR : 0
  const vL = hL > MIN_DEPTH ? grid.qy[index]! / hL : 0
  const vR = hR > MIN_DEPTH ? grid.qy[neighbor]! / hR : 0
  const fhL = grid.qx[index]!
  const fhR = grid.qx[neighbor]!
  const fqxL = uL * uL * hL + 0.5 * GRAVITY * hL * hL
  const fqxR = uR * uR * hR + 0.5 * GRAVITY * hR * hR
  const fqyL = uL * vL * hL
  const fqyR = uR * vR * hR
  const wave = Math.max(
    Math.abs(uL) + Math.sqrt(GRAVITY * Math.max(hL, 0)),
    Math.abs(uR) + Math.sqrt(GRAVITY * Math.max(hR, 0)),
  )
  return {
    h: 0.5 * (fhL + fhR) - 0.5 * wave * (hR - hL),
    qx: 0.5 * (fqxL + fqxR) - 0.5 * wave * (grid.qx[neighbor]! - grid.qx[index]!),
    qy: 0.5 * (fqyL + fqyR) - 0.5 * wave * (grid.qy[neighbor]! - grid.qy[index]!),
  }
}

function fluxY(grid: SimulationGrid, index: number, neighbor: number): { h: number; qx: number; qy: number } {
  const hL = grid.h[index]!
  const hR = grid.h[neighbor]!
  const uL = hL > MIN_DEPTH ? grid.qx[index]! / hL : 0
  const uR = hR > MIN_DEPTH ? grid.qx[neighbor]! / hR : 0
  const vL = hL > MIN_DEPTH ? grid.qy[index]! / hL : 0
  const vR = hR > MIN_DEPTH ? grid.qy[neighbor]! / hR : 0
  const fhL = grid.qy[index]!
  const fhR = grid.qy[neighbor]!
  const fqxL = uL * vL * hL
  const fqxR = uR * vR * hR
  const fqyL = vL * vL * hL + 0.5 * GRAVITY * hL * hL
  const fqyR = vR * vR * hR + 0.5 * GRAVITY * hR * hR
  const wave = Math.max(
    Math.abs(vL) + Math.sqrt(GRAVITY * Math.max(hL, 0)),
    Math.abs(vR) + Math.sqrt(GRAVITY * Math.max(hR, 0)),
  )
  return {
    h: 0.5 * (fhL + fhR) - 0.5 * wave * (hR - hL),
    qx: 0.5 * (fqxL + fqxR) - 0.5 * wave * (grid.qx[neighbor]! - grid.qx[index]!),
    qy: 0.5 * (fqyL + fqyR) - 0.5 * wave * (grid.qy[neighbor]! - grid.qy[index]!),
  }
}

function basalDeceleration(
  rheology: CsLabDebrisFlowRheology,
  h: number,
  speed: number,
): number {
  if (rheology.model === 'voellmy') {
    const mu = Math.max(0, rheology.mu)
    const xi = Math.max(1, rheology.xi)
    return mu * GRAVITY + GRAVITY * speed * speed / (xi * Math.max(h, 0.01))
  }
  const yieldStress = Math.max(0, rheology.yieldStressPa)
  const viscosity = Math.max(0, rheology.viscosityPaS)
  return (yieldStress + 3 * viscosity * speed / Math.max(h, 0.01)) / (RHO * Math.max(h, 0.01))
}

function stepGrid(
  grid: SimulationGrid,
  dt: number,
  rheology: CsLabDebrisFlowRheology,
  depositionVelocity: number,
): void {
  const { width, height, cellsize, z, h, qx, qy } = grid
  const nextH = new Float32Array(h.length)
  const nextQx = new Float32Array(qx.length)
  const nextQy = new Float32Array(qy.length)

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col
      if (!grid.valid[index]) continue
      const left = col > 0 && !boundaryClosedFlux(grid, row, col - 1)
        ? fluxX(grid, index, index - 1)
        : { h: 0, qx: 0, qy: 0 }
      const right = col < width - 1 && !boundaryClosedFlux(grid, row, col + 1)
        ? fluxX(grid, index, index + 1)
        : { h: 0, qx: 0, qy: 0 }
      const up = row > 0 && !boundaryClosedFlux(grid, row - 1, col)
        ? fluxY(grid, index, index - width)
        : { h: 0, qx: 0, qy: 0 }
      const down = row < height - 1 && !boundaryClosedFlux(grid, row + 1, col)
        ? fluxY(grid, index, index + width)
        : { h: 0, qx: 0, qy: 0 }

      let nextDepth = h[index]! - dt / cellsize * ((right.h - left.h) + (down.h - up.h))
      let nextX = qx[index]! - dt / cellsize * ((right.qx - left.qx) + (down.qx - up.qx))
      let nextY = qy[index]! - dt / cellsize * ((right.qy - left.qy) + (down.qy - up.qy))

      // 底坡源项：中心差分 + 有效邻域；无效邻域按零坡处理。
      const zL = col > 0 && grid.valid[index - 1] ? z[index - 1]! : z[index]!
      const zR = col < width - 1 && grid.valid[index + 1] ? z[index + 1]! : z[index]!
      const zU = row > 0 && grid.valid[index - width] ? z[index - width]! : z[index]!
      const zD = row < height - 1 && grid.valid[index + width] ? z[index + width]! : z[index]!
      const dzdx = (zR - zL) / (2 * cellsize)
      const dzdy = (zD - zU) / (2 * cellsize)
      const depthForSource = Math.max(nextDepth, 0)
      nextX -= dt * GRAVITY * depthForSource * dzdx
      nextY -= dt * GRAVITY * depthForSource * dzdy

      if (nextDepth < MIN_DEPTH) {
        nextDepth = 0
        nextX = 0
        nextY = 0
      } else {
        const speed = Math.hypot(nextX, nextY) / nextDepth
        const deceleration = basalDeceleration(rheology, nextDepth, speed)
        if (speed > 1e-6) {
          const factor = Math.min(1, dt * deceleration / speed)
          nextX -= nextX * factor
          nextY -= nextY * factor
        }
      }

      // 数值保护：NaN 一律清零，避免整张网格污染。
      if (!Number.isFinite(nextDepth)) nextDepth = 0
      if (!Number.isFinite(nextX)) nextX = 0
      if (!Number.isFinite(nextY)) nextY = 0

      nextH[index] = nextDepth
      nextQx[index] = nextX
      nextQy[index] = nextY
    }
  }

  for (let index = 0; index < h.length; index += 1) {
    if (!grid.valid[index]) continue
    let depth = nextH[index]!
    let x = nextQx[index]!
    let y = nextQy[index]!
    const speed = depth > MIN_DEPTH ? Math.hypot(x, y) / depth : 0
    if (depth > MIN_DEPTH && speed < depositionVelocity) {
      const deposit = Math.min(depth, depth * 0.05)
      grid.deposit[index] = grid.deposit[index]! + deposit
      depth -= deposit
      if (depth < MIN_DEPTH) {
        depth = 0
        x = 0
        y = 0
      }
    }
    h[index] = depth
    qx[index] = x
    qy[index] = y
    if (depth > grid.maxH[index]!) grid.maxH[index] = depth
    const finalSpeed = depth > MIN_DEPTH ? Math.hypot(x, y) / depth : 0
    if (finalSpeed > grid.maxSpeed[index]!) grid.maxSpeed[index] = finalSpeed
  }
}

function outletCell(grid: SimulationGrid, analysis: DemAnalysis): number {
  // 取沟道网络中高程最低的有效格作为出口观测点。
  let best = -1
  let bestElevation = Infinity
  const threshold = analysis.channelThreshold
  for (let index = 0; index < grid.valid.length; index += 1) {
    if (!grid.valid[index]) continue
    if (analysis.flowAccumulation[index]! < threshold) continue
    const elevation = grid.z[index]!
    if (elevation < bestElevation) {
      bestElevation = elevation
      best = index
    }
  }
  return best
}

/** 二维浅水波推演（Voellmy / Bingham）。 */
export function simulateDebrisFlow(
  raster: CsLabGeoRaster,
  input: CsLabDebrisFlowSimulationInput,
): CsLabDebrisFlowSimulationResult {
  return simulateDebrisFlowDetailed(raster, input).result
}

/** 供工具层保存栅格输出的完整推演结果（含网格数组）。 */
export function simulateDebrisFlowDetailed(
  raster: CsLabGeoRaster,
  input: CsLabDebrisFlowSimulationInput,
): { result: CsLabDebrisFlowSimulationResult; grid: SimulationGrid; analysis: DemAnalysis } {
  const analysis = analyzeDem(raster)
  const grid = createSimulationGrid(raster)
  const source = input.source ?? {
    row: analysis.suggestedSource.row,
    col: analysis.suggestedSource.col,
  }
  const sourceRow = Math.max(0, Math.min(grid.height - 1, Math.round(source.row)))
  const sourceCol = Math.max(0, Math.min(grid.width - 1, Math.round(source.col)))
  const sourceIndex = sourceRow * grid.width + sourceCol
  if (!grid.valid[sourceIndex]) {
    return {
      result: {
        ok: false,
        demUri: input.demUri,
        model: input.rheology.model,
        engineUsed: 'typescript',
        source: { row: sourceRow, col: sourceCol, elevation: 0 },
        releasedVolumeM3: 0,
        peakDischargeM3s: 0,
        maxDepthM: 0,
        maxSpeedMs: 0,
        runoutDistanceM: 0,
        depositionVolumeM3: 0,
        hazardAreaM2: { high: 0, medium: 0, low: 0 },
        timeseries: [],
        outputs: {},
        warnings: [],
        message: '源区网格没有有效高程',
      },
      grid,
      analysis,
    }
  }

  const cellArea = grid.cellsize * grid.cellsize
  const warnings: string[] = []
  let volume = input.volumeM3 ?? 0
  if (!isFiniteNumber(volume) || volume <= 0) {
    if (!input.rainfall) {
      throw new Error('必须提供 volumeM3 或 rainfall')
    }
    const runoff = Math.max(0, Math.min(1, input.rainfall.runoffCoefficient ?? 0.7))
    const catchmentArea = input.rainfall.catchmentAreaM2
      ?? Math.max(1, analysis.flowAccumulation[sourceIndex]!) * cellArea
    volume = runoff * (input.rainfall.intensityMmPerHour / 1000) * (input.rainfall.durationMin / 60) * catchmentArea
    warnings.push(`按降雨体积法估算：径流系数 ${runoff.toFixed(2)}，汇水面积 ${Math.round(catchmentArea)} m²`)
  }
  if (volume <= 0) throw new Error('释放体积必须为正数')

  const durationS = Math.max(30, input.durationS ?? 600)
  const cfl = Math.max(0.1, Math.min(0.9, input.cfl ?? 0.4))
  const depositionVelocity = Math.max(0.05, input.depositionVelocity ?? 0.5)
  const releaseDuration = Math.min(durationS, Math.max(60, (input.rainfall?.durationMin ?? 60) * 60))
  const releaseRate = volume / releaseDuration
  const sourceCells: number[] = []
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const row = sourceRow + dr
      const col = sourceCol + dc
      if (row < 0 || row >= grid.height || col < 0 || col >= grid.width) continue
      const index = row * grid.width + col
      if (grid.valid[index]) sourceCells.push(index)
    }
  }
  const sourceShare = 1 / Math.max(1, sourceCells.length)

  const outlet = outletCell(grid, analysis)
  const timeseries: CsLabDebrisFlowTimePoint[] = []
  let released = 0
  let simulated = 0
  let stepCount = 0
  const maxSteps = 200_000
  let lastSample = -1

  while (simulated < durationS && stepCount < maxSteps) {
    let maxWave = 0
    for (let index = 0; index < grid.h.length; index += 1) {
      if (!grid.valid[index]) continue
      const depth = grid.h[index]!
      const speed = depth > MIN_DEPTH ? Math.hypot(grid.qx[index]!, grid.qy[index]!) / depth : 0
      maxWave = Math.max(maxWave, speed + Math.sqrt(GRAVITY * Math.max(depth, 0)))
    }
    const dt = Math.min(1, cfl * grid.cellsize / Math.max(0.5, maxWave))
    const effectiveDt = Math.min(dt, durationS - simulated)

    // 源区注入
    if (simulated < releaseDuration) {
      const injectVolume = Math.min(volume - released, releaseRate * effectiveDt)
      if (injectVolume > 0) {
        for (const index of sourceCells) {
          const areaDepth = injectVolume * sourceShare / cellArea
          grid.h[index] = grid.h[index]! + areaDepth
          const depth = grid.h[index]!
          if (depth > grid.maxH[index]!) grid.maxH[index] = depth
        }
        released += injectVolume
      }
    }

    stepGrid(grid, effectiveDt, input.rheology, depositionVelocity)
    simulated += effectiveDt
    stepCount += 1

    const outletDepth = outlet >= 0 ? grid.h[outlet]! : 0
    const outletSpeed = outlet >= 0 && outletDepth > MIN_DEPTH
      ? Math.hypot(grid.qx[outlet]!, grid.qy[outlet]!) / outletDepth
      : 0
    if (simulated - lastSample >= 2 || stepCount === 1) {
      lastSample = simulated
      timeseries.push({
        timeS: Math.round(simulated * 10) / 10,
        dischargeM3s: outletDepth * outletSpeed * grid.cellsize,
        depthM: outletDepth,
        velocityMs: outletSpeed,
      })
    }
  }

  if (stepCount >= maxSteps) warnings.push('达到最大步数，推演提前结束')

  let maxDepth = 0
  let maxSpeed = 0
  let depositionVolume = 0
  let runoutDistance = 0
  const hazardArea = { high: 0, medium: 0, low: 0 }
  let farthestIndex = sourceIndex
  for (let index = 0; index < grid.h.length; index += 1) {
    if (!grid.valid[index]) continue
    const depth = grid.maxH[index]!
    const speed = grid.maxSpeed[index]!
    if (depth > maxDepth) maxDepth = depth
    if (speed > maxSpeed) maxSpeed = speed
    depositionVolume += grid.deposit[index]!
    if (depth >= HAZARD_HIGH_DEPTH || depth * speed >= 1.5) {
      hazardArea.high += 1
      farthestIndex = index
    } else if (depth >= HAZARD_MEDIUM_DEPTH) {
      hazardArea.medium += 1
      farthestIndex = index
    } else if (depth >= HAZARD_LOW_DEPTH) {
      hazardArea.low += 1
      farthestIndex = index
    }
    if (depth >= HAZARD_LOW_DEPTH) {
      const row = Math.floor(index / grid.width)
      const col = index % grid.width
      const distance = Math.hypot(row - sourceRow, col - sourceCol) * grid.cellsize
      if (distance > runoutDistance) runoutDistance = distance
    }
  }
  void farthestIndex
  depositionVolume *= cellArea
  hazardArea.high *= cellArea
  hazardArea.medium *= cellArea
  hazardArea.low *= cellArea

  const peakDischarge = timeseries.reduce((peak, point) => Math.max(peak, point.dischargeM3s), 0)
  const arrival = timeseries.find((point) => point.depthM > 0.01 && point.timeS > 0)?.timeS

  return {
    result: {
      ok: true,
      demUri: input.demUri,
      model: input.rheology.model,
      engineUsed: 'typescript',
      source: { row: sourceRow, col: sourceCol, elevation: grid.z[sourceIndex]! },
      releasedVolumeM3: Math.round(released),
      peakDischargeM3s: Math.round(peakDischarge * 100) / 100,
      maxDepthM: Math.round(maxDepth * 1000) / 1000,
      maxSpeedMs: Math.round(maxSpeed * 100) / 100,
      runoutDistanceM: Math.round(runoutDistance * 10) / 10,
      depositionVolumeM3: Math.round(depositionVolume),
      arrivalTimeS: arrival,
      hazardAreaM2: {
        high: Math.round(hazardArea.high),
        medium: Math.round(hazardArea.medium),
        low: Math.round(hazardArea.low),
      },
      timeseries,
      outputs: {},
      warnings,
      message: `${input.rheology.model === 'voellmy' ? 'Voellmy' : 'Bingham'} 简化浅水波推演（${stepCount} 步）。工程使用前必须结合实测降雨、粒径级配与历史灾害校核。`,
    },
    grid,
    analysis,
  }
}

/** 将最大水深/流速/到达时间打包为后续图版所需栅格。 */
export function simulationRasters(
  raster: CsLabGeoRaster,
  result: CsLabDebrisFlowSimulationResult,
  gridData: { maxH: Float32Array; maxSpeed: Float32Array; arrival: Float32Array },
): { depth: CsLabGeoRaster; speed: CsLabGeoRaster; arrival: CsLabGeoRaster } {
  void result
  return {
    depth: { meta: { ...raster.meta }, values: gridData.maxH },
    speed: { meta: { ...raster.meta }, values: gridData.maxSpeed },
    arrival: { meta: { ...raster.meta }, values: gridData.arrival },
  }
}

export interface HazardMapOptions {
  highDepthM?: number
  mediumDepthM?: number
  lowDepthM?: number
}

/** 地形阴影 + 危险性分级 PNG。 */
export function renderHazardMapPng(
  raster: CsLabGeoRaster,
  maxDepth: CsLabGeoRaster,
  maxSpeed: CsLabGeoRaster,
  source: { row: number; col: number },
  options: HazardMapOptions = {},
): Buffer {
  const { width, height } = raster.meta
  const high = options.highDepthM ?? HAZARD_HIGH_DEPTH
  const medium = options.mediumDepthM ?? HAZARD_MEDIUM_DEPTH
  const low = options.lowDepthM ?? HAZARD_LOW_DEPTH
  const rgba = Buffer.alloc(width * height * 4)

  const at = (row: number, col: number): number => {
    if (row < 0 || row >= height || col < 0 || col >= width) return Number.NaN
    return raster.values[row * width + col]!
  }

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col
      const elevation = raster.values[index]!
      const valid = Number.isFinite(elevation)
      const zL = at(row, col - 1)
      const zR = at(row, col + 1)
      const zU = at(row - 1, col)
      const zD = at(row + 1, col)
      const dzdx = Number.isFinite(zL) && Number.isFinite(zR) ? (zR - zL) / (2 * raster.meta.cellsize) : 0
      const dzdy = Number.isFinite(zU) && Number.isFinite(zD) ? (zD - zU) / (2 * raster.meta.cellsize) : 0
      // 315° 光源的简单 hillshade。
      const shade = Math.max(0.35, Math.min(1, 0.6 + (-dzdx + dzdy) * 0.8))
      const normalized = valid ? (elevation - raster.meta.min) / Math.max(1e-6, raster.meta.max - raster.meta.min) : 0
      const base = valid
        ? [90 + normalized * 110, 100 + normalized * 95, 95 + normalized * 80]
        : [225, 225, 225]
      let red = base[0]! * shade
      let green = base[1]! * shade
      let blue = base[2]! * shade

      const depth = maxDepth.values[index]
      const speed = maxSpeed.values[index]
      if (Number.isFinite(depth) && depth! >= low) {
        const depthValue = depth!
        const speedValue = Number.isFinite(speed) ? speed! : 0
        const isHigh = depthValue >= high || depthValue * speedValue >= 1.5
        const isMedium = depthValue >= medium
        const color = isHigh ? [200, 36, 48] : isMedium ? [240, 140, 24] : [248, 214, 74]
        red = red * 0.25 + color[0]! * 0.75
        green = green * 0.25 + color[1]! * 0.75
        blue = blue * 0.25 + color[2]! * 0.75
      }

      if (row === source.row && col === source.col) {
        red = 20
        green = 90
        blue = 220
      }

      const offset = index * 4
      rgba[offset] = Math.max(0, Math.min(255, Math.round(red)))
      rgba[offset + 1] = Math.max(0, Math.min(255, Math.round(green)))
      rgba[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)))
      rgba[offset + 3] = 255
    }
  }

  const png = new PNG({ width, height })
  png.data = rgba
  return PNG.sync.write(png)
}

/** 供导出与 Python 桥接使用的 Massflow 兼容 ASCII 网格。 */
export function toMassflowGrid(meta: CsLabGeoRasterMeta, values: Float32Array): string {
  return writeEsriAsciiGrid(meta, values)
}

/** FLO-2D 兼容的 XYZ 三列文本。 */
export function toFlo2dXyz(meta: CsLabGeoRasterMeta, values: Float32Array): string {
  const lines: string[] = []
  for (let row = 0; row < meta.height; row += 1) {
    const y = meta.yllcorner + (meta.height - row - 0.5) * meta.cellsize
    for (let col = 0; col < meta.width; col += 1) {
      const value = values[row * meta.width + col]
      if (!Number.isFinite(value)) continue
      const x = meta.xllcorner + (col + 0.5) * meta.cellsize
      lines.push(`${x.toFixed(3)} ${y.toFixed(3)} ${value!.toFixed(3)}`)
    }
  }
  return `${lines.join('\n')}\n`
}
