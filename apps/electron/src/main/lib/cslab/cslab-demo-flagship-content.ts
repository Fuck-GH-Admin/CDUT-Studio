/**
 * 旗舰演示实验室内容构建器（纯函数）
 *
 * 职责：确定性生成 CD/吸收谱、XRD 实验谱、标准曲线图版、地貌晕渲、
 * SEM 伪彩图、演示论文、双链笔记与 JSON Canvas。
 *
 * 红线：所有合成数据标题/描述必须明确标注 DEMO；不触碰 Electron / SQLite。
 */

import { PNG } from 'pngjs'
import {
  buildStructureFromText,
  createPlotDocument,
  fitPeaks,
  simulatePxrd,
  type CsLabAxisTick,
  type CsLabCanvasDocument,
  type CsLabCanvasEdge,
  type CsLabCanvasNode,
  type CsLabGeoRaster,
  type CsLabPlotCalibration,
  type CsLabPlotDocument,
  type CsLabPlotSeries,
} from '@profer/shared'
import { buildTwoColumnTextPdf } from './cslab-demo-pdf'

export const FLAGSHIP_CD_FILE = 'flagship_cd_spectra.csv'
export const FLAGSHIP_XRD_FILE = 'flagship_xrd_experiment.csv'
export const STANDARD_CALIBRATION_FILE = 'standard_calibration_curve.png'
export const HILLSHADE_FILE = 'wenjia_gully_hillshade_zones.svg'
export const SEM_FILE = 'biomineral_sem_pseudocolor.png'
export const FLAGSHIP_PAPER_TITLE =
  'Biogeochemical Evolution of Deep-Subsurface Microorganisms and Sediment Dynamics'
export const FLAGSHIP_CANVAS_TITLE = '深地生物圈推演'
export const FLAGSHIP_PLOT_IDS = ['flagship-cd-spectra', 'flagship-xrd-dual'] as const

export interface FlagshipSpectrumData {
  wavelength: number[]
  absorbance: number[]
  cd: number[]
}

export interface FlagshipXrdData {
  twoTheta: number[]
  intensity: number[]
}

function gaussian(x: number, center: number, width: number, amplitude: number): number {
  return amplitude * Math.exp(-Math.pow((x - center) / width, 2))
}

export function buildFlagshipCdData(): FlagshipSpectrumData {
  const wavelength: number[] = []
  const absorbance: number[] = []
  const cd: number[] = []
  for (let value = 190; value <= 260.0001; value += 0.5) {
    const wl = Math.round(value * 10) / 10
    wavelength.push(wl)
    absorbance.push(
      0.18
      + gaussian(wl, 196, 7, 1.25)
      + gaussian(wl, 225, 13, 0.4)
      + 0.0009 * (wl - 190),
    )
    cd.push(
      gaussian(wl, 195, 4, 8)
      + gaussian(wl, 208, 4.5, -18)
      + gaussian(wl, 222, 5, -26)
      + gaussian(wl, 240, 10, -3),
    )
  }
  return { wavelength, absorbance, cd }
}

export function buildFlagshipXrdData(): FlagshipXrdData {
  const peaks: Array<[number, number, number]> = [
    [27.45, 100, 0.28],
    [36.09, 42, 0.30],
    [39.19, 18, 0.32],
    [41.24, 22, 0.33],
    [44.05, 14, 0.34],
    [54.32, 26, 0.38],
    [56.64, 18, 0.4],
    [62.75, 10, 0.42],
  ]
  const twoTheta: number[] = []
  const intensity: number[] = []
  for (let value = 10; value <= 70.0001; value += 0.02) {
    const angle = Math.round(value * 100) / 100
    twoTheta.push(angle)
    let y = 8
    for (const [center, amplitude, width] of peaks) {
      const distance = Math.pow((angle - center) / width, 2)
      y += (amplitude / (1 + distance)) * 0.75 + amplitude * Math.exp(-distance) * 0.35
    }
    intensity.push(y)
  }
  return { twoTheta, intensity }
}

