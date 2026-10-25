import { describe, expect, test } from 'bun:test'
import {
  analyzeDem,
  buildRainfallThresholdResult,
  fitRainfallThreshold,
  parseEsriAsciiGrid,
  parseGeoTiffGrid,
  renderHazardMapPng,
  simulateDebrisFlowDetailed,
  writeEsriAsciiGrid,
} from './cslab-geohazard'

function syntheticSlope(width = 40, height = 30, cellsize = 20) {
  const rows = [
    `ncols ${width}`,
    `nrows ${height}`,
    'xllcorner 0',
    'yllcorner 0',
    `cellsize ${cellsize}`,
    'NODATA_value -9999',
  ]
  for (let row = 0; row < height; row += 1) {
    const values: string[] = []
    for (let col = 0; col < width; col += 1) {
      const valley = Math.abs(col - width / 2) < 2 ? -8 : 0
      values.push(String(1200 - row * 15 + valley))
    }
    rows.push(values.join(' '))
  }
  return rows.join('\n')
}

describe('DEM 栅格解析', () => {
  test('Given ESRI ASCII Grid When 写出再解析 Then 尺寸与高程一致', () => {
    const raster = parseEsriAsciiGrid(syntheticSlope())
    const text = writeEsriAsciiGrid(raster.meta, raster.values)
    const roundTrip = parseEsriAsciiGrid(text)
    expect(roundTrip.meta.width).toBe(raster.meta.width)
    expect(roundTrip.meta.height).toBe(raster.meta.height)
    expect(roundTrip.values[0]).toBe(raster.values[0])
    expect(roundTrip.values[roundTrip.values.length - 1]).toBe(raster.values[raster.values.length - 1])
  })

  test('Given NODATA 网格 When 解析 Then 转为 NaN 并从范围中排除', () => {
    const lines = syntheticSlope(10, 10).split('\n')
    lines[6] = `-9999 ${lines[6]!.split(' ').slice(1).join(' ')}`
    const raster = parseEsriAsciiGrid(lines.join('\n'))
    expect(raster.values.some((value) => Number.isNaN(value))).toBe(true)
    expect(Number.isFinite(raster.meta.min)).toBe(true)
  })

  test('Given 32-bit float GeoTIFF When 解析 Then 读取地理参考与高程', async () => {
    const buffer = buildFloatGeoTiff()
    const raster = await parseGeoTiffGrid(buffer)
    expect(raster.meta.width).toBe(2)
    expect(raster.meta.height).toBe(2)
    expect(raster.meta.cellsize).toBe(30)
    expect(raster.meta.xllcorner).toBe(100)
    expect(raster.meta.yllcorner).toBe(140)
    expect([...raster.values]).toEqual([10, 20, 30, 40])
  })
})

function buildFloatGeoTiff(): Buffer {
  const width = 2
  const height = 2
  const entries = 12
  const ifdOffset = 8
  const ifdSize = 2 + entries * 12 + 4
  const scaleOffset = ifdOffset + ifdSize
  const tiepointOffset = scaleOffset + 24
  const dataOffset = tiepointOffset + 48

  const buffer = Buffer.alloc(dataOffset + width * height * 4)
  buffer.write('II', 0, 'latin1')
  buffer.writeUInt16LE(42, 2)
  buffer.writeUInt32LE(ifdOffset, 4)
  buffer.writeUInt16LE(entries, ifdOffset)
  let cursor = ifdOffset + 2
  const entry = (tag: number, type: number, count: number, value: number): void => {
    buffer.writeUInt16LE(tag, cursor)
    buffer.writeUInt16LE(type, cursor + 2)
    buffer.writeUInt32LE(count, cursor + 4)
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, cursor + 8)
    else buffer.writeUInt32LE(value, cursor + 8)
    cursor += 12
  }
  entry(256, 4, 1, width)
  entry(257, 4, 1, height)
  entry(258, 3, 1, 32)
  entry(259, 3, 1, 1)
  entry(262, 3, 1, 1)
  entry(273, 4, 1, dataOffset)
  entry(277, 3, 1, 1)
  entry(278, 4, 1, height)
  entry(279, 4, 1, width * height * 4)
  entry(339, 3, 1, 3)
  entry(33550, 12, 3, scaleOffset)
  entry(33922, 12, 6, tiepointOffset)
  buffer.writeUInt32LE(0, cursor)

  buffer.writeDoubleLE(30, scaleOffset)
  buffer.writeDoubleLE(30, scaleOffset + 8)
  buffer.writeDoubleLE(0, scaleOffset + 16)
  ;[0, 0, 0, 100, 200, 0].forEach((value, index) => {
    buffer.writeDoubleLE(value, tiepointOffset + index * 8)
  })
  ;[10, 20, 30, 40].forEach((value, index) => {
    buffer.writeFloatLE(value, dataOffset + index * 4)
  })
  return buffer
}

