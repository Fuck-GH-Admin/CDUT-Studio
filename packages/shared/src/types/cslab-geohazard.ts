/**
 * CSLab 地质灾害（SKLGP 泥石流方向）数据契约
 *
 * 只定义栅格、降雨阈值、动力学推演与图版的纯数据模型；
 * 数值实现位于主进程 cslab-geohazard 模块，渲染层不直接依赖。
 */

export type CsLabGeoRasterKind = 'esri-ascii' | 'geotiff'

/** DEM / 推演输出栅格的空间元数据。 */
export interface CsLabGeoRasterMeta {
  width: number
  height: number
  /** 网格边长（米）。 */
  cellsize: number
  xllcorner: number
  yllcorner: number
  /** 无效高程标记；未声明时视为 NaN 屏蔽。 */
  nodata?: number
  min: number
  max: number
  kind: CsLabGeoRasterKind
  /** 地理参考缺失或降级时的说明。 */
  warnings?: string[]
}

export interface CsLabGeoRaster {
  meta: CsLabGeoRasterMeta
  /** 行优先，南→北为行为递增方向（与 ESRI ASCII 一致：第一行为北侧）。 */
  values: Float32Array
}

/** 渲染层 2.5D 地貌载荷：降采样后的高程与 D8 汇流矩阵。 */
export interface CsLabGeoRasterPayload {
  uri: string
  title: string
  meta: CsLabGeoRasterMeta
  /** 行优先高程；NaN 表示无效格网。 */
  heights: number[]
  /** 行优先 D8 汇流累积量。 */
  flowAccumulation: number[]
  channelThreshold: number
  sampledWidth: number
  sampledHeight: number
  stride: number
}

export interface CsLabDemAnalysisInput {
  demUri: string
}

export interface CsLabDemAnalysisResult {
  ok: boolean
  uri: string
  width: number
  height: number
  cellsizeM: number
  minElevationM: number
  maxElevationM: number
  meanSlopeDeg: number
  maxSlopeDeg: number
  dominantAspect: string
  /** D8 流向统计：方向 → 网格数。 */
  flowDirectionCounts: Record<string, number>
  flowAccumulationMax: number
  channelThreshold: number
  channelCount: number
  suggestedSource?: { row: number; col: number; elevation: number }
  message?: string
}

export interface CsLabRainfallPoint {
  /** 降雨历时（分钟）。 */
  durationMin: number
  /** 平均降雨强度（mm/h）。 */
  intensityMmPerHour: number
}

export interface CsLabRainfallThresholdInput {
  /** 历史/试验临界点；缺省用区域示例参数。 */
  points?: CsLabRainfallPoint[]
  alpha?: number
  beta?: number
  durationsMin?: number[]
}

export interface CsLabRainfallThresholdPoint {
  durationMin: number
  intensityMmPerHour: number
}

export interface CsLabRainfallThresholdResult {
  ok: boolean
  alpha: number
  beta: number
  /** 幂律拟合 R²；使用默认参数时为 undefined。 */
  rSquared?: number
  curve: CsLabRainfallThresholdPoint[]
  designIntensity?: number
  usedDefaultParameters: boolean
  message?: string
}

export type CsLabDebrisFlowRheology =
  | { model: 'voellmy'; mu: number; xi: number }
  | { model: 'bingham'; yieldStressPa: number; viscosityPaS: number }

export interface CsLabDebrisFlowSimulationInput {
  demUri: string
  /** 源区网格；缺省使用 DEM 分析给出的建议源区。 */
  source?: { row: number; col: number }
  rheology: CsLabDebrisFlowRheology
  /** 直接给定释放体积（m³）；与 rainfall 二选一。 */
  volumeM3?: number
  rainfall?: {
    intensityMmPerHour: number
    durationMin: number
    /** 径流系数（0-1），缺省 0.7。 */
    runoffCoefficient?: number
    /** 汇水面积（m²）；缺省用源区以上汇流面积估算。 */
    catchmentAreaM2?: number
  }
  /** 推演时长（秒），缺省 600。 */
  durationS?: number
  /** CFL 系数，缺省 0.4。 */
  cfl?: number
  /** 沉积流速阈值（m/s），缺省 0.5。 */
  depositionVelocity?: number
  engine?: 'auto' | 'typescript' | 'python'
}

export interface CsLabDebrisFlowTimePoint {
  timeS: number
  dischargeM3s: number
  depthM: number
  velocityMs: number
}

export interface CsLabDebrisFlowSimulationOutputs {
  maxDepthUri?: string
  maxSpeedUri?: string
  arrivalTimeUri?: string
  hazardPngUri?: string
  plotId?: string
}

export interface CsLabDebrisFlowSimulationResult {
  ok: boolean
  demUri: string
  model: 'voellmy' | 'bingham'
  engineUsed: 'typescript' | 'python'
  source: { row: number; col: number; elevation: number }
  releasedVolumeM3: number
  peakDischargeM3s: number
  maxDepthM: number
  maxSpeedMs: number
  runoutDistanceM: number
  depositionVolumeM3: number
  arrivalTimeS?: number
  hazardAreaM2: { high: number; medium: number; low: number }
  timeseries: CsLabDebrisFlowTimePoint[]
  outputs: CsLabDebrisFlowSimulationOutputs
  warnings: string[]
  message?: string
}

export interface CsLabHazardMapInput {
  demUri: string
  /** 已有最大水深栅格；与 simulationId 二选一。 */
  maxDepthUri?: string
  /** 仅用于缓存键与标题。 */
  simulationId?: string
  highDepthM?: number
  mediumDepthM?: number
  lowDepthM?: number
  exportFormat?: 'png' | 'svg' | 'pdf'
}

export interface CsLabHazardMapResult {
  ok: boolean
  hazardPngUri?: string
  plotId?: string
  exportedPath?: string
  hazardAreaM2?: { high: number; medium: number; low: number }
  message?: string
}