export function buildFlagshipCsv(data?: {
  cd?: FlagshipSpectrumData
  xrd?: FlagshipXrdData
}): { cdCsv: string; xrdCsv: string } {
  const cd = data?.cd ?? buildFlagshipCdData()
  const xrd = data?.xrd ?? buildFlagshipXrdData()
  const cdLines = ['wavelength_nm,absorbance,cd_mdeg']
  for (let index = 0; index < cd.wavelength.length; index += 1) {
    cdLines.push(
      `${cd.wavelength[index]!.toFixed(1)},${cd.absorbance[index]!.toFixed(6)},${cd.cd[index]!.toFixed(4)}`,
    )
  }
  const xrdLines = ['two_theta_deg,intensity']
  for (let index = 0; index < xrd.twoTheta.length; index += 1) {
    xrdLines.push(`${xrd.twoTheta[index]!.toFixed(2)},${xrd.intensity[index]!.toFixed(4)}`)
  }
  return { cdCsv: `${cdLines.join('\n')}\n`, xrdCsv: `${xrdLines.join('\n')}\n` }
}

// ===== PNG 基础绘制 =====

type Rgb = [number, number, number]

function createPng(width: number, height: number, background: Rgb): PNG {
  const png = new PNG({ width, height })
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = background[0]
    png.data[index + 1] = background[1]
    png.data[index + 2] = background[2]
    png.data[index + 3] = 255
  }
  return png
}

function setPixel(png: PNG, x: number, y: number, color: Rgb, alpha = 1): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return
  const index = (png.width * y + x) << 2
  png.data[index] = Math.round(png.data[index]! * (1 - alpha) + color[0] * alpha)
  png.data[index + 1] = Math.round(png.data[index + 1]! * (1 - alpha) + color[1] * alpha)
  png.data[index + 2] = Math.round(png.data[index + 2]! * (1 - alpha) + color[2] * alpha)
  png.data[index + 3] = 255
}

function drawLine(png: PNG, x0: number, y0: number, x1: number, y1: number, color: Rgb, width = 1): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const x = Math.round(x0 + (x1 - x0) * t)
    const y = Math.round(y0 + (y1 - y0) * t)
    for (let dx = -width; dx <= width; dx += 1) {
      for (let dy = -width; dy <= width; dy += 1) {
        if (Math.hypot(dx, dy) > width + 0.2) continue
        setPixel(png, x + dx, y + dy, color)
      }
    }
  }
}

function drawCircle(png: PNG, cx: number, cy: number, radius: number, color: Rgb): void {
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= radius * radius) setPixel(png, cx + x, cy + y, color)
    }
  }
}

export interface StandardCalibrationFigure {
  buffer: Buffer
  calibration: CsLabPlotCalibration
  title: string
}

