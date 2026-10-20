/**
 * CSLab 晶体学纯函数（主进程 / 渲染进程共用）
 *
 * 只做数学与文本解析，不依赖 Mol* 或 Electron：
 * - CIF 晶胞参数解析（容忍 `4.5937(3)` 不确定度与引号空间群）；
 * - 三斜/四方/立方通用的晶面间距与衍射角换算；
 * - 实空间基矢 -> 倒易基矢 -> 归一化 Miller 法向量；
 * - 2θ 反查 (hkl)（用于 XRD 峰 -> 3D 晶面联动）。
 *
 * 红线：所有函数在参数不合理时返回 null / 空数组，绝不猜测或伪造晶面。
 */

import type {
  CsLabCrystalCell,
  CsLabMillerPlane,
  CsLabXrdReflection,
} from '../types/cslab'

const DEG = Math.PI / 180

/** 常见 X 射线波长（Å）。 */
export const CSLAB_XRAY_WAVELENGTHS: Record<'Cu-Kα' | 'Co-Kα' | 'Mo-Kα', number> = {
  'Cu-Kα': 1.5406,
  'Co-Kα': 1.78897,
  'Mo-Kα': 0.71073,
}

function stripNumber(raw: string): number | null {
  // CIF 常见写法：`4.5937(3)`、`90.`、`1.5406e0`、带引号
  const cleaned = raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\(\d+\)\s*$/, '')
    .replace(/[;,]+$/, '')
  const value = Number.parseFloat(cleaned)
  return Number.isFinite(value) ? value : null
}

