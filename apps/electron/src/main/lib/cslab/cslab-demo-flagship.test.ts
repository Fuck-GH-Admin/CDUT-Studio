/**
 * 旗舰演示内容构建器单元测试（不依赖 Electron / SQLite）
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildFlagshipCanvasDocument,
  buildFlagshipCdData,
  buildFlagshipPlots,
  buildFlagshipXrdData,
  buildStandardCalibrationCurvePng,
} from './cslab-demo-flagship-content'

const FLAGSHIP_DIR = fileURLToPath(
  new URL('../../../../resources/cslab/demo-flagship', import.meta.url),
)

describe('旗舰演示内容', () => {
  test('Given CD 合成谱 When 构建 Then 190–260 nm 双负带数据完整', () => {
    const data = buildFlagshipCdData()
    expect(data.wavelength[0]).toBe(190)
    expect(data.wavelength[data.wavelength.length - 1]).toBe(260)
    expect(data.cd.some((value) => value < -20)).toBe(true)
    expect(data.absorbance.some((value) => value > 1)).toBe(true)
  })

  test('Given 标准曲线 When 生成 Then PNG 与像素刻度齐备', () => {
    const figure = buildStandardCalibrationCurvePng()
    expect(figure.buffer.length).toBeGreaterThan(1000)
    expect(figure.calibration.x.ticks).toHaveLength(2)
    expect(figure.calibration.y.ticks).toHaveLength(2)
  })

  test('Given 推演网络 When 构建 Then 含假设/验证/死路与 AND/OR 边', () => {
    const document = buildFlagshipCanvasDocument({ plotIds: ['a', 'b'] })
    expect(document.nodes.length).toBeGreaterThanOrEqual(8)
    expect(document.edges.length).toBeGreaterThanOrEqual(6)
    expect(document.nodes.some((node) => node.cdut_science?.manual_status === 'dead_end')).toBe(true)
    expect(document.edges.some((edge) => edge.cdut_science?.dependency_type === 'strict_conjunctive')).toBe(true)
    expect(document.edges.some((edge) => edge.cdut_science?.dependency_type === 'disjunctive')).toBe(true)
  })

  test('Given 金红石 CIF When 构建出版图版 Then CD 残差层与 XRD 双 Y 轴成立', async () => {
    const rutile = readFileSync(`${FLAGSHIP_DIR}/rutile_tio2.cif`, 'utf-8')
    const { plots } = await buildFlagshipPlots({
      labId: 'demo-lab',
      cd: buildFlagshipCdData(),
      xrd: buildFlagshipXrdData(),
      rutileCifText: rutile,
    })
    expect(plots).toHaveLength(2)
    expect(plots[0]!.id).toBe('flagship-cd-spectra')
    expect(plots[0]!.layers.length).toBe(2)
    expect(plots[0]!.layers[1]!.name).toContain('残差')
    expect(plots[1]!.layers[0]!.series.some((series) => series.yAxis === 1)).toBe(true)
  })
})
