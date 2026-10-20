/**
 * CsLabTileOverlay — 资产拖拽时的四象限定向投射遮罩
 *
 * 只在拖拽 CSLab 资产时出现；文件摄取与胶囊拖拽不会触发。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CSLAB_PANE_IDS, type CsLabPaneId } from '@/atoms/cslab-atoms'
import {
  CSLAB_ASSET_MIME,
  hasDragType,
  readAssetDrag,
  type CsLabAssetDragPayload,
} from './cslab-dnd'

interface CsLabTileOverlayProps {
  visible: boolean
  targetPaneId: CsLabPaneId | null
  onHoverPane: (paneId: CsLabPaneId | null) => void
  onDropOnPane: (paneId: CsLabPaneId, payload: CsLabAssetDragPayload) => void
}

const POSITION_LABELS: Record<CsLabPaneId, string> = {
  'pane-1': '左上',
  'pane-2': '右上',
  'pane-3': '左下',
  'pane-4': '右下',
}

export function CsLabTileOverlay({
  visible,
  targetPaneId,
  onHoverPane,
  onDropOnPane,
}: CsLabTileOverlayProps): React.ReactElement | null {
  if (!visible) return null

  return (
    <div className="absolute inset-2 z-30 grid grid-cols-2 grid-rows-2 gap-2">
      {CSLAB_PANE_IDS.map((paneId) => {
        const active = targetPaneId === paneId
        return (
          <div
            key={paneId}
            onDragOver={(event) => {
              if (!hasDragType(event.dataTransfer, CSLAB_ASSET_MIME)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              onHoverPane(paneId)
            }}
            onDragLeave={() => onHoverPane(null)}
            onDrop={(event) => {
              if (!hasDragType(event.dataTransfer, CSLAB_ASSET_MIME)) return
              event.preventDefault()
              event.stopPropagation()
              const payload = readAssetDrag(event.dataTransfer)
              onHoverPane(null)
              if (payload) onDropOnPane(paneId, payload)
            }}
            className={cn(
              'flex items-center justify-center rounded-lg border border-dashed text-[11px] transition-colors',
              active
                ? 'border-solid border-cslab-accent/70 bg-cslab-accent/12 text-cslab-accent'
                : 'border-cslab-accent/45 bg-cslab-elevated/75 text-cslab-muted backdrop-blur-[1px]',
            )}
          >
            {POSITION_LABELS[paneId]}
          </div>
        )
      })}
    </div>
  )
}
