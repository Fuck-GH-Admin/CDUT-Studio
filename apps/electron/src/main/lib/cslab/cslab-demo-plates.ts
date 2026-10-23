/**
 * CSLab 演示实验室出版图版构建
 *
 * 职责：把已入笼的演示数据转换为 4 套 Nature 单栏出版图，并保存到 `vault/plots`。
 * 红线：
 * - 只使用真实数据与 @profer/shared 纯函数，任何前置数据缺失都明确报错；
 * - 绘图 ID 固定，重复调用由 savePlot 原子覆盖，不产生重复文件。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CsLabPlotAnnotation,
  CsLabPlotAxisConfig,
  CsLabPlotDocument,
  CsLabPlotSeries,
  CsLabPxrdPeak,
  CsLabTableSeries,
} from '@profer/shared'
import {
  buildStructureFromText,
  createPlotDocument,
  defaultAxisConfig,
  fitPeaks,
  integrateTrapezoid,
  pseudoVoigt,
  simulatePxrd,
} from '@profer/shared'
import { savePlot } from './cslab-science'

export interface DemoPlateInput {
  labId: string
  demoDir: string
  cuXrd?: CsLabTableSeries
  coXrd?: CsLabTableSeries
  raman?: CsLabTableSeries
}

export interface DemoPlateStats {
  nistMaxDeviationDeg: number
  ramanRSquared: number
  ramanAreaRelativeError: number
}

export interface DemoClusteredPeak {
  twoTheta: number
  intensity: number
  hkl: string
}

const PLATE_IDS = [
  'demo-rutile-xrd',
  'demo-silicon-srm640',
  'demo-rutile-raman-fit',
  'demo-nature-publication',
] as const

interface BenchmarkPeak {
  twoTheta: number
  intensity: number
}

/**
 * 同角峰簇合并：2θ 窗口内的反射归为一簇，强度累加后归一化到 100。
 *
 * POSCAR 无空间群声明时 simulatePxrd 按 P1 处理，等价晶面会分散成多条记录；
 * 合并累加可以近似恢复粉末多重度，同时保证 NIST 对标只比较真实峰位。
 */
export function clusterPeaks(
  peaks: readonly CsLabPxrdPeak[],
  toleranceDeg = 0.02,
): DemoClusteredPeak[] {
  const usable = peaks
    .filter((peak) => Number.isFinite(peak.twoTheta) && peak.intensity > 0)
    .sort((left, right) => left.twoTheta - right.twoTheta)
  if (usable.length === 0) return []

  const clusters: Array<{ weighted: number; intensity: number; hkl: string }> = []
  let current: { weighted: number; intensity: number; hkl: string; start: number } | null = null

  for (const peak of usable) {
    if (!current || peak.twoTheta - current.start > toleranceDeg) {
      if (current) {
        clusters.push({
          weighted: current.weighted,
          intensity: current.intensity,
          hkl: current.hkl,
        })
      }
      current = {
        weighted: peak.twoTheta * peak.intensity,
        intensity: peak.intensity,
        hkl: `${peak.h}${peak.k}${peak.l}`,
        start: peak.twoTheta,
      }
    } else {
      current.weighted += peak.twoTheta * peak.intensity
      current.intensity += peak.intensity
    }
  }
  if (current) {
    clusters.push({
      weighted: current.weighted,
      intensity: current.intensity,
      hkl: current.hkl,
    })
  }

  const maximum = clusters.reduce((max, cluster) => Math.max(max, cluster.intensity), 0)
  return clusters.map((cluster) => ({
    twoTheta: cluster.intensity > 0 ? cluster.weighted / cluster.intensity : 0,
    intensity: maximum > 0 ? (cluster.intensity / maximum) * 100 : 0,
    hkl: cluster.hkl,
  }))
}

function readTableY(series: CsLabTableSeries): number[] {
  const yKey = series.columns.find((column) => column.key !== 'x')?.key
  return yKey ? series.series[yKey] ?? [] : []
}