export function buildStandardCalibrationCurvePng(): StandardCalibrationFigure {
  const width = 1200
  const height = 800
  const png = createPng(width, height, [250, 249, 245])
  const left = 120
  const right = 1080
  const top = 80
  const bottom = 700
  const axis: Rgb = [58, 54, 48]
  const grid: Rgb = [222, 216, 205]
  const curve: Rgb = [47, 111, 237]
  const band: Rgb = [128, 164, 239]

  // 网格
  for (let step = 0; step <= 10; step += 1) {
    const x = Math.round(left + ((right - left) * step) / 10)
    drawLine(png, x, top, x, bottom, grid, 0)
  }
  for (let step = 0; step <= 10; step += 1) {
    const y = Math.round(bottom - ((bottom - top) * step) / 10)
    drawLine(png, left, y, right, y, grid, 0)
  }
  // 轴
  drawLine(png, left, bottom, right, bottom, axis, 1)
  drawLine(png, left, top, left, bottom, axis, 1)
  for (let step = 0; step <= 10; step += 1) {
    const x = Math.round(left + ((right - left) * step) / 10)
    drawLine(png, x, bottom, x, bottom + 8, axis, 1)
    const y = Math.round(bottom - ((bottom - top) * step) / 10)
    drawLine(png, left - 8, y, left, y, axis, 1)
  }

  const xValues = [10, 30, 50, 70, 90]
  const points = xValues.map((x, index) => {
    const yValue = 0.85 * x + 5 + [0.8, -1.2, 1.6, -0.6, 1.1][index]!
    return { xValue: x, yValue }
  })
  const toPx = (xValue: number): number => left + ((right - left) * xValue) / 100
  const toPy = (yValue: number): number => bottom - ((bottom - top) * yValue) / 100

  // 标准带（线性拟合 ± 误差）
  for (let xValue = 8; xValue <= 92; xValue += 1) {
    const center = 0.85 * xValue + 5
    const x = Math.round(toPx(xValue))
    const upper = Math.round(toPy(center + 3))
    const lower = Math.round(toPy(center - 3))
    drawLine(png, x, upper, x, lower, band, 1)
  }
  drawLine(png, toPx(5), toPy(0.85 * 5 + 5), toPx(95), toPy(0.85 * 95 + 5), curve, 1)

  for (const point of points) {
    const px = Math.round(toPx(point.xValue))
    const py = Math.round(toPy(point.yValue))
    drawLine(png, px, py - 18, px, py + 18, axis, 0)
    drawLine(png, px - 12, py - 18, px + 12, py - 18, axis, 0)
    drawLine(png, px - 12, py + 18, px + 12, py + 18, axis, 0)
    drawCircle(png, px, py, 6, curve)
  }

  const xTicks: CsLabAxisTick[] = [
    { px: left, py: bottom, value: 0 },
    { px: right, py: bottom, value: 100 },
  ]
  const yTicks: CsLabAxisTick[] = [
    { px: left, py: bottom, value: 0 },
    { px: left, py: top, value: 100 },
  ]

  return {
    buffer: PNG.sync.write(png),
    calibration: {
      x: { ticks: xTicks, scale: 'linear' },
      y: { ticks: yTicks, scale: 'linear' },
    },
    title: `${STANDARD_CALIBRATION_FILE} · 标准吸光度-浓度校准曲线（DEMO）`,
  }
}

export function buildFlagshipSemPseudoColorPng(): Buffer {
  const width = 1000
  const height = 700
  const png = createPng(width, height, [24, 18, 14])
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / width
      const ny = y / height
      const grains =
        Math.sin(nx * 57 + Math.sin(ny * 19) * 2.1)
        + Math.sin(ny * 83 + Math.cos(nx * 31) * 1.7)
        + Math.sin((nx + ny) * 41) * 0.6
      const bands = Math.sin(ny * 22 + Math.sin(nx * 5) * 1.2)
      const value = Math.max(0, Math.min(1, 0.45 + grains * 0.14 + bands * 0.2))
      const warm: Rgb = [212, 128, 48]
      const cool: Rgb = [78, 43, 32]
      const tint: Rgb = [
        Math.round(cool[0] + (warm[0] - cool[0]) * value),
        Math.round(cool[1] + (warm[1] - cool[1]) * value),
        Math.round(cool[2] + (warm[2] - cool[2]) * value),
      ]
      setPixel(png, x, y, tint)
    }
  }
  return PNG.sync.write(png)
}

