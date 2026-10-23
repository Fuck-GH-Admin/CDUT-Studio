import { describe, expect, test } from 'bun:test'
import type { CsLabVolumeGrid } from '../types/cslab-vesta-types'
import { extractIsosurfaceCpu } from './cslab-isosurface'
import {
  CsLabVolumeParseError,
  computeDifferentialGrid,
  parseChgcar,
  parseCube,
  parseLocpot,
  sampleGrid,
} from './cslab-volume'

function sphereGrid(size = 24): CsLabVolumeGrid {
  const step = 1 / size
  const values = new Float32Array(size * size * size)
  let offset = 0
  for (let k = 0; k < size; k += 1) {
    for (let j = 0; j < size; j += 1) {
      for (let i = 0; i < size; i += 1) {
        const x = i * step
        const y = j * step
        const z = k * step
        const distance = Math.hypot(x - 0.5, y - 0.5, z - 0.5)
        values[offset] = 0.35 - distance
        offset += 1
      }
    }
  }
  return {
    format: 'cube',
    dimensions: [size, size, size],
    origin: [0, 0, 0],
    voxelVectors: [
      [step, 0, 0],
      [0, step, 0],
      [0, 0, step],
    ],
    values,
    min: -0.5,
    max: 0.35,
    atomCount: 0,
    warnings: [],
  }
}

describe('体数据与等值面', () => {
  test('Given 小型 Cube 文件 When 解析 Then 网格尺寸与数值正确', () => {
    const text = [
      'cube comment 1',
      'cube comment 2',
      '1 0 0 0',
      '2 1 0 0',
      '2 0 1 0',
      '2 0 0 1',
      '6 0 0 0 0',
      '1 2 3 4 5 6 7 8',
    ].join('\n')
    const grid = parseCube(text)
    expect(grid.dimensions).toEqual([2, 2, 2])
    expect(grid.atomCount).toBe(1)
    expect(Array.from(grid.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(grid.min).toBe(1)
    expect(grid.max).toBe(8)
  })

  test('Given 球体标量场 When 提取零等值面 Then 顶点位于球面附近', () => {
    const grid = sphereGrid()
    const mesh = extractIsosurfaceCpu(grid, 0)
    expect(mesh.triangleCount).toBeGreaterThan(100)
    expect(mesh.positions.length).toBe(mesh.normals.length)
    let checked = 0
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index]!
      const y = mesh.positions[index + 1]!
      const z = mesh.positions[index + 2]!
      const distance = Math.hypot(x - 0.5, y - 0.5, z - 0.5)
      expect(Math.abs(distance - 0.35)).toBeLessThan(1 / 24 + 1e-6)
      const nx = mesh.normals[index]!
      const ny = mesh.normals[index + 1]!
      const nz = mesh.normals[index + 2]!
      expect(Math.hypot(nx, ny, nz)).toBeGreaterThan(0.9)
      checked += 1
      if (checked >= 40) break
    }
  })

  test('Given 网格 When 三线性采样 Then 端点返回原始体素值', () => {
    const grid = sphereGrid(8)
    const value = sampleGrid(grid, 0, 0, 0)
    expect(value).toBeCloseTo(grid.values[0]!, 6)
  })
})

const MINIMAL_VASP_HEADER = [
  'CDUT Science demo: minimal VASP volume',
  '1.0',
  '1.0 0.0 0.0',
  '0.0 1.0 0.0',
  '0.0 0.0 1.0',
  'Si',
  '1',
  'Direct',
  '0.0 0.0 0.0',
  '2 2 2',
]

function constantGrid(value: number, options: Partial<CsLabVolumeGrid> = {}): CsLabVolumeGrid {
  const values = new Float32Array(8)
  values.fill(value)
  return {
    format: 'cube',
    dimensions: [2, 2, 2],
    origin: [0, 0, 0],
    voxelVectors: [
      [0.5, 0, 0],
      [0, 0.5, 0],
      [0, 0, 0.5],
    ],
    values,
    min: value,
    max: value,
    atomCount: 1,
    warnings: [],
    ...options,
  }
}

describe('VASP 体数据与差分网格', () => {
  test('Given 最小 CHGCAR When 解析 Then 网格维度与极值正确', () => {
    const grid = parseChgcar([...MINIMAL_VASP_HEADER, '1 2 3 4 5 6 7 8'].join('\n'))
    expect(grid.format).toBe('chgcar')
    expect(grid.dimensions).toEqual([2, 2, 2])
    expect(Array.from(grid.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(grid.min).toBe(1)
    expect(grid.max).toBe(8)
    expect(grid.warnings.some((warning) => warning.includes('PAW'))).toBe(true)
  })

  test('Given 最小 LOCPOT When 解析 Then 支持负值静电势', () => {
    const grid = parseLocpot([...MINIMAL_VASP_HEADER, '-1.5 -1 0 0.5 1 1.5 2 2.5'].join('\n'))
    expect(grid.format).toBe('locpot')
    expect(grid.dimensions).toEqual([2, 2, 2])
    expect(grid.min).toBe(-1.5)
    expect(grid.max).toBe(2.5)
  })

  test('Given 总量与两个减数网格 When 差分 Then 逐格点等于 total−A−B', () => {
    const result = computeDifferentialGrid(
      constantGrid(2),
      constantGrid(0.5),
      constantGrid(0.25),
    )
    expect(result.dimensions).toEqual([2, 2, 2])
    expect(Array.from(result.values)).toEqual(new Array(8).fill(1.25))
    expect(result.min).toBeCloseTo(1.25, 6)
    expect(result.max).toBeCloseTo(1.25, 6)
    expect(result.warnings.some((warning) => warning.includes('Δρ'))).toBe(true)
  })

  test('Given 单个减数 When 差分 Then 得到两体体系差值', () => {
    const result = computeDifferentialGrid(constantGrid(2), constantGrid(0.25))
    expect(Array.from(result.values)).toEqual(new Array(8).fill(1.75))
    expect(result.min).toBeCloseTo(1.75, 6)
    expect(result.max).toBeCloseTo(1.75, 6)
  })

  test('Given 非法输入 When 差分 Then 明确报错', () => {
    expect(() => computeDifferentialGrid(constantGrid(2))).toThrow(CsLabVolumeParseError)
    expect(() =>
      computeDifferentialGrid(
        constantGrid(2),
        constantGrid(1, { dimensions: [2, 2, 3], values: new Float32Array(12) }),
      ),
    ).toThrow('维度')
    expect(() =>
      computeDifferentialGrid(
        constantGrid(2),
        constantGrid(1, { values: new Float32Array(7) }),
      ),
    ).toThrow('数值数')
    const withNaN = new Float32Array(8)
    withNaN[0] = Number.NaN
    expect(() =>
      computeDifferentialGrid(constantGrid(2), constantGrid(1, { values: withNaN })),
    ).toThrow('非有限数值')
  })
})