/** 解析 CIF 头部的晶胞参数；缺失或非法返回 null（PDB 也返回 null）。 */
export function parseCifLattice(text: string): CsLabCrystalCell | null {
  if (!text) return null
  const fields = new Map<string, string>()

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(_[A-Za-z0-9_.\-]+)\s+(.+?)\s*$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    const key = match[1].toLowerCase()
    if (!fields.has(key)) fields.set(key, match[2])
  }

  const a = stripNumber(fields.get('_cell_length_a') ?? '')
  const b = stripNumber(fields.get('_cell_length_b') ?? '')
  const c = stripNumber(fields.get('_cell_length_c') ?? '')
  const alpha = stripNumber(fields.get('_cell_angle_alpha') ?? '')
  const beta = stripNumber(fields.get('_cell_angle_beta') ?? '')
  const gamma = stripNumber(fields.get('_cell_angle_gamma') ?? '')
  if (!a || !b || !c || !alpha || !beta || !gamma) return null
  if (a <= 0 || b <= 0 || c <= 0) return null

  const volume = cellVolume({ a, b, c, alpha, beta, gamma })
  if (!Number.isFinite(volume) || volume <= 0) return null

  const spaceGroup =
    fields.get("_symmetry_space_group_name_h-m") ??
    fields.get('_space_group_name_h-m_alt') ??
    fields.get('_symmetry_space_group_name_hall')

  return {
    a,
    b,
    c,
    alpha,
    beta,
    gamma,
    volume,
    spaceGroup: spaceGroup ? spaceGroup.replace(/^['"]|['"]$/g, '').trim() : undefined,
  }
}

/** 三斜晶胞体积（Å³）。 */
export function cellVolume(cell: {
  a: number
  b: number
  c: number
  alpha: number
  beta: number
  gamma: number
}): number {
  const { a, b, c, alpha, beta, gamma } = cell
  const ca = Math.cos(alpha * DEG)
  const cb = Math.cos(beta * DEG)
  const cg = Math.cos(gamma * DEG)
  const inside = 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg
  if (inside <= 0) return Number.NaN
  return a * b * c * Math.sqrt(inside)
}

/** 3x3 矩阵求逆（伴随矩阵 / 行列式）；奇异返回 null。 */
function invert3(m: number[][]): number[][] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

/** 晶面间距 d(hkl)（Å）；非法输入返回 NaN。 */
export function dSpacing(
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>,
  h: number,
  k: number,
  l: number,
): number {
  if (h === 0 && k === 0 && l === 0) return Number.NaN
  const { a, b, c, alpha, beta, gamma } = cell
  const ca = Math.cos(alpha * DEG)
  const cb = Math.cos(beta * DEG)
  const cg = Math.cos(gamma * DEG)

  // 实空间度规张量 G
  const metric = [
    [a * a, a * b * cg, a * c * cb],
    [a * b * cg, b * b, b * c * ca],
    [a * c * cb, b * c * ca, c * c],
  ]
  const inverse = invert3(metric)
  if (!inverse) return Number.NaN

  const q =
    h * (inverse[0]![0]! * h + inverse[0]![1]! * k + inverse[0]![2]! * l) +
    k * (inverse[1]![0]! * h + inverse[1]![1]! * k + inverse[1]![2]! * l) +
    l * (inverse[2]![0]! * h + inverse[2]![1]! * k + inverse[2]![2]! * l)
  if (!Number.isFinite(q) || q <= 0) return Number.NaN
  return 1 / Math.sqrt(q)
}

/** 由 d 与波长换算 2θ（度）；不可衍射返回 NaN。 */
export function twoThetaFromD(d: number, wavelengthAngstrom = CSLAB_XRAY_WAVELENGTHS['Cu-Kα']): number {
  if (!Number.isFinite(d) || d <= 0 || wavelengthAngstrom <= 0) return Number.NaN
  const ratio = wavelengthAngstrom / (2 * d)
  if (ratio > 1 || ratio < -1) return Number.NaN
  return (2 * Math.asin(ratio)) / DEG
}

/** 实空间基矢（a 沿 x 轴的标准取向）。 */
function realBasis(cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>) {
  const { a, b, c, alpha, beta, gamma } = cell
  const ca = Math.cos(alpha * DEG)
  const cb = Math.cos(beta * DEG)
  const cg = Math.cos(gamma * DEG)
  const sg = Math.sin(gamma * DEG)
  const volume = cellVolume({ a, b, c, alpha, beta, gamma })
  const ax = [a, 0, 0] as const
  const bx = [b * cg, b * sg, 0] as const
  const cx = c * cb
  const cy = c * ((ca - cb * cg) / (sg || 1))
  const cz = volume / (a * b * (sg || 1))
  const vectorC = [cx, cy, cz] as const
  return { ax, bx, vectorC, volume }
}

function cross(u: readonly number[], v: readonly number[]): [number, number, number] {
  return [
    u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!,
    u[0]! * v[1]! - u[1]! * v[0]!,
  ]
}

function normalize(v: readonly number[]): [number, number, number] {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!)
  if (!Number.isFinite(length) || length < 1e-12) return [0, 0, 0]
  return [v[0]! / length, v[1]! / length, v[2]! / length]
}

/** 倒易点阵法向量（已归一化）。 */
export function reciprocalNormal(
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>,
  h: number,
  k: number,
  l: number,
): [number, number, number] | null {
  const { ax, bx, vectorC, volume } = realBasis(cell)
  if (!Number.isFinite(volume) || Math.abs(volume) < 1e-12) return null
  const aStar = cross(bx, vectorC).map((value) => value / volume)
  const bStar = cross(vectorC, ax).map((value) => value / volume)
  const cStar = cross(ax, bx).map((value) => value / volume)
  const normal = normalize([
    h * aStar[0]! + k * bStar[0]! + l * cStar[0]!,
    h * aStar[1]! + k * bStar[1]! + l * cStar[1]!,
    h * aStar[2]! + k * bStar[2]! + l * cStar[2]!,
  ])
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null
  return normal
}

/** 晶胞几何中心（笛卡尔坐标，Å）。 */
export function cellCenter(
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>,
): [number, number, number] {
  const { ax, bx, vectorC } = realBasis(cell)
  return [
    (ax[0] + bx[0] + vectorC[0]) / 2,
    (ax[1] + bx[1] + vectorC[1]) / 2,
    (ax[2] + bx[2] + vectorC[2]) / 2,
  ]
}