function requireTable(
  series: CsLabTableSeries | undefined,
  label: string,
): { x: number[]; y: number[] } {
  if (!series) throw new Error(`演示图版缺少必要数据：${label}`)
  const y = readTableY(series)
  if (series.x.length < 2 || y.length !== series.x.length) {
    throw new Error(`演示图版数据不完整：${label}`)
  }
  return { x: series.x, y }
}

function normalize100(values: readonly number[]): number[] {
  let maximum = 0
  for (const value of values) {
    if (Number.isFinite(value) && value > maximum) maximum = value
  }
  if (!(maximum > 0)) return values.map(() => 0)
  return values.map((value) => (Number.isFinite(value) ? (value / maximum) * 100 : 0))
}

function axis(
  title: string,
  unit = '',
  overrides: Partial<CsLabPlotAxisConfig> = {},
): CsLabPlotAxisConfig {
  return { ...defaultAxisConfig(title, unit), ...overrides }
}

function makeSeries(
  input: Partial<CsLabPlotSeries> & Pick<CsLabPlotSeries, 'id' | 'name' | 'x' | 'y' | 'color'>,
): CsLabPlotSeries {
  return {
    lineWidth: 0.6,
    lineStyle: 'solid',
    marker: 'none',
    yAxis: 0,
    visible: true,
    alpha: 1,
    ...input,
  }
}

function basePlot(labId: string, id: string, title: string): CsLabPlotDocument {
  return createPlotDocument({ id, labId, title, presetId: 'nature' })
}

function withLayer(
  document: CsLabPlotDocument,
  patch: {
    series: CsLabPlotSeries[]
    xAxis: CsLabPlotAxisConfig
    yAxes: [CsLabPlotAxisConfig, CsLabPlotAxisConfig]
    annotations?: CsLabPlotAnnotation[]
    legendPosition?: CsLabPlotDocument['legend']['position']
  },
): CsLabPlotDocument {
  const layer = document.layers[0]!
  return {
    ...document,
    layers: [
      {
        ...layer,
        series: patch.series,
        xAxis: patch.xAxis,
        yAxes: patch.yAxes,
        annotations: patch.annotations ?? [],
      },
    ],
    legend: {
      ...document.legend,
      position: patch.legendPosition ?? document.legend.position,
    },
    updatedAt: Date.now(),
  }
}

function parseBenchmark(text: string): BenchmarkPeak[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(1)
    .map((line) => {
      const [twoTheta, intensity] = line.split(',').map((token) => Number(token))
      return { twoTheta: twoTheta ?? Number.NaN, intensity: intensity ?? Number.NaN }
    })
    .filter((peak) => Number.isFinite(peak.twoTheta) && Number.isFinite(peak.intensity))
}

/** 图版 1：金红石 Cu / Co Kα 双靶衍射对比。 */
function buildRutileXrdPlate(input: DemoPlateInput): CsLabPlotDocument {
  const cu = requireTable(input.cuXrd, '金红石 Cu Kα XRD')
  const co = requireTable(input.coXrd, '金红石 Co Kα XRD')
  const document = basePlot(input.labId, PLATE_IDS[0], '金红石 TiO_2 · Cu / Co Kα 衍射')
  return withLayer(document, {
    series: [
      makeSeries({
        id: 'series-cu-ka',
        name: 'Cu Kα',
        x: cu.x,
        y: normalize100(cu.y),
        color: '#1f6f8b',
        lineWidth: 0.6,
      }),
      makeSeries({
        id: 'series-co-ka',
        name: 'Co Kα',
        x: co.x,
        y: normalize100(co.y),
        color: '#c0603a',
        lineWidth: 0.6,
        lineStyle: 'dash',
      }),
    ],
    xAxis: axis('2θ', 'deg'),
    yAxes: [axis('归一化强度', 'a.u.'), axis('')],
    legendPosition: 'top-right',
  })
}

