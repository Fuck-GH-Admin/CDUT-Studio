/**
 * 演示实验室 · 成都理工大学 SKLGP 泥石流动力学推演
 *
 * 内置合成 Wenjia-like 沟谷 DEM、小时降雨、出口时程与演示论文 PDF；
 * 首次创建时跑一次短时 Voellmy 推演，生成最大水深/流速栅格、危险性图版与两套出版图。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  CsLabAssetSummary,
  CsLabDemoLabResult,
  CsLabLab,
  CsLabPlotDocument,
  CsLabPlotSeries,
} from '@profer/shared'
import { createPlotDocument } from '@profer/shared'
import { createLab, listLabs } from './cslab-manager'
import { ingestFiles, listAssets } from './cslab-iron-cage'
import { savePlot } from './cslab-science'
import { broadcastCsLabEvent } from './cslab-events'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import { buildSkLgpDemoPaperPdf } from './cslab-demo-pdf'
import {
  analyzeDem,
  buildRainfallThresholdResult,
  parseGeoRasterBuffer,
  renderHazardMapPng,
  simulateDebrisFlowDetailed,
  writeEsriAsciiGrid,
} from './cslab-geohazard'
import { registerEntityFile } from './cslab-geohazard-tools'
import { DEMO_LAB_NAMES, resolveGeohazardDemoDir } from './cslab-demo'

const REQUIRED_FILES = [
  'wenjia_gully_dem.asc',
  'rainfall_timeseries.csv',
  'debris_flow_timeseries.csv',
] as const

const PLOT_IDS = [
  'demo-sklgp-id-curve',
  'demo-sklgp-timeseries',
  'demo-sklgp-runout-profile',
] as const

async function requireDemoFiles(demoDir: string): Promise<string[]> {
  const paths: string[] = []
  const missing: string[] = []
  for (const fileName of REQUIRED_FILES) {
    const path = join(demoDir, fileName)
    try {
      await fs.access(path)
      paths.push(path)
    } catch {
      missing.push(fileName)
    }
  }
  if (missing.length > 0) {
    throw new Error(`SKLGP 演示数据缺失：${missing.join('、')}（期望目录 ${demoDir}）`)
  }
  return paths
}

async function writeDemoPaper(): Promise<string> {
  const path = join(tmpdir(), `sklgp-demo-paper-${Date.now()}.pdf`)
  await fs.writeFile(path, buildSkLgpDemoPaperPdf())
  return path
}

function basePlot(labId: string, id: string, title: string): CsLabPlotDocument {
  return createPlotDocument({ id, labId, title, presetId: 'nature' })
}

async function saveDemoPlot(labId: string, plot: CsLabPlotDocument): Promise<void> {
  const summary = await savePlot({ labId, plot })
  broadcastCsLabEvent(CSLAB_IPC_CHANNELS.ON_PLOT_UPDATED, {
    labId,
    plot: { ...plot, updatedAt: summary.updatedAt },
    source: 'agent',
  })
}

function buildIdCurvePlot(labId: string): { plot: CsLabPlotDocument; alpha: number; beta: number } {
  const threshold = buildRainfallThresholdResult({})
  const plot = basePlot(labId, PLOT_IDS[0], '临界降雨 I-D 曲线（示例参数）')
  const layer = plot.layers[0]!
  const series: CsLabPlotSeries = {
    id: 'id-curve',
    name: `I = ${threshold.alpha}·D^-${threshold.beta}`,
    x: threshold.curve.map((point) => point.durationMin),
    y: threshold.curve.map((point) => point.intensityMmPerHour),
    color: '#b52f3b',
    lineWidth: 0.7,
    lineStyle: 'solid',
    marker: 'circle',
    yAxis: 0,
    visible: true,
    alpha: 1,
  }
  return {
    alpha: threshold.alpha,
    beta: threshold.beta,
    plot: {
      ...plot,
      layers: [{
        ...layer,
        series: [series],
        xAxis: { ...layer.xAxis, title: 'Duration', unit: 'min', scale: 'log10' },
        yAxes: [
          { ...layer.yAxes[0]!, title: 'Intensity', unit: 'mm/h', scale: 'log10' },
          layer.yAxes[1]!,
        ],
      }],
      updatedAt: Date.now(),
    },
  }
}

function buildTimeseriesPlot(
  labId: string,
  timeseries: Array<{ timeS: number; dischargeM3s: number; depthM: number; velocityMs: number }>,
): CsLabPlotDocument {
  const plot = basePlot(labId, PLOT_IDS[1], '泥石流出口流量 / 水深 / 流速时程')
  const layer = plot.layers[0]!
  const x = timeseries.map((point) => point.timeS)
  const series: CsLabPlotSeries[] = [
    {
      id: 'discharge',
      name: '流量',
      x,
      y: timeseries.map((point) => point.dischargeM3s),
      color: '#2f6fed',
      lineWidth: 0.7,
      lineStyle: 'solid',
      marker: 'none',
      yAxis: 0,
      visible: true,
      alpha: 1,
    },
    {
      id: 'depth',
      name: '水深',
      x,
      y: timeseries.map((point) => point.depthM),
      color: '#b52f3b',
      lineWidth: 0.6,
      lineStyle: 'dash',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
    {
      id: 'velocity',
      name: '流速',
      x,
      y: timeseries.map((point) => point.velocityMs),
      color: '#2e9e6b',
      lineWidth: 0.5,
      lineStyle: 'dot',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
  ]
  return {
    ...plot,
    layers: [{
      ...layer,
      series,
      xAxis: { ...layer.xAxis, title: 'Time', unit: 's' },
      yAxes: [
        { ...layer.yAxes[0]!, title: 'Discharge', unit: 'm³/s' },
        { ...layer.yAxes[1]!, title: 'Depth / Velocity', unit: 'm / m·s⁻¹' },
      ],
    }],
    updatedAt: Date.now(),
  }
}

function buildRunoutProfile(
  labId: string,
  raster: Awaited<ReturnType<typeof parseGeoRasterBuffer>>,
  maxDepth: Float32Array,
  flowAccumulation: Float32Array,
  threshold: number,
  sourceRow: number,
): CsLabPlotDocument {
  const { width, height, cellsize } = raster.meta
  const distances: number[] = []
  const elevations: number[] = []
  const depths: number[] = []
  for (let row = 0; row < height; row += 1) {
    let bestCol = -1
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col
      if (!Number.isFinite(raster.values[index])) continue
      if (flowAccumulation[index]! < threshold) continue
      if (bestCol < 0 || flowAccumulation[index]! > flowAccumulation[row * width + bestCol]!) {
        bestCol = col
      }
    }
    if (bestCol < 0) continue
    const index = row * width + bestCol
    distances.push(Math.abs(row - sourceRow) * cellsize)
    elevations.push(raster.values[index]!)
    depths.push(maxDepth[index]!)
  }
  const plot = basePlot(labId, PLOT_IDS[2], '主沟纵剖面 · 高程与最大水深')
  const layer = plot.layers[0]!
  const series: CsLabPlotSeries[] = [
    {
      id: 'elevation',
      name: '高程',
      x: distances,
      y: elevations,
      color: '#5c6670',
      lineWidth: 0.8,
      lineStyle: 'solid',
      marker: 'none',
      yAxis: 0,
      visible: true,
      alpha: 1,
    },
    {
      id: 'max-depth',
      name: '最大水深',
      x: distances,
      y: depths,
      color: '#b52f3b',
      lineWidth: 0.7,
      lineStyle: 'dash',
      marker: 'none',
      yAxis: 1,
      visible: true,
      alpha: 1,
    },
  ]
  return {
    ...plot,
    layers: [{
      ...layer,
      series,
      xAxis: { ...layer.xAxis, title: 'Downstream distance', unit: 'm' },
      yAxes: [
        { ...layer.yAxes[0]!, title: 'Elevation', unit: 'm' },
        { ...layer.yAxes[1]!, title: 'Max depth', unit: 'm' },
      ],
    }],
    updatedAt: Date.now(),
  }
}

export async function createSkLgpGeohazardDemoLab(demoDirInput?: string): Promise<CsLabDemoLabResult> {
  const demoDir = resolveGeohazardDemoDir(demoDirInput)
  const dataPaths = await requireDemoFiles(demoDir)
  const paperPath = await writeDemoPaper()

  const existing = listLabs().find((lab) => lab.demoKind === 'sklgp-geohazard')
  const lab: CsLabLab = existing ?? createLab({
    name: DEMO_LAB_NAMES['sklgp-geohazard'],
    description:
      '内置 SKLGP 方向演示沙箱：合成 Wenjia-like 沟谷 DEM、小时降雨、入口时程、I-D 临界降雨曲线、Voellmy 泥石流推演与危险性分区图版。',
    tags: ['演示', 'SKLGP', '泥石流', 'DEM', 'I-D 曲线', 'Voellmy', '危险性图版'],
    demoKind: 'sklgp-geohazard',
  })

  const ingestResults = await ingestFiles(lab.id, [...dataPaths, paperPath])
  const failed = ingestResults.filter((result) => result.status !== 'ok')
  if (failed.length > 0) {
    throw new Error(`SKLGP 演示数据摄取失败：${failed.map((result) => result.message).join('；')}`)
  }

  const plotIds: string[] = []
  let geohazardStats: CsLabDemoLabResult['geohazardStats']

  try {
    const demBuffer = await fs.readFile(join(demoDir, 'wenjia_gully_dem.asc'))
    const raster = await parseGeoRasterBuffer(demBuffer, 'wenjia_gully_dem.asc')
    const analysis = analyzeDem(raster)
    const { result, grid } = simulateDebrisFlowDetailed(raster, {
      demUri: 'demo://wenjia',
      rheology: { model: 'voellmy', mu: 0.2, xi: 400 },
      volumeM3: 200_000,
      durationS: 300,
      engine: 'typescript',
    })

    const metaJson = JSON.stringify({
      kind: 'debris-flow-demo',
      width: raster.meta.width,
      height: raster.meta.height,
      cellsize: raster.meta.cellsize,
      model: result.model,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'geo',
      title: '最大水深 · SKLGP 演示',
      format: 'esri-ascii-grid',
      relDir: 'geo',
      content: writeEsriAsciiGrid(raster.meta, grid.maxH),
      metaJson,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'geo',
      title: '最大流速 · SKLGP 演示',
      format: 'esri-ascii-grid',
      relDir: 'geo',
      content: writeEsriAsciiGrid(raster.meta, grid.maxSpeed),
      metaJson,
    })
    await registerEntityFile({
      labId: lab.id,
      layerType: 'fig',
      title: '危险性分区图 · SKLGP 演示',
      format: 'png',
      relDir: 'figures',
      content: renderHazardMapPng(
        raster,
        { meta: raster.meta, values: grid.maxH },
        { meta: raster.meta, values: grid.maxSpeed },
        result.source,
      ),
      metaJson,
    })

    const idPlot = buildIdCurvePlot(lab.id)
    await saveDemoPlot(lab.id, idPlot.plot)
    plotIds.push(idPlot.plot.id)

    const timeseriesPlot = buildTimeseriesPlot(lab.id, result.timeseries)
    await saveDemoPlot(lab.id, timeseriesPlot)
    plotIds.push(timeseriesPlot.id)

    const profile = buildRunoutProfile(
      lab.id,
      raster,
      grid.maxH,
      analysis.flowAccumulation,
      analysis.channelThreshold,
      result.source.row,
    )
    await saveDemoPlot(lab.id, profile)
    plotIds.push(profile.id)

    geohazardStats = {
      nistMaxDeviationDeg: 0,
      ramanRSquared: 0,
      ramanAreaRelativeError: 0,
      peakDischargeM3s: result.peakDischargeM3s,
      runoutDistanceM: result.runoutDistanceM,
      maxFlowDepthM: result.maxDepthM,
    }
  } catch (error) {
    console.warn('[CSLab] SKLGP 演示推演生成失败（实验室仍可用）:', error)
  }

  const assets = await listAssets(lab.id)
  return {
    lab,
    assets,
    plotId: plotIds[0],
    plotIds,
    kind: 'sklgp-geohazard',
    geohazardStats,
  }
}
