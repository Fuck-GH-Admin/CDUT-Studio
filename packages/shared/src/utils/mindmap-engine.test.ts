/**
 * BDD 行为驱动测试：思维导图核心引擎（贝塞尔连线平滑性 + 视口锚定缩放矩阵）
 */

import { describe, expect, it } from 'bun:test'
import type { MindMapNode } from '../types/study'
import { buildBezierPath, computeAnchorZoomPan, estimateMindMapNodeSize, layoutMindMap } from './mindmap-engine'

/** 从 SVG path 中提取三次贝塞尔的控制点 C1(x1,y1) C2(x2,y2) 与终点 (x,y) */
function parseBezier(path: string): { c1: [number, number]; c2: [number, number]; end: [number, number] } {
  const m = path.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)\s+C\s+(-?[\d.]+)\s+(-?[\d.]+),\s*(-?[\d.]+)\s+(-?[\d.]+),\s*(-?[\d.]+)\s+(-?[\d.]+)$/)
  if (!m) throw new Error(`无法解析贝塞尔路径: ${path}`)
  return {
    c1: [Number(m[3]), Number(m[4])],
    c2: [Number(m[5]), Number(m[6])],
    end: [Number(m[7]), Number(m[8])],
  }
}

describe('buildBezierPath（径向贝塞尔连线平滑性 BDD-MINDMAP-01）', () => {
  const center = { x: 0, y: 0 }
  const pt = (x: number, y: number) => ({ x, y, depth: 1, angle: 0 })

  it('Given 根节点位于圆心 When 子节点在负方向（左侧） Then 控制点切向平滑向左，绝无向右平移的怪异环绕', () => {
    // 回归背景：旧实现 atan2(0,0)=0 极角退化使根节点连线控制点强制向右（+x）平移
    const path = buildBezierPath(pt(0, 0), pt(-200, 0), center)
    const { c1, c2 } = parseBezier(path)
    // 起点在圆心 → C1 必须沿「起点→终点」方向（向左），横坐标严格小于 0
    expect(c1[0]).toBeLessThan(0)
    // C2 位于 C1 与终点之间（向左延伸，绝不回绕到中心右侧）
    expect(c2[0]).toBeLessThan(c1[0])
    expect(c2[0]).toBeGreaterThan(-200)
  })

  it('Given 根节点位于圆心 When 子节点在正上方 Then 控制点不发生水平方向右偏移', () => {
    const path = buildBezierPath(pt(0, 0), pt(0, -180), center)
    const { c1, c2 } = parseBezier(path)
    expect(c1[0]).toBe(0)
    expect(c2[0]).toBe(0)
    expect(c1[1]).toBeLessThan(0)
  })

  it('Given 起终点均偏离圆心 When 生成径向弧线 Then 控制点沿各自极径向外放射且曲线互不回绕', () => {
    // 从右上（135° 方向）到右下（45° 方向）的分支连线
    const path = buildBezierPath(pt(100, -100), pt(200, 100), center)
    const { c1, c2 } = parseBezier(path)
    // C1 沿起点极径向外：半径应大于起点半径
    const r0 = Math.hypot(100, -100)
    const rC1 = Math.hypot(c1[0], c1[1])
    expect(rC1).toBeGreaterThan(r0)
    // C2 位于终点极径内侧（向起点方向收回）
    const r1 = Math.hypot(200, 100)
    const rC2 = Math.hypot(c2[0], c2[1])
    expect(rC2).toBeGreaterThan(0)
    expect(rC2).toBeLessThan(r1)
  })

  it('Given 未提供中心 When 生成经典水平 S 曲线 Then 控制点分别锚定起终点纵坐标', () => {
    const path = buildBezierPath(pt(0, 0), pt(300, -80))
    const { c1, c2 } = parseBezier(path)
    expect(c1[1]).toBe(0)
    expect(c2[1]).toBe(-80)
    expect(c1[0]).toBeGreaterThan(0)
    expect(c2[0]).toBeLessThan(300)
  })

  it('Given 起终点重合 When 生成路径 Then 退化为直线且不产生 NaN', () => {
    const path = buildBezierPath(pt(50, 50), pt(50, 50), center)
    expect(path).toContain('L 50 50')
    expect(path).not.toContain('NaN')
  })

  it('Given 双曲布局 When 展开完整导图 Then 任意层级连线路径均无 NaN 且根节点首环呈放射状', () => {
    const root: MindMapNode = {
      id: 'root',
      label: '根',
      children: [
        { id: 'a', label: 'A', children: [{ id: 'a1', label: 'A1' }, { id: 'a2', label: 'A2' }] },
        { id: 'b', label: 'B', children: [{ id: 'b1', label: 'B1' }] },
      ],
    }
    const positions = layoutMindMap(root, { centerX: 0, centerY: 0 })
    const centerPt = positions.get('root')!
    expect(centerPt.x).toBe(0)
    expect(centerPt.y).toBe(0)
    for (const [id, point] of positions) {
      if (id === 'root') continue
      const path = buildBezierPath({ ...centerPt, depth: 0, angle: 0 }, { ...point, depth: 1, angle: 0 }, { x: 0, y: 0 })
      expect(path).not.toContain('NaN')
    }
  })
})