export function buildFlagshipHillshadeSvg(raster: CsLabGeoRaster): string {
  const { width, height } = raster.meta
  const png = createPng(width, height, [245, 242, 234])
  const light = { x: -0.6, y: 0.5, z: 0.62 }
  for (let row = 1; row < height - 1; row += 1) {
    for (let col = 1; col < width - 1; col += 1) {
      const center = raster.values[row * width + col]
      if (!Number.isFinite(center)) continue
      const dzdx =
        (raster.values[row * width + col + 1]! - raster.values[row * width + col - 1]!) /
        (2 * raster.meta.cellsize)
      const dzdy =
        (raster.values[(row + 1) * width + col]! - raster.values[(row - 1) * width + col]!) /
        (2 * raster.meta.cellsize)
      const normalLength = Math.hypot(dzdx, dzdy, 1)
      const shade = Math.max(
        0,
        Math.min(1, (-dzdx * light.x - dzdy * light.y + light.z) / normalLength),
      )
      const base = 96 + Math.round(shade * 128)
      const tint: Rgb = [base, Math.round(base * 0.94), Math.round(base * 0.82)]
      setPixel(png, col, row, tint)
    }
  }
  const image = PNG.sync.write(png).toString('base64')
  const zones = [
    { name: 'Source zone', points: '0.08,0.1 0.38,0.06 0.46,0.34 0.2,0.42', color: '#b52f3b' },
    { name: 'Transport channel', points: '0.2,0.42 0.46,0.34 0.62,0.72 0.38,0.86', color: '#c47a2c' },
    { name: 'Deposition fan', points: '0.38,0.86 0.62,0.72 0.94,0.9 0.8,0.99', color: '#2f6fed' },
  ]
  const polygons = zones
    .map((zone) => {
      const [firstX, firstY] = zone.points.split(' ')[0]!.split(',').map(Number)
      const points = zone.points
        .split(' ')
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number)
          return `${(x ?? 0) * width},${(y ?? 0) * height}`
        })
        .join(' ')
      return `<polygon points="${points}" fill="${zone.color}" fill-opacity="0.28" stroke="${zone.color}" stroke-width="2"/>`
        + `<text x="${(firstX ?? 0) * width + 8}" y="${(firstY ?? 0) * height + 20}" font-family="serif" font-size="18" fill="${zone.color}">${zone.name}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>Wenjia Gully DEM hillshade and geological zones (DEMO)</title>
  <rect width="100%" height="100%" fill="#f5f2ea"/>
  <image href="data:image/png;base64,${image}" width="${width}" height="${height}"/>
  ${polygons}
</svg>`
}

// ===== 出版图版 =====

function basePlot(labId: string, id: string, title: string): CsLabPlotDocument {
  return createPlotDocument({ id, labId, title, presetId: 'nature' })
}

function series(input: Omit<CsLabPlotSeries, 'visible' | 'alpha'>): CsLabPlotSeries {
  return { ...input, visible: true, alpha: 1 }
}

