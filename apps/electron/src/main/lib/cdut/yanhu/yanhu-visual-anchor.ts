/**
 * 智联万站 · 双平面平行坐标锚定引擎（Dual-Plane Parallel Coordinate Anchoring）
 *
 * 视觉截图辅助感知（Screenshot Recognition）把「视觉图像平面」（多模态大模型看到的像素 /
 * 归一化坐标 [u, v] ∈ [0, 1000]²）与「真实 DOM 物理平面」（网页 DIP 逻辑坐标）建立映射：
 *
 *   1. 截屏瞬间从 DOM 蒸馏结果中选取 4~8 个空间分布最离散的可见叶子控件作为地标基准点
 *      （Landmark Grounding），构成向量对集合 {(p_vis^k, p_dom^k)}；
 *   2. 以最小二乘求解单应性透视投影矩阵 H₃ₓ₃，消除高分屏局部形变；
 *   3. 模型给出的视觉归一化坐标经 (X_dip, Y_dip) = H · (u, v) 映射回 DOM DIP 坐标，
 *      再由调用方在页内以 `elementFromPoint` 做半径 ε 的 DOM 磁吸对齐后精确落地。
 *
 * 本模块为**纯函数**实现（除按标签缓存快照的模块级 Map 外），可在单测中直接消费。
 */

/** 地标基准点：视觉归一化坐标 [u,v] ∈ [0,1000]² 与 DOM DIP 坐标的一一对应 */
export interface VisualLandmark {
  /** 视觉平面归一化坐标（0~1000） */
  u: number
  v: number
  /** DOM 物理平面 DIP 坐标（视口左上为原点） */
  x: number
  y: number
  /** 语义标签（可读，供模型对照） */
  label?: string
}

/** 单应性矩阵：长度 9，行优先（row-major）：[h0..h7, h8=1] */
export type Homography = readonly number[]

/** 截屏标定快照（按标签缓存，供视觉点击映射复用） */
export interface VisualAnchorSnapshot {
  /** 视口 DIP 尺寸 */
  dipWidth: number
  dipHeight: number
  /** 截屏物理像素尺寸 */
  pixelWidth: number
  pixelHeight: number
  /** 地标集合（视觉归一化坐标 ↔ DOM DIP） */
  landmarks: VisualLandmark[]
  /** 由地标求解的单应性矩阵（地标不足 4 个时为 null，退回纯缩放映射） */
  homography: Homography | null
  timestamp: number
}

/** 视觉归一化坐标的取值范围上界（模型输出 0~1000 的整数） */
export const VISUAL_COORD_MAX = 1000
/** DOM 磁吸半径（DIP） */
export const VISUAL_SNAP_RADIUS_PX = 12
/** 地标数量上限（4~8 个） */
export const MAX_VISUAL_LANDMARKS = 8

/**
 * 高斯消元（带部分主元）求解线性方程组 A·x = b。
 * 奇异 / 病态（主元近零）时返回 null，调用方据此退回纯缩放映射。
 */
export function solveLinearSystem(matrix: readonly number[][], rhs: readonly number[]): number[] | null {
  const n = rhs.length
  if (n === 0 || matrix.length !== n) return null
  // 构造增广矩阵（深拷贝，绝不污染入参）
  const aug: number[][] = matrix.map((row, i) => {
    const copy = new Array<number>(n + 1)
    for (let j = 0; j < n; j++) copy[j] = row[j] ?? 0
    copy[n] = rhs[i] ?? 0
    return copy
  })

  for (let col = 0; col < n; col++) {
    let pivot = col
    let best = Math.abs(aug[col]![col]!)
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(aug[r]![col]!)
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < 1e-12) return null
    if (pivot !== col) {
      const tmp = aug[col]!
      aug[col] = aug[pivot]!
      aug[pivot] = tmp
    }
    const pv = aug[col]![col]!
    for (let c = col; c <= n; c++) aug[col]![c] = aug[col]![c]! / pv
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = aug[r]![col]!
      if (factor === 0) continue
      for (let c = col; c <= n; c++) aug[r]![c] = aug[r]![c]! - factor * aug[col]![c]!
    }
  }
  return aug.map((row) => row[n]!)
}

/**
 * 由地标对应点求解单应性变换矩阵 H（h8 归一化为 1）。
 *
 * 采用超定方程组的最小二乘正规方程 (AᵀA)h = Aᵀb 求解 8 个未知量（h0..h7）。
 * 地标 < 4 个或方程病态时返回 null（退回纯缩放映射）。
 */