/** 晶胞最长边（用于确定 Miller 平面切片尺寸）。 */
export function cellMaxLength(
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c'>,
): number {
  return Math.max(cell.a, cell.b, cell.c)
}

/** 平面内两正交基（用于在 Mol* 中自行构造 Miller 晶面网格）。 */
export function planeBasis(
  normal: readonly [number, number, number],
): { u: [number, number, number]; v: [number, number, number] } {
  const n = normalize(normal)
  const helper: [number, number, number] =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(n, helper))
  const v = normalize(cross(n, u))
  return { u, v }
}

export interface AssignReflectionsOptions {
  maxIndex?: number
  /** 2θ 容差（度）。 */
  toleranceDeg?: number
  wavelengthAngstrom?: number
}

function canonicalKey(h: number, k: number, l: number): string {
  // 把 (h,k,l) 与 (-h,-k,-l) 视为同一晶面族方向
  const sign = h > 0 || (h === 0 && (k > 0 || (k === 0 && l > 0))) ? 1 : -1
  return `${h * sign},${k * sign},${l * sign}`
}

/**
 * 根据给定 2θ 反查最接近的 (hkl)。
 * 返回按 |Δ2θ| 升序的候选；无匹配返回空数组（调用方必须如实提示）。
 */
export function assignReflections(
  twoTheta: number,
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>,
  options: AssignReflectionsOptions = {},
): CsLabXrdReflection[] {
  if (!Number.isFinite(twoTheta)) return []
  const maxIndex = Math.max(1, Math.min(12, Math.round(options.maxIndex ?? 6)))
  const tolerance = Math.max(0.01, options.toleranceDeg ?? 0.35)
  const wavelength = options.wavelengthAngstrom ?? CSLAB_XRAY_WAVELENGTHS['Cu-Kα']

  const results: CsLabXrdReflection[] = []
  const seen = new Set<string>()

  for (let h = 0; h <= maxIndex; h += 1) {
    for (let k = -maxIndex; k <= maxIndex; k += 1) {
      for (let l = -maxIndex; l <= maxIndex; l += 1) {
        if (h === 0 && k === 0 && l === 0) continue
        if (h === 0 && k < 0) continue
        const key = canonicalKey(h, k, l)
        if (seen.has(key)) continue
        const d = dSpacing(cell, h, k, l)
        if (!Number.isFinite(d) || d <= 0) continue
        const theta = twoThetaFromD(d, wavelength)
        if (!Number.isFinite(theta)) continue
        const delta = Math.abs(theta - twoTheta)
        if (delta > tolerance) continue
        seen.add(key)
        results.push({ h, k, l, d, twoTheta: theta, delta })
      }
    }
  }

  // 误差相同时优先全非负指数，避免把 (110) 显示成 (1-10)。
  const negativeCount = (item: CsLabXrdReflection): number =>
    [item.h, item.k, item.l].filter((value) => value < 0).length
  return results.sort(
    (left, right) =>
      left.delta - right.delta ||
      negativeCount(left) - negativeCount(right) ||
      right.d - left.d,
  )
}

/** 把 (hkl) 组装成可直接交给 Mol* 的 Miller 平面参数。 */
export function buildMillerPlane(
  cell: Pick<CsLabCrystalCell, 'a' | 'b' | 'c' | 'alpha' | 'beta' | 'gamma'>,
  h: number,
  k: number,
  l: number,
  wavelengthAngstrom?: number,
): CsLabMillerPlane | null {
  const normal = reciprocalNormal(cell, h, k, l)
  const d = dSpacing(cell, h, k, l)
  if (!normal || !Number.isFinite(d)) return null
  const twoTheta = twoThetaFromD(d, wavelengthAngstrom)
  return {
    h,
    k,
    l,
    d,
    normal,
    twoTheta: Number.isFinite(twoTheta) ? twoTheta : undefined,
  }
}