export async function buildFlagshipPlots(input: {
  labId: string
  cd: FlagshipSpectrumData
  xrd: FlagshipXrdData
  rutileCifText: string
}): Promise<{ plots: CsLabPlotDocument[]; warnings: string[] }> {
  const warnings: string[] = []
  const cdPlot = basePlot(input.labId, FLAGSHIP_PLOT_IDS[0], '生物大分子 CD 光谱与去卷积（DEMO）')
  const fit = await fitPeaks({
    x: input.cd.wavelength,
    y: input.cd.cd,
    peaks: [
      { center: 208, fwhm: 8 },
      { center: 222, fwhm: 9 },
    ],
    model: 'gaussian',
    baseline: 'linear',
  })
  warnings.push(...fit.warnings)
  const layer = cdPlot.layers[0]!
  const componentSeries: CsLabPlotSeries[] = fit.peaks.map((peak, index) =>
    series({
      id: `cd-component-${index + 1}`,
      name: `Component ${index + 1} (${peak.center.toFixed(1)} nm)`,
      x: input.cd.wavelength,
      y: input.cd.wavelength.map((wl) => gaussian(wl, peak.center, peak.fwhm / 2.355, peak.height)),
      color: index === 0 ? '#c47a2c' : '#2f6fed',
      lineWidth: 0.6,
      lineStyle: 'dash',
      marker: 'none',
      yAxis: 0,
    }),
  )
  const residualLayer = {
    ...layer,
    id: 'layer-residual',
    name: '拟合残差',
    series: [
      series({
        id: 'cd-residual',
        name: 'Residual',
        x: input.cd.wavelength,
        y: fit.residual,
        color: '#7c7468',
        lineWidth: 0.5,
        lineStyle: 'solid',
        marker: 'none',
        yAxis: 0,
      }),
    ],
    xAxis: { ...layer.xAxis, title: 'Wavelength', unit: 'nm' },
    yAxes: [
      { ...layer.yAxes[0]!, title: 'Residual CD', unit: 'mdeg' },
      layer.yAxes[1]!,
    ] as typeof layer.yAxes,
  }
  cdPlot.layers = [
    {
      ...layer,
      series: [
        series({
          id: 'cd-raw',
          name: 'CD (measured, DEMO)',
          x: input.cd.wavelength,
          y: input.cd.cd,
          color: '#3a3630',
          lineWidth: 0.7,
          lineStyle: 'solid',
          marker: 'none',
          yAxis: 0,
        }),
        series({
          id: 'cd-fit',
          name: `Deconvolution fit (R²=${fit.rSquared.toFixed(4)})`,
          x: input.cd.wavelength,
          y: fit.fitted,
          color: '#b52f3b',
          lineWidth: 0.8,
          lineStyle: 'solid',
          marker: 'none',
          yAxis: 0,
        }),
        ...componentSeries,
      ],
      xAxis: { ...layer.xAxis, title: 'Wavelength', unit: 'nm' },
      yAxes: [
        { ...layer.yAxes[0]!, title: 'CD', unit: 'mdeg' },
        { ...layer.yAxes[1]!, title: 'Absorbance', unit: 'a.u.' },
      ] as typeof layer.yAxes,
    },
    residualLayer,
  ]

  const xrdPlot = createPlotDocument({
    id: FLAGSHIP_PLOT_IDS[1],
    labId: input.labId,
    title: '生物矿化晶体 XRD 实验与理论对比（DEMO）',
    presetId: 'science',
    widthMm: 120,
  })
  const xrdLayer = xrdPlot.layers[0]!
  const structure = buildStructureFromText(input.rutileCifText, 'cif')
  const pattern = simulatePxrd(structure, {
    minTwoTheta: 10,
    maxTwoTheta: 70,
    fwhmDeg: 0.12,
    stepDeg: 0.02,
  })
  warnings.push(...pattern.warnings)
  const theoryX = pattern.curve.x
  const theoryY = pattern.curve.y
  const theoryMax = Math.max(...theoryY, 1)
  const experimentMax = Math.max(...input.xrd.intensity, 1)
  xrdPlot.layers = [
    {
      ...xrdLayer,
      series: [
        series({
          id: 'xrd-experiment',
          name: 'Experiment (Cu Kα, DEMO)',
          x: input.xrd.twoTheta,
          y: input.xrd.intensity.map((value) => (value / experimentMax) * 100),
          color: '#3a3630',
          lineWidth: 0.7,
          lineStyle: 'solid',
          marker: 'none',
          yAxis: 0,
        }),
        series({
          id: 'xrd-theory',
          name: 'Rietveld-like simulation',
          x: theoryX,
          y: theoryY.map((value) => (value / theoryMax) * 100),
          color: '#b52f3b',
          lineWidth: 0.7,
          lineStyle: 'dash',
          marker: 'none',
          yAxis: 1,
        }),
      ],
      xAxis: { ...xrdLayer.xAxis, title: '2θ (Cu Kα)', unit: 'deg' },
      yAxes: [
        { ...xrdLayer.yAxes[0]!, title: 'Experimental intensity', unit: 'a.u.' },
        { ...xrdLayer.yAxes[1]!, title: 'Simulated intensity', unit: 'a.u.' },
      ] as typeof xrdLayer.yAxes,
    },
  ]
  return { plots: [cdPlot, xrdPlot], warnings }
}

// ===== 演示论文 =====

