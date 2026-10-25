/**
 * CsLabStageGrid — 1/4 颗粒度分屏舞台
 */

import * as React from 'react'
import type {
  CsLabAssetSummary,
  CsLabCanvasDocument,
  CsLabCanvasWriteResult,
  CsLabCellRef,
  CsLabLiteratureItem,
  CsLabManuscript,
  CsLabMolAsset,
  CsLabGeoRasterPayload,
  CsLabTablePayload,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import {
  CSLAB_PANE_IDS,
  type CsLabPaneId,
  type CsLabPaneState,
  type CsLabPdfSelection,
  type CsLabSplitLayout,
} from '@/atoms/cslab-atoms'
import { CsLabStagePane } from './CsLabStagePane'
import type { CsLabDagNodeTarget } from './CsLabDagCanvas'
import type { CsLabAssetDragPayload } from './cslab-dnd'
import type {
  CsLabCanvasHandle,
  CsLabCanvasSnapshot,
} from './canvas-manuscript/cslab-canvas-types'

interface CsLabStageGridProps {
  layout: CsLabSplitLayout
  activePaneId: CsLabPaneId
  panes: Record<CsLabPaneId, CsLabPaneState>
  tables: Record<CsLabPaneId, CsLabTablePayload | null>
  manuscripts: Record<CsLabPaneId, CsLabManuscript | null>
  literature: Record<CsLabPaneId, CsLabLiteratureItem | null>
  canvases: Record<CsLabPaneId, CsLabCanvasDocument | null>
  mols: Record<CsLabPaneId, CsLabMolAsset | null>
  geos: Record<CsLabPaneId, CsLabGeoRasterPayload | null>
  assets: CsLabAssetSummary[]
  loading: Record<CsLabPaneId, boolean>
  saving: Record<CsLabPaneId, boolean>
  staleCapsuleIds: Set<string>
  labId: string
  assetTitles: Record<string, string>
  onActivatePane: (paneId: CsLabPaneId) => void
  onClosePane: (paneId: CsLabPaneId) => void
  onMaximizePane: (paneId: CsLabPaneId) => void
  onEditorReady: (paneId: CsLabPaneId, handle: CsLabCanvasHandle | null) => void
  onSaveManuscript: (
    paneId: CsLabPaneId,
    snapshot: CsLabCanvasSnapshot,
    title: string,
  ) => Promise<void>
  onSaveManuscriptAs?: (
    paneId: CsLabPaneId,
    snapshot: CsLabCanvasSnapshot,
    title: string,
  ) => Promise<void>
  onDirtyChange: (paneId: CsLabPaneId, dirty: boolean) => void
  onTitleChange: (paneId: CsLabPaneId, title: string) => void
  onCapsuleClick: (capsuleId: string) => void
  onCellClick: (cell: CsLabCellRef) => void
  onPdfSelection: (selection: CsLabPdfSelection) => void
  onDropAssetOnPane: (paneId: CsLabPaneId, payload: CsLabAssetDragPayload) => void
  onCanvasSaved: (
    paneId: CsLabPaneId,
    document: CsLabCanvasDocument,
    result: CsLabCanvasWriteResult,
  ) => void
  onToast: (
    kind: 'info' | 'success' | 'error',
    text: string,
    action?: { label: string; path: string },
  ) => void
  /** 划词右键「检索关联学术文献」反向打开学术检索弹窗。 */
  onSearchLiterature: (query: string) => void
  /** 打开推演画布 file/link 节点引用的资产、笔记或外链（Bug 6）。 */
  onOpenNodeTarget?: (target: CsLabDagNodeTarget) => void
}

const LAYOUT_CLASS: Record<CsLabSplitLayout, string> = {
  single: 'grid-cols-1 grid-rows-1',
  'split-vertical': 'grid-cols-2 grid-rows-1',
  'split-horizontal': 'grid-cols-1 grid-rows-2',
  'grid-4': 'grid-cols-2 grid-rows-2',
}

const VISIBLE_PANES: Record<CsLabSplitLayout, CsLabPaneId[]> = {
  single: ['pane-1'],
  'split-vertical': ['pane-1', 'pane-2'],
  'split-horizontal': ['pane-1', 'pane-2'],
  'grid-4': ['pane-1', 'pane-2', 'pane-3', 'pane-4'],
}

export function CsLabStageGrid({
  layout,
  activePaneId,
  panes,
  tables,
  manuscripts,
  literature,
  canvases,
  mols,
  geos,
  assets,
  loading,
  saving,
  staleCapsuleIds,
  labId,
  assetTitles,
  onActivatePane,
  onClosePane,
  onMaximizePane,
  onEditorReady,
  onSaveManuscript,
  onSaveManuscriptAs,
  onDirtyChange,
  onTitleChange,
  onCapsuleClick,
  onCellClick,
  onPdfSelection,
  onDropAssetOnPane,
  onCanvasSaved,
  onToast,
  onSearchLiterature,
  onOpenNodeTarget,
}: CsLabStageGridProps): React.ReactElement {
  const visiblePanes =
    layout === 'single' ? [activePaneId] : VISIBLE_PANES[layout]

  return (
    <div data-tour="cslab-stage-grid" className={cn('grid h-full min-h-0 gap-2 bg-cslab-bg p-2', LAYOUT_CLASS[layout])}>
      {/* 所有窗格保持挂载，仅通过 hidden 控制可见性，避免切换布局时销毁编辑器/丢失未保存内容。 */}
      {CSLAB_PANE_IDS.map((paneId) => {
        const pane = panes[paneId]
        const figureAsset =
          pane.viewType === 'figure' && pane.assetUri
            ? assets.find((asset) => asset.uri === pane.assetUri) ?? null
            : null
        return (
          <CsLabStagePane
            key={paneId}
            paneId={paneId}
            pane={pane}
            isHidden={!visiblePanes.includes(paneId)}
            active={activePaneId === paneId}
            title={
              pane.assetUri
                ? assetTitles[pane.assetUri]
                : pane.literatureUri
                  ? literature[paneId]?.title
                  : undefined
            }
            labId={labId}
            table={tables[paneId]}
            manuscript={manuscripts[paneId]}
            literature={literature[paneId]}
            canvas={canvases[paneId]}
            mol={mols[paneId]}
            geo={geos[paneId]}
            figureAsset={figureAsset}
            initialPage={pane.pdfInitialPage}
            focusHighlight={pane.pdfFocusHighlight}
            loading={loading[paneId]}
            saving={saving[paneId]}
            staleCapsuleIds={staleCapsuleIds}
            onActivate={() => onActivatePane(paneId)}
            onClose={() => onClosePane(paneId)}
            onMaximize={() => onMaximizePane(paneId)}
            onEditorReady={(handle) => onEditorReady(paneId, handle)}
            onSaveManuscript={(snapshot, title) =>
              onSaveManuscript(paneId, snapshot, title)
            }
            onSaveManuscriptAs={
              onSaveManuscriptAs
                ? (snapshot: CsLabCanvasSnapshot, title: string) =>
                    onSaveManuscriptAs(paneId, snapshot, title)
                : undefined
            }
            onDirtyChange={(dirty) => onDirtyChange(paneId, dirty)}
            onTitleChange={(title) => onTitleChange(paneId, title)}
            onCapsuleClick={onCapsuleClick}
            onCellClick={onCellClick}
            onPdfSelection={onPdfSelection}
            onDropAsset={(payload) => onDropAssetOnPane(paneId, payload)}
            onCanvasSaved={(document, result) => onCanvasSaved(paneId, document, result)}
            onToast={onToast}
            onSearchLiterature={onSearchLiterature}
            onOpenNodeTarget={onOpenNodeTarget}
          />
        )
      })}
    </div>
  )
}
