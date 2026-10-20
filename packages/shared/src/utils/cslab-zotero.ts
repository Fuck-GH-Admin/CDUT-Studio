/**
 * Zotero 批注坐标纯函数（主进程与渲染进程共用）
 *
 * 仅包含无 Node 依赖的数学与 JSON 解析；附件路径解析留在主进程。
 * 旋转方向与 PDF.js PageViewport 一致：
 *   0°   : (x, H - y)
 *   90°  : (y, x)
 *   180° : (W - x, y)
 *   270° : (H - y, W - x)
 */

export type ZoteroRect = [number, number, number, number]
export type ZoteroRotation = 0 | 90 | 180 | 270

export interface ZoteroAnnotationPosition {
  pageIndex: number
  rects: ZoteroRect[]
  rotation: ZoteroRotation
  inkPaths?: string[]
}

export interface ZoteroViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export function normalizeRotation(value: unknown): ZoteroRotation {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  const normalized = ((Math.round(numeric / 90) * 90) % 360 + 360) % 360
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized
  return 0
}

export function parseZoteroAnnotationPosition(raw: unknown): ZoteroAnnotationPosition | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }

  const pageIndexRaw = Number(parsed.pageIndex)
  const pageIndex = Number.isFinite(pageIndexRaw) && pageIndexRaw >= 0 ? Math.floor(pageIndexRaw) : 0

  const rects: ZoteroRect[] = []
  if (Array.isArray(parsed.rects)) {
    for (const item of parsed.rects) {
      if (!Array.isArray(item) || item.length < 4) continue
      const values = item.slice(0, 4).map((value) => Number(value))
      if (values.some((value) => !Number.isFinite(value))) continue
      rects.push([values[0]!, values[1]!, values[2]!, values[3]!])
    }
  }

  const inkPaths: string[] = []
  if (Array.isArray(parsed.ink)) {
    for (const path of parsed.ink) {
      if (typeof path === 'string' && path.trim()) inkPaths.push(path)
    }
  }

  return {
    pageIndex,
    rects,
    rotation: normalizeRotation(parsed.rotation),
    inkPaths: inkPaths.length > 0 ? inkPaths : undefined,
  }
}

export function zoteroRectToViewport(
  rect: ZoteroRect,
  page: { width: number; height: number },
  scale: number,
  rotation: number,
): ZoteroViewportRect {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const width = Number.isFinite(page.width) && page.width > 0 ? page.width : 1
  const height = Number.isFinite(page.height) && page.height > 0 ? page.height : 1

  const x1 = Math.min(rect[0], rect[2])
  const x2 = Math.max(rect[0], rect[2])
  const y1 = Math.min(rect[1], rect[3])
  const y2 = Math.max(rect[1], rect[3])

  const normalized = normalizeRotation(rotation)

  if (normalized === 90) {
    return {
      left: y1 * safeScale,
      top: x1 * safeScale,
      width: Math.max(0, y2 - y1) * safeScale,
      height: Math.max(0, x2 - x1) * safeScale,
    }
  }

  if (normalized === 180) {
    return {
      left: (width - x2) * safeScale,
      top: y1 * safeScale,
      width: Math.max(0, x2 - x1) * safeScale,
      height: Math.max(0, y2 - y1) * safeScale,
    }
  }

  if (normalized === 270) {
    return {
      left: (height - y2) * safeScale,
      top: (width - x2) * safeScale,
      width: Math.max(0, y2 - y1) * safeScale,
      height: Math.max(0, x2 - x1) * safeScale,
    }
  }

  return {
    left: x1 * safeScale,
    top: (height - y2) * safeScale,
    width: Math.max(0, x2 - x1) * safeScale,
    height: Math.max(0, y2 - y1) * safeScale,
  }
}