export function buildFlagshipPaperPdf(): Buffer {
  return buildTwoColumnTextPdf({
    title: FLAGSHIP_PAPER_TITLE,
    subtitle: 'DEMO manuscript generated for CDUT Science onboarding. Synthetic spectra only.',
    sections: [
      {
        heading: 'Abstract',
        paragraphs: [
          'Deep-subsurface microbial communities couple carbon, sulfur and iron cycling across sedimentary basins. This demonstration manuscript integrates a public ribosomal subunit structure, a B-DNA dodecamer, a perovskite unit cell, a synthetic circular-dichroism spectrum and a synthetic powder X-ray pattern to exercise the CDUT Science literature, structure, plotting and manuscript toolchain.',
          'All spectral values in this document are synthetic and labelled DEMO. Structural coordinates are taken from public PDB entries. No field measurement is reported.',
        ],
      },
      {
        heading: '1 Introduction',
        paragraphs: [
          'The deep biosphere extends from shallow sediments to fractured crystalline rock. Ribosomal structure stability and mineral-associated organic matter are central to estimates of long-term carbon sequestration.',
          'Sediment dynamics in mountain catchments redistribute microbial biomass and reactive iron phases. Linking surface processes with subsurface biogeochemistry requires reproducible data pipelines and explicit uncertainty.',
        ],
      },
      {
        heading: '2 Materials and Methods',
        paragraphs: [
          'Circular dichroism (CD) spectra were generated with two Gaussian bands centred at 208 nm and 222 nm. The synthetic trace is used only to demonstrate multi-peak deconvolution in the Origin plotting engine.',
          'Powder X-ray diffraction was simulated from a rutile TiO2 unit cell using the kinematic approximation. The experimental trace is synthetic; peak positions are not certified reference values.',
          'Equation (1) defines the Gaussian profile used for deconvolution:',
          'y(x) = A * exp(-((x - x0) / w)^2)   (1)',
        ],
      },
      {
        heading: '3 Results',
        paragraphs: [
          'The CD deconvolution resolves two negative bands with a residual root-mean-square error reported by the fitting engine. The dual-axis XRD figure compares the synthetic experiment with the simulated pattern.',
          'Structural inspection of the 50S subunit and the B-DNA dodecamer highlights the spatial complexity that any coarse-grained biogeochemical model must approximate.',
        ],
      },
      {
        heading: '4 Discussion',
        paragraphs: [
          'The demonstration deliberately separates measured and synthetic evidence. Public structural coordinates are reproducible, while the spectra are pedagogical constructs. This separation is a prerequisite for honest scientific communication.',
          'Subsurface fault geometry cannot be inferred from a 2.5D surface DEM. Any three-dimensional structural interpretation requires borehole constraints, geophysical profiles and an unstructured volumetric mesh.',
        ],
      },
      {
        heading: '5 Limitations',
        paragraphs: [
          'The spectra are synthetic. The diffraction simulation is kinematic and is not a Rietveld refinement. The DEM shown elsewhere in this laboratory is a demonstration surface, not a surveyed product.',
          'No result in this manuscript should be used for engineering design, hazard zoning or carbon accounting.',
        ],
      },
      {
        heading: 'References',
        paragraphs: [
          '[1] Ban, N. et al. (2000) The complete atomic structure of the large ribosomal subunit at 2.4 A resolution. Science.',
          '[2] Drew, H.R. et al. (1981) Structure of a B-DNA dodecamer. Proceedings of the National Academy of Sciences.',
          '[3] CSLab Demo Group (2026) Synthetic CD and XRD demonstration traces. CDUT Science demonstration note.',
        ],
      },
    ],
  })
}

// ===== 双链笔记 =====

export interface FlagshipNote {
  relPath: string
  title: string
  content: string
}

