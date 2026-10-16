/**
 * 双平面平行坐标锚定引擎单元测试
 *
 * 覆盖：单应性矩阵最小二乘求解精度（BDD-VISION-01 要求 Δ < 2px）、
 * 视觉归一化坐标 → DOM DIP 映射、无地标时的纯缩放回退、快照缓存读写、页内磁吸脚本可编译。
 */

import { describe, expect, test } from 'bun:test'
import {
  applyHomography,
  buildVisualSnapshot,
  getVisualSnapshot,
  releaseVisualSnapshot,
  selectSpreadLandmarks,
  setVisualSnapshot,
  solveHomography,
  visualToDip,
  visualToPixel,
  buildVisualSnapScript,
  type VisualLandmark,
} from './yanhu-visual-anchor'

describe('solveHomography（单应性最小二乘求解）', () => {
  test('由真实单应性生成的对应点可被精确还原（误差 Δ < 2px）', () => {
    const H_TRUE = [1.2, 0.1, 5, 0.05, 1.1, -3, 0.0002, 0.0001, 1]
    const srcs: Array<readonly [number, number]> = [
      [0, 0],
      [1000, 0],
      [0, 1000],
      [1000, 1000],
      [500, 250],
      [250, 750],
      [700, 600],
    ]
    const dsts = srcs.map(([u, v]) => {
      const p = applyHomography(H_TRUE, u, v)!
      return [p.x, p.y] as const
    })

    const H = solveHomography(srcs, dsts)
    expect(H).not.toBeNull()

    const check = applyHomography(H!, 620, 430)!
    const truth = applyHomography(H_TRUE, 620, 430)!
    expect(Math.abs(check.x - truth.x)).toBeLessThan(2)
    expect(Math.abs(check.y - truth.y)).toBeLessThan(2)
  })

  test('地标不足 4 个时返回 null（退回纯缩放映射）', () => {
    expect(solveHomography([[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 0], [0, 1]])).toBeNull()
  })
})

