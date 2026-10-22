/**
 * CSLab 演示实验室生成测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CsLabDemoLabResult } from '@profer/shared'
import {
  JOURNAL_PRESETS,
  buildStructureFromText,
  hasEditableText,
  hasEmbeddedImage,
  renderPlotSvg,
  simulatePxrd,
} from '@profer/shared'

let rootDir = ''
let labId = ''
let demo: CsLabDemoLabResult

const DEMO_DIR = fileURLToPath(new URL('../../../../resources/cslab/demo', import.meta.url))
const PLOT_IDS = [
  'demo-rutile-xrd',
  'demo-silicon-srm640',
  'demo-rutile-raman-fit',
  'demo-nature-publication',
]

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-demo-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createDemoLab } = await import('./cslab-demo')
  demo = await createDemoLab({ demoDir: DEMO_DIR })
  labId = demo.lab.id
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  if (labId) {
    const base = join(resolveLabDir(labId), 'vault')
    for (const directory of ['raw', 'figures', 'tables', 'lit']) {
      try {
        for (const entry of readdirSync(join(base, directory))) {
          await unlockFile(join(base, directory, entry)).catch(() => undefined)
        }
      } catch {
        // 目录可能不存在
      }
    }
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 下 SQLite 句柄可能延迟释放
  }
})

describe('演示实验室', () => {
  test('Given 内置演示数据 When 一键创建 Then 资产与四套图版齐备', async () => {
    expect(demo.lab.name).toContain('演示实验室')
    expect(demo.lab.tags).toContain('VESTA 晶体学')
    expect(demo.assets.length).toBeGreaterThanOrEqual(16)

    const formats = new Set(demo.assets.map((asset) => asset.format))
    for (const format of [
      'cif',
      'poscar',
      'pdb',
      'cube',
      'chgcar',
      'locpot',
      'text-table',
      'csv',
      'png',
    ]) {
      expect(formats.has(format)).toBe(true)
    }

    expect(demo.plotIds).toEqual(PLOT_IDS)
    expect(demo.plotId).toBe('demo-rutile-xrd')
    expect(demo.stats?.nistMaxDeviationDeg).toBeLessThan(0.05)
  })

  test('Given 已存在演示实验室 When 再次创建 Then 幂等且绘图覆盖不累积', async () => {
    const { createDemoLab } = await import('./cslab-demo')
    const { listPlots } = await import('./cslab-science')
    const second = await createDemoLab({ demoDir: DEMO_DIR })

    expect(second.lab.id).toBe(demo.lab.id)
    expect(second.assets.length).toBe(demo.assets.length)
    expect(second.plotIds).toEqual(demo.plotIds)
    expect((await listPlots(second.lab.id)).length).toBe(4)
  })

  test('Given 四套图版 When 读取 Then 曲线数据完整', async () => {
    const { loadPlot } = await import('./cslab-science')
    for (const plotId of PLOT_IDS) {
      const plot = await loadPlot({ labId, plotId })
      expect(plot).not.toBeNull()
      expect(plot!.layers.length).toBeGreaterThanOrEqual(1)
      const series = plot!.layers[0]!.series
      expect(series.length).toBeGreaterThanOrEqual(1)
      for (const item of series) {
        expect(item.x.length).toBeGreaterThan(1)
        expect(item.y.length).toBe(item.x.length)
      }
    }
  })

  test('Given 硅 NIST SRM 640 标样 When 理论 PXRD 对标 Then 前 6 峰偏差小于 0.05°', async () => {
    const { clusterPeaks } = await import('./cslab-demo-plates')
    const poscar = readFileSync(join(DEMO_DIR, 'silicon-diamond.poscar'), 'utf8')
    const pattern = simulatePxrd(buildStructureFromText(poscar, 'poscar'), {
      minTwoTheta: 20,
      maxTwoTheta: 92,
      stepDeg: 0.02,
      fwhmDeg: 0.12,
      eta: 0.5,
      maxIndex: 6,
    })
    const peaks = clusterPeaks(pattern.peaks).slice(0, 6)
    const benchmark = readFileSync(join(DEMO_DIR, 'silicon-srm640-benchmark.csv'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => Number(line.split(',')[0]))

    expect(peaks).toHaveLength(6)
    expect(benchmark).toHaveLength(6)
    peaks.forEach((peak, index) => {
      expect(Math.abs(peak.twoTheta - benchmark[index]!)).toBeLessThan(0.05)
    })
    expect(demo.stats!.nistMaxDeviationDeg).toBeLessThan(0.05)
  })

  test('Given 拉曼光谱 When AsLS 基线扣除与分峰 Then R² 与面积守恒达标', async () => {
    const { loadPlot } = await import('./cslab-science')
    expect(demo.stats!.ramanRSquared).toBeGreaterThan(0.95)
    expect(demo.stats!.ramanAreaRelativeError).toBeLessThan(0.015)

    const plot = await loadPlot({ labId, plotId: 'demo-rutile-raman-fit' })
    const names = plot!.layers[0]!.series.map((series) => series.name)
    expect(names).toContain('原始实测数据')
    expect(names).toContain('AsLS 基线')
    expect(names).toContain('累加拟合')
    expect(names.some((name) => name.startsWith('Eg'))).toBe(true)
    expect(names.some((name) => name.startsWith('A1g'))).toBe(true)
  })

  test('Given 出版图版 When 导出 SVG Then 纯矢量且文字可编辑', async () => {
    const { loadPlot } = await import('./cslab-science')
    for (const plotId of PLOT_IDS) {
      const plot = await loadPlot({ labId, plotId })
      const svg = renderPlotSvg(plot!, JOURNAL_PRESETS[plot!.presetId])
      expect(svg.startsWith('<svg')).toBe(true)
      expect(hasEditableText(svg)).toBe(true)
      expect(hasEmbeddedImage(svg)).toBe(false)
    }
  })

  test('Given Nature 图版 When 检查图层 Then 双 Y 轴与 89 mm 单栏成立', async () => {
    const { loadPlot } = await import('./cslab-science')
    const plot = await loadPlot({ labId, plotId: 'demo-nature-publication' })
    expect(plot!.sizeMm.width).toBe(89)
    expect(plot!.layers[0]!.yAxes[1]!.title.length).toBeGreaterThan(0)
    expect(plot!.layers[0]!.series.some((series) => series.yAxis === 1)).toBe(true)
  })
})
