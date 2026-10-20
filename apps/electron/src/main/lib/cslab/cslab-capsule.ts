/**
 * CSLab 活体胶囊：绑定、陈旧检测、一键更新与血缘溯源
 *
 * 胶囊不复制数据，只保存 {tableUri, column, rowIndex} 与绑定时的数据表 revision。
 * 数据表 revision 变化即视为 stale，由主进程广播事件驱动前端呼吸灯。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  CsLabCapsule,
  CsLabCapsuleLineage,
  CsLabCapsuleLineageNode,
  CsLabCapsuleStatus,
} from '@profer/shared'
import {
  getCsLabDatabase,
  getCapsule as getCapsuleRow,
  getEntityByUri,
  getTable,
  insertEdge,
  listCapsuleRevisionRows,
  listCapsules as listCapsuleRows,
  listEdgesTo,
  upsertCapsule,
  withTransaction,
  type CsLabDatabase,
} from './cslab-db'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { readDatasetCell, readDatasetPreview, type CsLabTablePreview } from './cslab-columnar'
import { buildCsLabUri } from './cslab-uri'

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

/**
 * 读取数据表单元格：预览覆盖范围内直接取内存中的行，
 * 超出首屏 500 行时回退到 Parquet 行区间直读，避免静默写入空串。
 */
async function readTableValue(
  labId: string,
  table: { parquetRelPath: string },
  preview: CsLabTablePreview,
  columnIndex: number,
  rowIndex: number,
): Promise<string> {
  const column = preview.columns[columnIndex]
  if (!column) return ''
  if (rowIndex < preview.rows.length) {
    const cell = preview.rows[rowIndex]?.[columnIndex] ?? null
    return cell == null ? '' : String(cell)
  }
  const cell = await readDatasetCell(
    resolveLabRelativePath(labId, table.parquetRelPath),
    column.key,
    rowIndex,
  )
  return cell == null ? '' : String(cell)
}

function getManuscriptUriOf(db: CsLabDatabase, capsuleId: string): string | undefined {
  const row = db.raw
    .prepare('SELECT manuscript_uri FROM capsule_bindings WHERE capsule_id = ?')
    .get(capsuleId) as { manuscript_uri?: string | null } | undefined
  return row?.manuscript_uri ?? undefined
}

export interface BindCapsuleInput {
  id?: string
  label?: string
  tableUri: string
  column: string
  rowIndex: number
  unit?: string
}

function toCapsuleStatus(
  tableRevision: number | null,
  revisionAtBind: number,
): CsLabCapsuleStatus {
  if (tableRevision == null) return 'orphan'
  return tableRevision === revisionAtBind ? 'fresh' : 'stale'
}

/** 将数据表单元格绑定为胶囊。 */
export async function bindCapsule(
  labIdInput: string,
  manuscriptUri: string,
  input: BindCapsuleInput,
): Promise<CsLabCapsule> {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)

  const table = getTable(db, input.tableUri)
  if (!table) throw new Error('绑定的数据表不存在')
  const tableEntity = getEntityByUri(db, input.tableUri)
  if (!tableEntity || tableEntity.labId !== labId) throw new Error('数据表不属于当前实验室')

  const preview = await readDatasetPreview(
    resolveLabRelativePath(labId, table.previewRelPath),
  )
  if (!preview) throw new Error('数据表预览缺失，无法完成绑定')

  const columnIndex = preview.columns.findIndex((column) => column.key === input.column)
  if (columnIndex < 0) throw new Error('绑定的列不存在')
  if (input.rowIndex < 0 || input.rowIndex >= preview.totalRows) {
    throw new Error('绑定的行索引越界')
  }

  const value = await readTableValue(labId, table, preview, columnIndex, input.rowIndex)
  const columnMeta = preview.columns[columnIndex]
  const id = input.id ?? `cap-${randomUUID().slice(0, 8)}`
  const capsule: CsLabCapsule = {
    id,
    labId,
    label: input.label ?? columnMeta?.label ?? input.column,
    value,
    unit: input.unit ?? columnMeta?.unit,
    tableUri: input.tableUri,
    column: input.column,
    rowIndex: input.rowIndex,
    revisionAtBind: table.revision,
    status: 'fresh',
    updatedAt: Date.now(),
  }

  withTransaction(db, () => {
    upsertCapsule(db, capsule, manuscriptUri)
    const capsuleUri = buildCsLabUri(labId, 'capsule', id)
    const hasEdge = listEdgesTo(db, capsuleUri).some((edge) => edge.fromUri === input.tableUri)
    if (!hasEdge) {
      insertEdge(db, labId, input.tableUri, capsuleUri, 'binds', {
        column: input.column,
        rowIndex: input.rowIndex,
      })
    }
  })

  return capsule
}