const NOTE_TOPICS: Array<{ slug: string; title: string; body: string[] }> = [
  {
    slug: 'ribosome-thermal-stability',
    title: '核糖体在极端热泉环境的结构稳定性',
    body: [
      '核糖体大亚基的 rRNA 骨架在高温下依赖离子网络与蛋白伴侣维持折叠。演示结构来自公开 PDB 1FFK。',
      '与 [[铁硫化物生物矿化机制]] 的耦合假设：矿物表面可能为 rRNA 提供额外的静电屏蔽。',
    ],
  },
  {
    slug: 'iron-sulfur-biomineralization',
    title: '铁硫化物生物矿化机制',
    body: [
      '铁硫簇的沉淀受 pH、氧化还原电位与有机配体控制。演示数据仅用于展示矿物相与蛋白的共定位关系。',
      '相关实验记录见 [[深地微生物碳汇同位素分馏]]。',
    ],
  },
  {
    slug: 'deep-carbon-isotope-fractionation',
    title: '深地微生物碳汇同位素分馏',
    body: [
      '碳同位素分馏可指示自养与异养过程的相对贡献。演示笔记不包含任何实测同位素比值。',
      '方法学依赖 [[沉积物输运与有机碳埋藏]]。',
    ],
  },
  {
    slug: 'sediment-organic-carbon-burial',
    title: '沉积物输运与有机碳埋藏',
    body: [
      '泥石流源区碎屑物质的再搬运会改变有机碳的粒径分布与保存效率。',
      '地貌约束见 [[文家沟流域 2.5D 地形分析]]。',
    ],
  },
  {
    slug: 'wenjia-2p5d-terrain',
    title: '文家沟流域 2.5D 地形分析',
    body: [
      'DEM 数据仅表达地表高程。坡度、坡向与 D8 汇流可用于识别源区与沟道，但不能推断地下断层。',
      '与 [[地下三维断层的数据边界]] 对照阅读。',
    ],
  },
  {
    slug: 'subsurface-fault-data-boundary',
    title: '地下三维断层的数据边界',
    body: [
      '地下断层面需要钻孔、物探剖面与非结构化体网格。仅凭地表 DEM 不能构造可信的三维断层面。',
      '本笔记是 [[文家沟流域 2.5D 地形分析]] 的边界说明。',
    ],
  },
  {
    slug: 'cd-spectra-deconvolution',
    title: 'CD 光谱去卷积与残差诊断',
    body: [
      '双高斯模型用于演示 208 nm 与 222 nm 两个负带的分离。残差图用于判断基线是否被过度吸收。',
      '图版见 [[Origin 出版绘图规范]]。',
    ],
  },
  {
    slug: 'origin-publication-plotting',
    title: 'Origin 出版绘图规范',
    body: [
      'Nature 单栏图版强调字号、线宽与留白的一致性；Science 双 Y 轴图版必须明确左右轴单位。',
      '数据来源见 [[CD 光谱去卷积与残差诊断]] 与 [[XRD 实验与理论对比]]。',
    ],
  },
  {
    slug: 'xrd-experiment-vs-theory',
    title: 'XRD 实验与理论对比',
    body: [
      '理论谱为运动学近似，峰位来自晶胞参数；实验谱为合成演示。二者不可直接用于 Rietveld 精修结论。',
      '相关图版见 [[Origin 出版绘图规范]]。',
    ],
  },
  {
    slug: 'dna-dodecamer-structure',
    title: 'B-DNA 十二聚体的沟槽与碱基配对',
    body: [
      '公开结构 1BNA 展示了大沟、小沟与互补碱基配对。该结构用于演示 Mol* 的穿插深度与自旋。',
      '与 [[核糖体在极端热泉环境的结构稳定性]] 并列观察。',
    ],
  },
  {
    slug: 'perovskite-unit-cell',
    title: '钙钛矿晶胞与配位多面体',
    body: [
      'SrTiO3 立方晶胞用于演示 Ti-O 八面体的配位多面体高亮与晶胞对称性。',
      '运行参数见 [[Origin 出版绘图规范]] 与 [[实验记录规范]]。',
    ],
  },
  {
    slug: 'experiment-record-standard',
    title: '实验记录规范',
    body: [
      '每条记录必须包含数据 URI、生成参数、软件版本与人工复核状态。演示数据必须标注 DEMO。',
      '本笔记是 [[深地生物圈推演]] 画布的入口。',
    ],
  },
]

export function buildFlagshipNotes(): FlagshipNote[] {
  return NOTE_TOPICS.map((topic) => ({
    relPath: `vault/notes/${topic.slug}.md`,
    title: topic.title,
    content: [
      `# ${topic.title}`,
      '',
      '> 本笔记由 CSLab 旗舰演示实验室自动生成。除公开结构坐标外，所有数值均为 DEMO。',
      '',
      ...topic.body,
      '',
      `返回画布：[[${FLAGSHIP_CANVAS_TITLE}]]`,
      '',
    ].join('\n'),
  }))
}

// ===== JSON Canvas =====

