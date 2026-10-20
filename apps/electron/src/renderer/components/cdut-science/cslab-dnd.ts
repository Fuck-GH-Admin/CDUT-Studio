/**
 * CSLab 拖拽协议单一事实源
 *
 * 两类载荷：
 * - application/x-cslab-ref：数据表单元格 → 编辑器 / 左侧文稿条目；
 * - application/x-cslab-asset：资产 / 文稿 → 主舞台窗格 / 四分屏象限。
 */

import type { CsLabCellRef, CsLabLayerType } from '@profer/shared'
import type { CapsuleNodeAttrs } from './cslab-capsule-node'

export const CSLAB_CELL_MIME = 'application/x-cslab-ref'
export const CSLAB_ASSET_MIME = 'application/x-cslab-asset'

export interface CsLabAssetDragPayload {
  kind: 'asset' | 'manuscript'
  uri: string
  title: string
  layerType?: CsLabLayerType
}

export function hasDragType(
  dataTransfer: DataTransfer | null | undefined,
  type: string,
): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types ?? []).includes(type)
}

export function readCellRef(
  dataTransfer: DataTransfer | null | undefined,
): CsLabCellRef | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(CSLAB_CELL_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CsLabCellRef>
    if (
      !parsed.tableUri ||
      !parsed.column ||
      typeof parsed.rowIndex !== 'number' ||
      typeof parsed.tableRevision !== 'number'
    ) {
      return null
    }
    return parsed as CsLabCellRef
  } catch {
    return null
  }
}

export function readAssetDrag(
  dataTransfer: DataTransfer | null | undefined,
): CsLabAssetDragPayload | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(CSLAB_ASSET_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CsLabAssetDragPayload>
    if (
      (parsed.kind !== 'asset' && parsed.kind !== 'manuscript') ||
      !parsed.uri ||
      !parsed.title
    ) {
      return null
    }
    return parsed as CsLabAssetDragPayload
  } catch {
    return null
  }
}

/** 单元格引用 → TipTap 胶囊节点属性。 */
export function buildCapsuleAttrs(cellRef: CsLabCellRef): CapsuleNodeAttrs {
  return {
    capsuleId: `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: cellRef.label,
    value: cellRef.value == null ? '' : String(cellRef.value),
    unit: cellRef.unit ?? '',
    tableUri: cellRef.tableUri,
    column: cellRef.column,
    rowIndex: cellRef.rowIndex,
    revisionAtBind: cellRef.tableRevision,
    status: 'fresh',
  }
}