describe('estimateMindMapNodeSize（气泡尺寸估算 BDD-MINDMAP-SIZE-01）', () => {
  it('Given 任意文案 When 估算 Then 宽度被夹取在 [84, 160] 且高度至少容纳一行', () => {
    for (const label of ['', 'A', '短', '中等长度的节点标签', '这是一个非常非常长的思维导图节点标签用于触发换行']) {
      const size = estimateMindMapNodeSize(label)
      expect(size.width).toBeGreaterThanOrEqual(84)
      expect(size.width).toBeLessThanOrEqual(160)
      expect(size.height).toBeGreaterThanOrEqual(30)
    }
  })

  it('Given 超长文案 When 估算 Then 触发换行使高度增加（不再固定 42px 的单行高度）', () => {
    const short = estimateMindMapNodeSize('短标签')
    const long = estimateMindMapNodeSize('这是一段足够长的思维导图节点文案用于强制换行显示')
    expect(long.height).toBeGreaterThan(short.height)
  })
})

describe('layoutMindMap 线性自适应环距（BDD-MINDMAP-LAYOUT-01）', () => {
  /** 宽标签 + 多分支的压力用例：旧双曲压缩下第一层必然重叠 */
  const busyRoot: MindMapNode = {
    id: 'root',
    label: '工程管理专业核心知识体系',
    children: Array.from({ length: 8 }, (_, i) => ({
      id: `b${i}`,
      label: `核心考点分支${i}`,
      children: [
        { id: `b${i}-1`, label: `子概念${i}A 的详细说明文字` },
        { id: `b${i}-2`, label: `子概念${i}B 的详细说明文字` },
      ],
    })),
  }

  it('Given 8 个宽标签分支 When 布局 Then 环半径随层级严格单调递增（杜绝深层径向贴合）', () => {
    const positions = layoutMindMap(busyRoot, { centerX: 0, centerY: 0, baseRadius: 150, diskRadius: 100000 })
    const radiusOf = (id: string): number => {
      const p = positions.get(id)!
      return Math.hypot(p.x, p.y)
    }
    expect(radiusOf('b0')).toBeGreaterThan(0)
    // 同一分支链上：父 < 子，且差值足以容纳两级气泡
    for (let i = 0; i < 8; i++) {
      const parent = radiusOf(`b${i}`)
      const child = radiusOf(`b${i}-1`)
      expect(child).toBeGreaterThan(parent)
      expect(child - parent).toBeGreaterThan(100)
    }
  })

  it('Given 同环多节点 When 布局 Then 相邻节点不重叠（同环弧长足以排布气泡宽度）', () => {
    const positions = layoutMindMap(busyRoot, { centerX: 0, centerY: 0, baseRadius: 150, diskRadius: 100000 })
    const depth1 = Array.from({ length: 8 }, (_, i) => positions.get(`b${i}`)!)
    const radius = Math.hypot(depth1[0]!.x, depth1[0]!.y)
    const halfWidth = estimateMindMapNodeSize('核心考点分支0').width / 2
    // 同环相邻节点的弦长必须大于气泡宽度（否则视觉上必然压叠）
    const angularStep = (Math.PI * 2) / depth1.length
    const chord = 2 * radius * Math.sin(angularStep / 2)
    expect(chord).toBeGreaterThan(halfWidth * 2)
  })

  it('Given 圆盘上限 When 布局 Then 所有节点半径不超过该上限', () => {
    const limit = 400
    const positions = layoutMindMap(busyRoot, { centerX: 0, centerY: 0, baseRadius: 150, diskRadius: limit })
    for (const p of positions.values()) {
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(limit + 1)
    }
  })

  it('Given 深链单支 When 布局 Then 节点坐标互不重合且覆盖全部节点', () => {
    const positions = layoutMindMap(busyRoot, { centerX: 0, centerY: 0 })
    expect(positions.size).toBe(1 + 8 * 3)
    const unique = new Set([...positions.values()].map((p) => `${p.x},${p.y}`))
    expect(unique.size).toBe(positions.size)
  })
})