/** 列出实验室全部胶囊，并计算实时状态。 */
export function listLabCapsules(labIdInput: string): CsLabCapsule[] {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const revisions = new Map(
    listCapsuleRevisionRows(db, labId).map((row) => [row.capsuleId, row]),
  )
  return listCapsuleRows(db, labId).map((capsule) => {
    const revision = revisions.get(capsule.id)
    return {
      ...capsule,
      status: toCapsuleStatus(revision?.tableRevision ?? null, capsule.revisionAtBind),
    }
  })
}

/** 返回当前需要更新的胶囊 id 列表。 */
export function checkStaleness(labIdInput: string): string[] {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  return listCapsuleRevisionRows(db, labId)
    .filter(
      (row) => row.tableRevision == null || row.tableRevision !== row.revisionAtBind,
    )
    .map((row) => row.capsuleId)
}

export interface UpdateCapsuleResult {
  capsule: CsLabCapsule
  changed: boolean
}

/** 一键更新：从当前数据表预览读取真实值，并推进绑定 revision。 */
export async function updateCapsule(
  labIdInput: string,
  capsuleId: string,
): Promise<UpdateCapsuleResult> {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const capsule = getCapsuleRow(db, capsuleId)
  if (!capsule || capsule.labId !== labId) throw new Error('胶囊不存在')

  const table = getTable(db, capsule.tableUri)
  if (!table) throw new Error('胶囊绑定的数据表已不存在（orphan）')

  const preview = await readDatasetPreview(
    resolveLabRelativePath(labId, table.previewRelPath),
  )
  if (!preview) throw new Error('数据表预览缺失')

  const columnIndex = preview.columns.findIndex((column) => column.key === capsule.column)
  if (columnIndex < 0) throw new Error('胶囊绑定的列已不存在')

  const nextValue = await readTableValue(labId, table, preview, columnIndex, capsule.rowIndex)
  const changed = nextValue !== capsule.value
  const manuscriptUri = getManuscriptUriOf(db, capsuleId)

  const updated: CsLabCapsule = {
    ...capsule,
    value: nextValue,
    revisionAtBind: table.revision,
    status: 'fresh',
    updatedAt: Date.now(),
  }
  upsertCapsule(db, updated, manuscriptUri)

  return { capsule: updated, changed }
}

/** 展开胶囊的因果血缘：raw -> table -> capsule。 */
export async function getCapsuleLineage(
  labIdInput: string,
  capsuleId: string,
): Promise<CsLabCapsuleLineage | null> {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const capsule = getCapsuleRow(db, capsuleId)
  if (!capsule || capsule.labId !== labId) return null

  const chain: CsLabCapsuleLineageNode[] = []

  const tableEntity = getEntityByUri(db, capsule.tableUri)
  const tableEdges = tableEntity ? listEdgesTo(db, tableEntity.uri) : []
  // 同名数据表可能被多次修订，每条新 raw 都会指向同一张表；血缘只展示最近一次上游。
  const latestUpstream = tableEdges[tableEdges.length - 1]
  if (latestUpstream) {
    const upstream = getEntityByUri(db, latestUpstream.fromUri)
    if (upstream) {
      chain.push({
        uri: upstream.uri,
        title: upstream.title,
        layerType: upstream.layerType,
        relation: latestUpstream.relation,
        updatedAt: upstream.updatedAt,
      })
    }
  }

  if (tableEntity) {
    chain.push({
      uri: tableEntity.uri,
      title: tableEntity.title,
      layerType: tableEntity.layerType,
      relation: 'derived_from',
      updatedAt: tableEntity.updatedAt,
    })
  }

  chain.push({
    uri: buildCsLabUri(labId, 'capsule', capsule.id),
    title: capsule.label,
    layerType: 'capsule',
    relation: 'binds',
    updatedAt: capsule.updatedAt,
  })

  let currentValue = capsule.value
  const table = getTable(db, capsule.tableUri)
  if (table) {
    const preview = await readDatasetPreview(
      resolveLabRelativePath(labId, table.previewRelPath),
    )
    if (preview) {
      const columnIndex = preview.columns.findIndex((column) => column.key === capsule.column)
      const value = columnIndex >= 0 ? preview.rows[capsule.rowIndex]?.[columnIndex] : null
      currentValue = value == null ? '' : String(value)
    }
  }

  return {
    capsuleId: capsule.id,
    chain,
    currentValue,
    previousValue: capsule.value,
  }
}