describe('visualToDip（视觉归一化坐标 → DOM DIP）', () => {
  const makeLandmark = (u: number, v: number, x: number, y: number): VisualLandmark => ({ u, v, x, y })

  test('有地标标定时映射误差在可接受范围（含取整）', () => {
    const dipWidth = 1000
    const dipHeight = 800
    // 由真实几何生成地标（u,v 为 x,y 的线性归一化），求解后应能高精度回映
    const landmarks: VisualLandmark[] = [
      makeLandmark(50, 62, 50, 50),
      makeLandmark(950, 62, 950, 50),
      makeLandmark(50, 937, 50, 750),
      makeLandmark(950, 937, 950, 750),
      makeLandmark(500, 500, 500, 400),
    ]
    const snapshot = buildVisualSnapshot({ dipWidth, dipHeight, pixelWidth: 1000, pixelHeight: 800, landmarks })
    expect(snapshot.homography).not.toBeNull()
    const mapped = visualToDip(snapshot, 500, 500)
    expect(Math.abs(mapped.x - 500)).toBeLessThanOrEqual(3)
    expect(Math.abs(mapped.y - 400)).toBeLessThanOrEqual(3)
  })

  test('无地标时退回纯缩放映射', () => {
    const snapshot = buildVisualSnapshot({ dipWidth: 1000, dipHeight: 800, pixelWidth: 2000, pixelHeight: 1600, landmarks: [] })
    expect(snapshot.homography).toBeNull()
    expect(visualToDip(snapshot, 500, 500)).toEqual({ x: 500, y: 400 })
    expect(visualToDip(snapshot, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(visualToDip(snapshot, 1000, 1000)).toEqual({ x: 1000, y: 800 })
    // 越界坐标被收敛进视口
    expect(visualToDip(snapshot, -50, 2000)).toEqual({ x: 0, y: 800 })
  })

  test('visualToPixel 依据物理像素尺寸换算（供模型对照）', () => {
    const snapshot = buildVisualSnapshot({ dipWidth: 500, dipHeight: 400, pixelWidth: 1000, pixelHeight: 800, landmarks: [] })
    expect(visualToPixel(snapshot, 500, 500)).toEqual({ x: 500, y: 400 })
  })
})

describe('selectSpreadLandmarks（地标离散挑选）', () => {
  test('候选不超过上限时原样返回，超过时裁剪至上限', () => {
    const few: VisualLandmark[] = Array.from({ length: 3 }, (_, i) => ({ u: i, v: i, x: i, y: i }))
    expect(selectSpreadLandmarks(few, 8)).toHaveLength(3)
    const many: VisualLandmark[] = Array.from({ length: 20 }, (_, i) => ({ u: i, v: i, x: i, y: i * 10 }))
    const picked = selectSpreadLandmarks(many, 8)
    expect(picked).toHaveLength(8)
  })
})

describe('标定快照缓存（按标签）', () => {
  test('写入 / 读取 / 释放', () => {
    const snapshot = buildVisualSnapshot({ dipWidth: 100, dipHeight: 100, pixelWidth: 100, pixelHeight: 100, landmarks: [] })
    setVisualSnapshot('tab-x', snapshot)
    expect(getVisualSnapshot('tab-x')).toBe(snapshot)
    releaseVisualSnapshot('tab-x')
    expect(getVisualSnapshot('tab-x')).toBeNull()
  })
})

describe('buildVisualSnapScript（页内 DOM 磁吸脚本）', () => {
  test('脚本可被 JS 引擎解析且内联坐标/半径正确', () => {
    const script = buildVisualSnapScript(120, 340, 12)
    expect(() => new Function('document', script)).not.toThrow()
    expect(script).toContain('const cx = 120')
    expect(script).toContain('const cy = 340')
    expect(script).toContain('const R = 12')
    expect(script).toContain('elementFromPoint')
  })

  /** 构造最小 DOM 桩：elementFromPoint 恒返回同一个命中元素 */
  function runSnap(hit: Record<string, unknown>, x: number, y: number, radius = 12) {
    const script = buildVisualSnapScript(x, y, radius)
    const runner = new Function('document', `return ${script}`)
    return runner({ elementFromPoint: () => hit }) as {
      ok: boolean
      x: number
      y: number
      snapped: boolean
      hit: { tag: string; name: string } | null
    }
  }

  test('Given 命中一个小尺度控件 When 磁吸 Then 吸附到其几何中心', () => {
    const span = {
      nodeType: 1,
      tagName: 'SPAN',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 90, top: 92, width: 30, height: 16 }),
      innerText: '因私请假',
      parentElement: null,
    }
    const result = runSnap(span, 100, 100)
    expect(result.snapped).toBe(true)
    expect(result.x).toBe(105)
    expect(result.y).toBe(100)
    expect(result.hit?.name).toBe('因私请假')
  })

  test('Given 命中面板级大容器 When 磁吸 Then 放弃吸附、按原始坐标落地（绝不把点击拖到容器中心）', () => {
    const hugeDiv = {
      nodeType: 1,
      tagName: 'DIV',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }),
      innerText: '请假信息',
      parentElement: null,
    }
    const result = runSnap(hugeDiv, 320, 274)
    expect(result.snapped).toBe(false)
    expect(result.x).toBe(320)
    expect(result.y).toBe(274)
  })

  test('Given 命中文本节点而其祖先是大容器 When 磁吸 Then 不因上溯而吸附到容器中心', () => {
    const hugeDiv = {
      nodeType: 1,
      tagName: 'DIV',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }),
      innerText: '请假信息',
      parentElement: null,
    }
    // 命中的小文本节点：自身在控件尺度内，允许吸附到它自己的中心
    const smallText = {
      nodeType: 1,
      tagName: 'SPAN',
      getAttribute: () => '',
      getBoundingClientRect: () => ({ left: 315, top: 270, width: 40, height: 18 }),
      innerText: '因私请假',
      parentElement: hugeDiv,
    }
    const result = runSnap(smallText, 320, 274)
    expect(result.snapped).toBe(true)
    // 吸附目标是文本节点自身的中心（335, 279），而不是 1200×600 容器的中心（600, 300）
    expect(result.x).toBe(335)
    expect(result.y).toBe(279)
  })
})