describe('computeAnchorZoomPan（光标锚定缩放矩阵 BDD-MINDMAP-02）', () => {
  it('Given 任意缩放因子与坐标 When 执行锚定缩放 Then 锚点对应的场景点缩放前后投影到同一屏幕位置', () => {
    const cases: Array<{
      prev: { zoom: number; pan: { x: number; y: number } }
      anchor: { x: number; y: number }
      nextZoom: number
    }> = [
      { prev: { zoom: 1, pan: { x: 0, y: 0 } }, anchor: { x: 400, y: 300 }, nextZoom: 2 },
      { prev: { zoom: 0.37, pan: { x: -122.5, y: 88.25 } }, anchor: { x: 512, y: 311 }, nextZoom: 1.63 },
      { prev: { zoom: 2.5, pan: { x: 999, y: -333 } }, anchor: { x: 0, y: 0 }, nextZoom: 0.2 },
    ]
    for (const { prev, anchor, nextZoom } of cases) {
      const next = computeAnchorZoomPan(prev, anchor, nextZoom)
      // 场景点（缩放前）：scene = (anchor - pan) / zoom
      const sceneX = (anchor.x - prev.pan.x) / prev.zoom
      const sceneY = (anchor.y - prev.pan.y) / prev.zoom
      // 缩放后同一场景点的投影 = pan' + scene * zoom'
      const projectedX = next.pan.x + sceneX * next.zoom
      const projectedY = next.pan.y + sceneY * next.zoom
      expect(Math.abs(projectedX - anchor.x)).toBeLessThan(1e-9)
      expect(Math.abs(projectedY - anchor.y)).toBeLessThan(1e-9)
    }
  })

  it('Given 连续两次相反缩放 When 先放大后还原 Then 矩阵可逆且回到初始 pan', () => {
    const initial = { zoom: 1, pan: { x: 40, y: -60 } }
    const anchor = { x: 300, y: 200 }
    const zoomedIn = computeAnchorZoomPan(initial, anchor, 1.5)
    const restored = computeAnchorZoomPan(zoomedIn, anchor, 1)
    expect(restored.zoom).toBeCloseTo(initial.zoom, 12)
    expect(restored.pan.x).toBeCloseTo(initial.pan.x, 12)
    expect(restored.pan.y).toBeCloseTo(initial.pan.y, 12)
  })

  it('Given 非法缩放值 When 执行锚定缩放 Then 原样返回且不产生 NaN 污染', () => {
    const prev = { zoom: 1, pan: { x: 10, y: 10 } }
    expect(computeAnchorZoomPan(prev, { x: 0, y: 0 }, Number.NaN)).toEqual(prev)
    expect(computeAnchorZoomPan(prev, { x: 0, y: 0 }, 0)).toEqual(prev)
    expect(computeAnchorZoomPan({ ...prev, zoom: 0 }, { x: 0, y: 0 }, 2)).toEqual({ zoom: 0, pan: { x: 10, y: 10 } })
  })
})