export function solveHomography(
  src: readonly (readonly [number, number])[],
  dst: readonly (readonly [number, number])[],
): Homography | null {
  const n = Math.min(src.length, dst.length)
  if (n < 4) return null
  const rows: number[][] = []
  const rhs: number[] = []
  for (let i = 0; i < n; i++) {
    const u = src[i]![0]
    const v = src[i]![1]
    const x = dst[i]![0]
    const y = dst[i]![1]
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x])
    rhs.push(x)
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y])
    rhs.push(y)
  }
  const m = rows.length
  const ata: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0))
  const atb = new Array<number>(8).fill(0)
  for (let r = 0; r < m; r++) {
    const row = rows[r]!
    const b = rhs[r]!
    for (let i = 0; i < 8; i++) {
      atb[i] = (atb[i] ?? 0) + row[i]! * b
      for (let j = 0; j < 8; j++) ata[i]![j] = (ata[i]![j] ?? 0) + row[i]! * row[j]!
    }
  }
  const h = solveLinearSystem(ata, atb)
  if (!h) return null
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1]
}

/** 应用单应性变换：视觉归一化坐标 (u,v) → DOM DIP 坐标 (x,y) */
export function applyHomography(h: Homography, u: number, v: number): { x: number; y: number } | null {
  const denom = h[6]! * u + h[7]! * v + h[8]!
  if (Math.abs(denom) < 1e-9) return null
  return {
    x: (h[0]! * u + h[1]! * v + h[2]!) / denom,
    y: (h[3]! * u + h[4]! * v + h[5]!) / denom,
  }
}

/** 从候选点中按索引步长均匀挑出最多 max 个空间分布离散的地标 */
export function selectSpreadLandmarks(candidates: readonly VisualLandmark[], max = MAX_VISUAL_LANDMARKS): VisualLandmark[] {
  if (candidates.length <= max) return candidates.slice()
  const sorted = candidates.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const picked: VisualLandmark[] = []
  const step = sorted.length / max
  for (let i = 0; i < max; i++) {
    const item = sorted[Math.min(sorted.length - 1, Math.floor(i * step))]
    if (item) picked.push(item)
  }
  return picked
}

/** 由地标集合构建标定快照（求解单应性矩阵；地标不足则 homography=null） */
export function buildVisualSnapshot(input: {
  dipWidth: number
  dipHeight: number
  pixelWidth: number
  pixelHeight: number
  landmarks: readonly VisualLandmark[]
  timestamp?: number
}): VisualAnchorSnapshot {
  const landmarks = selectSpreadLandmarks(input.landmarks)
  const src = landmarks.map((l) => [l.u, l.v] as const)
  const dst = landmarks.map((l) => [l.x, l.y] as const)
  const homography = solveHomography(src, dst)
  return {
    dipWidth: Math.max(1, Math.round(input.dipWidth)),
    dipHeight: Math.max(1, Math.round(input.dipHeight)),
    pixelWidth: Math.max(1, Math.round(input.pixelWidth)),
    pixelHeight: Math.max(1, Math.round(input.pixelHeight)),
    landmarks,
    homography,
    timestamp: input.timestamp ?? Date.now(),
  }
}

/** 将坐标收敛进视口范围（避免越界点击落到视口外） */
function clampToViewport(point: { x: number; y: number }, snapshot: VisualAnchorSnapshot): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(snapshot.dipWidth, Math.round(point.x))),
    y: Math.max(0, Math.min(snapshot.dipHeight, Math.round(point.y))),
  }
}

/**
 * 视觉归一化坐标 (u,v) ∈ [0,1000]² → DOM DIP 坐标。
 *
 * 有单应性矩阵时优先透视映射；无（地标不足）时退回纯线性缩放，保证始终有可用坐标。
 */
export function visualToDip(
  snapshot: VisualAnchorSnapshot,
  u: number,
  v: number,
): { x: number; y: number } {
  if (snapshot.homography) {
    const mapped = applyHomography(snapshot.homography, u, v)
    if (mapped && Number.isFinite(mapped.x) && Number.isFinite(mapped.y)) {
      return clampToViewport(mapped, snapshot)
    }
  }
  return clampToViewport(
    { x: (u / VISUAL_COORD_MAX) * snapshot.dipWidth, y: (v / VISUAL_COORD_MAX) * snapshot.dipHeight },
    snapshot,
  )
}