export function buildFlagshipCanvasDocument(input: {
  tableUri?: string
  demUri?: string
  plotIds?: readonly string[]
  paperTitle?: string
}): CsLabCanvasDocument {
  const nodes: CsLabCanvasNode[] = [
    {
      id: 'n-ribosome',
      type: 'text',
      x: 40,
      y: 40,
      width: 250,
      height: 110,
      color: '4',
      text: '## 核糖体大亚基\n公开结构 1FFK · 热泉稳定性假设',
      cdut_science: {
        node_kind: 'premise',
        manual_status: 'verified',
        confidence_score: 1,
        ...(input.tableUri ? { cdut_uri: input.tableUri } : {}),
      },
    },
    {
      id: 'n-mineral',
      type: 'text',
      x: 40,
      y: 200,
      width: 250,
      height: 110,
      color: '4',
      text: '## 铁硫化物矿化\n矿物表面与 rRNA 静电屏蔽',
      cdut_science: {
        node_kind: 'hypothesis',
        manual_status: 'pending',
        confidence_score: 0.62,
      },
    },
    {
      id: 'n-dem',
      type: 'text',
      x: 40,
      y: 360,
      width: 250,
      height: 110,
      color: '4',
      text: '## 文家沟 2.5D DEM\n坡度 / 汇流 / 源区',
      cdut_science: {
        node_kind: 'premise',
        manual_status: 'verified',
        confidence_score: 1,
        ...(input.demUri ? { cdut_uri: input.demUri } : {}),
      },
    },
    {
      id: 'n-cd',
      type: 'text',
      x: 360,
      y: 40,
      width: 240,
      height: 110,
      color: '2',
      text: '## CD 去卷积\n208 / 222 nm 双负带',
      cdut_science: {
        node_kind: 'experiment',
        manual_status: 'verified',
        confidence_score: 0.9,
        ...(input.plotIds?.[0] ? { cdut_uri: `plot:${input.plotIds[0]}` } : {}),
      },
    },
    {
      id: 'n-xrd',
      type: 'text',
      x: 360,
      y: 200,
      width: 240,
      height: 110,
      color: '2',
      text: '## XRD 实验 vs 理论\n运动学近似，非 Rietveld',
      cdut_science: {
        node_kind: 'experiment',
        manual_status: 'verified',
        confidence_score: 0.85,
        ...(input.plotIds?.[1] ? { cdut_uri: `plot:${input.plotIds[1]}` } : {}),
      },
    },
    {
      id: 'n-carbon',
      type: 'text',
      x: 360,
      y: 360,
      width: 240,
      height: 110,
      color: '3',
      text: '## 碳汇同位素分馏\n待补充实测比值',
      cdut_science: {
        node_kind: 'inference',
        manual_status: 'pending',
        confidence_score: 0.55,
      },
    },
    {
      id: 'n-fault',
      type: 'text',
      x: 680,
      y: 200,
      width: 250,
      height: 110,
      color: '1',
      text: '## 地下 3D 断层\n缺钻孔/物探 · 死路剪枝',
      cdut_science: {
        node_kind: 'note',
        manual_status: 'dead_end',
        confidence_score: 0,
      },
    },
    {
      id: 'n-paper',
      type: 'text',
      x: 680,
      y: 40,
      width: 250,
      height: 110,
      color: '5',
      text: `## 演示论文\n${input.paperTitle ?? FLAGSHIP_PAPER_TITLE}`,
      cdut_science: {
        node_kind: 'note',
        manual_status: 'verified',
        confidence_score: 1,
      },
    },
  ]
  const edges: CsLabCanvasEdge[] = [
    {
      id: 'e-ribosome-mineral',
      fromNode: 'n-ribosome',
      toNode: 'n-mineral',
      fromSide: 'bottom',
      toSide: 'top',
      label: 'AND',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-mineral-carbon',
      fromNode: 'n-mineral',
      toNode: 'n-carbon',
      fromSide: 'right',
      toSide: 'left',
      label: 'OR',
      cdut_science: { dependency_type: 'disjunctive' },
    },
    {
      id: 'e-dem-carbon',
      fromNode: 'n-dem',
      toNode: 'n-carbon',
      fromSide: 'right',
      toSide: 'bottom',
      label: 'AND',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-cd-paper',
      fromNode: 'n-cd',
      toNode: 'n-paper',
      fromSide: 'top',
      toSide: 'bottom',
      label: 'supports',
    },
    {
      id: 'e-xrd-paper',
      fromNode: 'n-xrd',
      toNode: 'n-paper',
      fromSide: 'right',
      toSide: 'left',
      label: 'supports',
    },
    {
      id: 'e-dem-fault',
      fromNode: 'n-dem',
      toNode: 'n-fault',
      fromSide: 'right',
      toSide: 'left',
      label: 'pruned',
    },
  ]
  return { nodes, edges }
}