describe('地形与降雨阈值', () => {
  test('Given 合成沟谷 When 分析 Then 坡度/汇流/源区可计算', () => {
    const raster = parseEsriAsciiGrid(syntheticSlope())
    const analysis = analyzeDem(raster)
    expect(analysis.meanSlopeDeg).toBeGreaterThan(0)
    expect(Number.isFinite(analysis.maxSlopeDeg)).toBe(true)
    expect(analysis.validCells).toBeGreaterThan(1000)
    expect(analysis.channelCount).toBeGreaterThan(0)
    expect(analysis.suggestedSource.elevation).toBeGreaterThan(0)
  })

  test('Given I-D 临界点 When 拟合 Then 还原 alpha/beta 且 R²>0.99', () => {
    const points = [
      { durationMin: 10, intensityMmPerHour: 30 * 10 ** -0.6 },
      { durationMin: 60, intensityMmPerHour: 30 * 60 ** -0.6 },
      { durationMin: 360, intensityMmPerHour: 30 * 360 ** -0.6 },
    ]
    const fitted = fitRainfallThreshold(points)
    expect(fitted.alpha).toBeCloseTo(30, 4)
    expect(fitted.beta).toBeCloseTo(0.6, 4)
    expect(fitted.rSquared).toBeGreaterThan(0.99)
  })

  test('Given 无临界点 When 构建结果 Then 使用默认参数并标注', () => {
    const result = buildRainfallThresholdResult({})
    expect(result.usedDefaultParameters).toBe(true)
    expect(result.curve.length).toBeGreaterThan(3)
    expect(result.message).toContain('示例参数')
  })
})

describe('泥石流浅水波推演', () => {
  test('Given 合成沟谷与释放体积 When 推演 Then 无 NaN 且产生流深/冲出', () => {
    const raster = parseEsriAsciiGrid(syntheticSlope())
    const { result, grid } = simulateDebrisFlowDetailed(raster, {
      demUri: 'test://dem',
      source: { row: 2, col: 20 },
      rheology: { model: 'voellmy', mu: 0.2, xi: 400 },
      volumeM3: 20_000,
      durationS: 90,
      engine: 'typescript',
    })
    expect(result.ok).toBe(true)
    expect(result.maxDepthM).toBeGreaterThan(0)
    expect(result.runoutDistanceM).toBeGreaterThan(0)
    expect(result.timeseries.length).toBeGreaterThan(0)
    for (const value of grid.maxH) expect(Number.isFinite(value)).toBe(true)
    for (const value of grid.maxSpeed) expect(Number.isFinite(value)).toBe(true)
    expect(result.message).toContain('工程使用前')
  })

  test('Given 危险性栅格 When 渲染 PNG Then 输出合法 PNG', () => {
    const raster = parseEsriAsciiGrid(syntheticSlope(20, 16))
    const { result, grid } = simulateDebrisFlowDetailed(raster, {
      demUri: 'test://dem',
      source: { row: 1, col: 10 },
      rheology: { model: 'bingham', yieldStressPa: 400, viscosityPaS: 50 },
      volumeM3: 8_000,
      durationS: 60,
    })
    const png = renderHazardMapPng(
      raster,
      { meta: raster.meta, values: grid.maxH },
      { meta: raster.meta, values: grid.maxSpeed },
      result.source,
    )
    expect(png.length).toBeGreaterThan(100)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })
})