/** 视觉归一化坐标反向映射为像素坐标（供模型以像素对照，非点击用） */
export function visualToPixel(
  snapshot: VisualAnchorSnapshot,
  u: number,
  v: number,
): { x: number; y: number } {
  return {
    x: Math.round((u / VISUAL_COORD_MAX) * snapshot.pixelWidth),
    y: Math.round((v / VISUAL_COORD_MAX) * snapshot.pixelHeight),
  }
}

// ===== 按标签缓存标定快照（供视觉点击复用同一次截屏的地标） =====

const snapshots = new Map<string, VisualAnchorSnapshot>()

/** 写入某标签的标定快照 */
export function setVisualSnapshot(tabId: string, snapshot: VisualAnchorSnapshot): void {
  snapshots.set(tabId, snapshot)
}

/** 读取某标签最近的标定快照（未截屏过返回 null） */
export function getVisualSnapshot(tabId: string): VisualAnchorSnapshot | null {
  return snapshots.get(tabId) ?? null
}

/** 释放某标签的标定快照 */
export function releaseVisualSnapshot(tabId: string): void {
  snapshots.delete(tabId)
}

/**
 * 生成页内 DOM 磁吸对齐脚本。
 *
 * 映射到逻辑坐标后，在半径 ε 窗口内自上而下探测命中元素；若命中**控件尺度**的可交互控件
 * （含 cursor:pointer 软交互 / 图标子节点），吸附到其几何中心再落地，保证点击 100% 幂等精确。
 *
 * 关键约束（历史缺陷）：祖先上溯必须设「控件尺度」上限。此前不设限，一旦坐标落在普通文本上，
 * 上溯会一路爬到面板 / 表单级大容器并吸附到它的中心——点击被拖走数百像素，既点不中目标，
 * 又让模型看到与标定表完全对不上的 DIP 坐标（表现为「磁吸后反而越点越偏」）。
 * 找不到控件尺度的目标时，宁可**不吸附**、按模型给出的原始坐标落地。
 */
export function buildVisualSnapScript(x: number, y: number, radius = VISUAL_SNAP_RADIUS_PX): string {
  return `(() => {
    const cx = ${Math.round(x)};
    const cy = ${Math.round(y)};
    const R = ${Math.round(radius)};
    // 控件尺度上限：超过即视为面板 / 容器，绝不吸附
    const MAX_W = 480, MAX_H = 140;
    const inControlScale = (el) => {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (!r || r.width <= 0 || r.height <= 0) return false;
      return r.width <= MAX_W && r.height <= MAX_H;
    };
    const isInteractive = (el) => {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (['button','a','input','select','textarea','summary','option','label'].indexOf(tag) >= 0) return true;
      const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
      if (['button','link','tab','menuitem','checkbox','radio','switch','textbox','combobox'].indexOf(role) >= 0) return true;
      try {
        const st = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : null;
        if (st && st.cursor === 'pointer') return true;
      } catch (e) {}
      return false;
    };
    const probe = (px, py) => {
      let hit = null;
      try { hit = document.elementFromPoint(px, py); } catch (e) { hit = null; }
      if (!hit) return null;
      let node = hit, guard = 0;
      while (node && guard < 8) {
        if (isInteractive(node) && inControlScale(node)) return node;
        node = node.parentElement;
        guard += 1;
      }
      // 未上溯到控件尺度的可交互目标：仅当命中元素本身足够小时才吸附它，否则放弃吸附
      return inControlScale(hit) ? hit : null;
    };
    let target = probe(cx, cy);
    // 半径 ε 内沿十字方向补漏探测（应对图标/内边距导致中心点落空）
    if (!target) {
      const dirs = [[R,0],[-R,0],[0,R],[0,-R]];
      for (let i = 0; i < dirs.length && !target; i++) target = probe(cx + dirs[i][0], cy + dirs[i][1]);
    }
    if (!target) return { ok: true, x: cx, y: cy, snapped: false, hit: null };
    let rect = { left: cx, top: cy, width: 0, height: 0 };
    try { rect = target.getBoundingClientRect(); } catch (e) {}
    const sx = Math.round(rect.left + rect.width / 2);
    const sy = Math.round(rect.top + rect.height / 2);
    const tag = (target.tagName || '').toLowerCase();
    const name = (target.innerText || target.textContent || target.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    return { ok: true, x: sx, y: sy, snapped: true, hit: { tag: tag, name: name } };
  })()`
}
