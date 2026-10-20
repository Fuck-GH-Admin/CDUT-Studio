/**
 * CSLab 全局 URI 工具
 *
 * 格式：cdut://{labId}/{layerType}/{entityUuid}[#anchor]
 */

import type { CsLabLayerType } from '@profer/shared'

export interface CsLabParsedUri {
  labId: string
  layerType: CsLabLayerType
  entityUuid: string
  anchor?: string
}

export function buildCsLabUri(
  labId: string,
  layerType: CsLabLayerType,
  entityUuid: string,
  anchor?: string,
): string {
  const base = `cdut://${labId}/${layerType}/${entityUuid}`
  return anchor ? `${base}#${anchor}` : base
}

export function parseCsLabUri(uri: string): CsLabParsedUri | null {
  if (!uri.startsWith('cdut://')) return null
  const withoutScheme = uri.slice('cdut://'.length)
  const [pathPart, anchor] = withoutScheme.split('#', 2)
  const segments = (pathPart ?? '').split('/').filter(Boolean)
  if (segments.length < 3) return null
  const [labId, layerType, entityUuid] = segments
  if (!labId || !layerType || !entityUuid) return null
  return {
    labId,
    layerType: layerType as CsLabLayerType,
    entityUuid,
    anchor,
  }
}

/** 胶囊占位符（可读降级载荷，拖到外部编辑器也保持可辨认）。 */
export function buildCapsulePlaceholder(tableUri: string, column: string, rowIndex: number): string {
  return `{{capsule:${tableUri}#${column}:${rowIndex}}}`
}