/** 图版 2：硅 NIST SRM 640 理论 PXRD 对标。 */
async function buildSiliconNistPlate(
  input: DemoPlateInput,
): Promise<{ plot: CsLabPlotDocument; maxDeviationDeg: number }> {
  const [poscarText, benchmarkText] = await Promise.all([
    fs.readFile(join(input.demoDir, 'silicon-diamond.poscar'), 'utf8'),
    fs.readFile(join(input.demoDir, 'silicon-srm640-benchmark.csv'), 'utf8'),
  ])
  const pattern = simulatePxrd(buildStructureFromText(poscarText, 'poscar'), {
    minTwoTheta: 20,
    maxTwoTheta: 92,
    stepDeg: 0.02,
    fwhmDeg: 0.12,
    eta: 0.5,
    maxIndex: 6,
  })
  const peaks = clusterPeaks(pattern.peaks).slice(0, 6)
  const benchmark = parseBenchmark(benchmarkText)
  if (peaks.length === 0 || benchmark.length === 0) {
    throw new Error('演示图版缺少必要数据：NIST SRM 640 对标峰')
  }

  let maxDeviationDeg = 0
  for (const [index, peak] of peaks.entries()) {
    const reference = benchmark[index]
    if (!reference) break
    maxDeviationDeg = Math.max(maxDeviationDeg, Math.abs(peak.twoTheta - reference.twoTheta))
  }

  const stickX: number[] = []
  const stickY: number[] = []
  const annotations: CsLabPlotAnnotation[] = []
  for (const peak of peaks) {
    stickX.push(peak.twoTheta, peak.twoTheta, peak.twoTheta)
    stickY.push(0, peak.intensity, 0)
    annotations.push({
      id: `stick-label-${peak.hkl}`,
      kind: 'text',
      x: peak.twoTheta,
      y: peak.intensity + 4,
      text: peak.hkl,
      color: '#555555',
      fontSize: 5,
    })
  }

  const document = basePlot(input.labId, PLATE_IDS[1], '硅 NIST SRM 640 · 理论 PXRD 对标')
  const plot = withLayer(document, {
    series: [
      makeSeries({
        id: 'series-silicon-theory',
        name: '理论 PXRD（Si 金刚石）',
        x: pattern.curve.x,
        y: normalize100(pattern.curve.y),
        color: '#1f6f8b',
        lineWidth: 0.6,
      }),
      makeSeries({
        id: 'series-nist-sticks',
        name: 'NIST SRM 640 标样',
        x: stickX,
        y: stickY,
        color: '#c0603a',
        lineWidth: 0.5,
      }),
    ],
    xAxis: axis('2θ', 'deg', { min: 20, max: 92 }),
    yAxes: [axis('归一化强度', 'a.u.', { min: 0, max: 110 }), axis('')],
    annotations,
    legendPosition: 'top-right',
  })
  return { plot, maxDeviationDeg }
}

/** 图版 3：拉曼 AsLS 基线扣除与 Pseudo-Voigt 分峰。 */
function buildRamanPlate(input: DemoPlateInput): {
  plot: CsLabPlotDocument
  rSquared: number
  areaRelativeError: number
} {
  const raman = requireTable(input.raman, '金红石拉曼光谱')
  const fit = fitPeaks({
    x: raman.x,
    y: raman.y,
    model: 'pseudo_voigt',
    baseline: 'asls',
    asls: { lambda: 1e5, p: 0.01 },
    // 金红石三条拉曼活性模：B1g(143)、Eg(447)、A1g(612)；数据中 143 cm^-1 的弱峰不可忽略。
    peaks: [
      { center: 143, fwhm: 8 },
      { center: 447, fwhm: 10 },
      { center: 612, fwhm: 12 },
    ],
    maxIterations: 200,
  })
  const baseline = fit.baseline
  const fitted = fit.fitted
  const componentLabels = ['B1g (143 cm^{-1})', 'Eg (447 cm^{-1})', 'A1g (612 cm^{-1})']
  const componentColors = ['#7c3aed', '#1f6f8b', '#047857']
  const components = fit.peaks.map((peak, index) =>
    makeSeries({
      id: `series-component-${index + 1}`,
      name: componentLabels[index] ?? `分峰 ${index + 1}`,
      x: raman.x,
      y: raman.x.map((value, pointIndex) =>
        (baseline[pointIndex] ?? 0) +
        pseudoVoigt(value, peak.center, peak.height, peak.fwhm, peak.eta),
      ),
      color: componentColors[index] ?? '#6b7280',
      lineWidth: 0.5,
      lineStyle: 'dashdot',
    }),
  )

  const corrected = fitted.map((value, index) => value - (baseline[index] ?? 0))
  const integratedArea = integrateTrapezoid(raman.x, corrected)
  const analyticArea = fit.peaks.reduce((sum, peak) => sum + peak.area, 0)
  const areaRelativeError =
    analyticArea > 0 ? Math.abs(analyticArea - integratedArea) / analyticArea : 0

  const document = basePlot(
    input.labId,
    PLATE_IDS[2],
    '金红石 TiO_2 · 拉曼 AsLS 基线扣除与 Pseudo-Voigt 分峰',
  )
  const plot = withLayer(document, {
    series: [
      makeSeries({
        id: 'series-raman-raw',
        name: '原始实测数据',
        x: raman.x,
        y: raman.y,
        color: '#4b5563',
        lineWidth: 0.5,
      }),
      makeSeries({
        id: 'series-raman-baseline',
        name: 'AsLS 基线',
        x: raman.x,
        y: baseline,
        color: '#d97706',
        lineWidth: 0.5,
        lineStyle: 'dash',
      }),
      makeSeries({
        id: 'series-raman-fitted',
        name: '累加拟合',
        x: raman.x,
        y: fitted,
        color: '#b91c1c',
        lineWidth: 0.7,
      }),
      ...components,
    ],
    xAxis: axis('拉曼位移', 'cm^{-1}'),
    yAxes: [axis('强度', 'a.u.'), axis('')],
    legendPosition: 'top-left',
  })
  return { plot, rSquared: fit.rSquared, areaRelativeError }
}

/** 图版 4：Nature 89 mm 双 Y 轴出版图版。 */
async function buildNaturePlate(input: DemoPlateInput): Promise<CsLabPlotDocument> {
  const cu = requireTable(input.cuXrd, '金红石 Cu Kα XRD')
  const cifText = await fs.readFile(join(input.demoDir, 'rutile-tio2.cif'), 'utf8')
  const theory = simulatePxrd(buildStructureFromText(cifText, 'cif'), {
    minTwoTheta: 20,
    maxTwoTheta: 90,
    stepDeg: 0.02,
    fwhmDeg: 0.12,
    eta: 0.5,
    maxIndex: 6,
  })

  const document = basePlot(
    input.labId,
    PLATE_IDS[3],
    '金红石 TiO_2 · \\alpha 相 \\theta–2\\theta 衍射与理论 PXRD 对照',
  )
  return withLayer(document, {
    series: [
      makeSeries({
        id: 'series-experiment-cu',
        name: '实验 Cu Kα',
        x: cu.x,
        y: cu.y,
        color: '#1f6f8b',
        lineWidth: 0.6,
      }),
      makeSeries({
        id: 'series-theory-pxrd',
        name: '理论 PXRD',
        x: theory.curve.x,
        y: normalize100(theory.curve.y),
        color: '#c0603a',
        lineWidth: 0.6,
        lineStyle: 'dash',
        yAxis: 1,
      }),
    ],
    xAxis: axis('2\\theta', 'deg'),
    yAxes: [axis('实验强度', 'a.u.'), axis('理论强度', 'a.u.')],
    legendPosition: 'top-right',
  })
}

/** 生成并保存 4 套演示图版。 */
export async function buildDemoPlates(
  input: DemoPlateInput,
): Promise<{ plotIds: string[]; stats: DemoPlateStats }> {
  const nist = await buildSiliconNistPlate(input)
  const raman = buildRamanPlate(input)
  const plots: CsLabPlotDocument[] = [
    buildRutileXrdPlate(input),
    nist.plot,
    raman.plot,
    await buildNaturePlate(input),
  ]

  const plotIds: string[] = []
  for (const plot of plots) {
    const summary = await savePlot({ labId: input.labId, plot })
    plotIds.push(summary.id)
  }

  return {
    plotIds,
    stats: {
      nistMaxDeviationDeg: nist.maxDeviationDeg,
      ramanRSquared: raman.rSquared,
      ramanAreaRelativeError: raman.areaRelativeError,
    },
  }
}
