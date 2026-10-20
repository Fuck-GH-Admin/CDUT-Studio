/**
 * CSLab 文献资产统一读取层
 *
 * 职责：
 * - 把 `entities(layer_type='lit')` 与 `literature_sources` 合并为面向渲染进程的文献模型；
 * - 解析 vault 相对路径与 Zotero 零拷贝绝对路径；
 * - 输出 Zotero 批注（完成坐标 JSON 解析，供 PDF 图层直接使用）。
 *
 * 红线：外部绝对路径必须来自已登记的 literature_sources，绝不接受渲染进程任意路径。
 */

import { existsSync, promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  CsLabLiteratureItem,
  CsLabZoteroAnnotation,
} from '@profer/shared'
import {
  countAnnotationsForItem,
  getEntityByUri,
  getLiteratureSource,
  getCsLabDatabase,
  listEntities,
  listLiteratureSources,
  listZoteroAnnotations,
  upsertLiteratureSource,
  type CsLabDatabase,
  type CsLabLiteratureSourceRecord,
} from './cslab-db'
import { resolveLabDir, resolveLabRelativePath, assertLabId } from './cslab-paths'
import {
  parseZoteroAnnotationPosition,
  type ZoteroAnnotationPosition,
} from './cslab-zotero-format'

interface LiteratureMetadata {
  authors?: string[]
  year?: string
  doi?: string
  publication?: string
  abstract?: string
  collections?: string[]
  pageCount?: number
}

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function parseMetadata(raw?: string): LiteratureMetadata {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as LiteratureMetadata
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function toLiteratureItem(
  labId: string,
  db: CsLabDatabase,
  source: CsLabLiteratureSourceRecord,
): CsLabLiteratureItem | null {
  const entity = getEntityByUri(db, source.uri)
  if (!entity || entity.layerType !== 'lit') return null
  const metadata = parseMetadata(source.metadataJson)

  const filePath = getLiteratureFilePathFromSource(labId, source)
  return {
    uri: entity.uri,
    labId,
    title: entity.title,
    authors: toStringArray(metadata.authors),
    year: metadata.year,
    doi: metadata.doi,
    publication: metadata.publication,
    abstract: metadata.abstract,
    collections: toStringArray(metadata.collections),
    format: 'pdf',
    source: source.source,
    zoteroItemKey: source.zoteroItemKey,
    pageCount: source.pageCount ?? metadata.pageCount,
    annotationCount: countAnnotationsForItem(db, labId, entity.uri),
    hasFile: !!filePath,
    updatedAt: entity.updatedAt,
  }
}

/** 从已登记的来源记录解析真实文件路径（不做 IPC 暴露）。 */
export function getLiteratureFilePathFromSource(
  labId: string,
  source: CsLabLiteratureSourceRecord,
): string | null {
  if (source.relPath) {
    try {
      const target = resolveLabRelativePath(labId, source.relPath)
      return existsSync(target) ? target : null
    } catch {
      return null
    }
  }
  if (source.absPath) {
    const target = resolve(source.absPath)
    return existsSync(target) ? target : null
  }
  return null
}

/** 列出实验室全部文献（按更新时间倒序）。 */
export function listLiterature(labIdInput: string): CsLabLiteratureItem[] {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const sources = listLiteratureSources(db, labId)
  const items: CsLabLiteratureItem[] = []
  for (const source of sources) {
    const item = toLiteratureItem(labId, db, source)
    if (item) items.push(item)
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getLiteratureItem(
  labIdInput: string,
  uri: string,
): CsLabLiteratureItem | null {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const source = getLiteratureSource(db, uri)
  if (!source || source.labId !== labId) return null
  return toLiteratureItem(labId, db, source)
}

export function getLiteratureSourceRecord(
  labIdInput: string,
  uri: string,
): CsLabLiteratureSourceRecord | null {
  const labId = assertLabId(labIdInput)
  return getLiteratureSource(labDb(labId), uri)
}

export interface LiteratureFilePathResult {
  path?: string
  reason?: string
}

/** 解析文献物理路径；失败时给出可读原因。 */
export function getLiteratureFilePath(
  labIdInput: string,
  uri: string,
): LiteratureFilePathResult {
  const labId = assertLabId(labIdInput)
  const source = getLiteratureSource(labDb(labId), uri)
  if (!source) return { reason: '文献未登记或不属于当前实验室' }
  if (source.source === 'zotero' && !source.absPath) {
    return { reason: '该 Zotero 条目没有可用的 PDF 附件' }
  }
  const path = getLiteratureFilePathFromSource(labId, source)
  if (!path) return { reason: '文献文件不存在或已移动，请重新同步 Zotero' }
  return { path }
}

export interface LiteratureAnnotationItem extends CsLabZoteroAnnotation {
  /** 已解析的原始位置信息，便于渲染层做旋转处理。 */
  position: ZoteroAnnotationPosition
}

/** 读取某文献的 Zotero 批注（按 sortIndex 排序）。 */
export function listLiteratureAnnotations(
  labIdInput: string,
  itemUri: string,
): LiteratureAnnotationItem[] {
  const labId = assertLabId(labIdInput)
  const rows = listZoteroAnnotations(labDb(labId), labId, itemUri)
  const results: LiteratureAnnotationItem[] = []
  for (const row of rows) {
    const position = parseZoteroAnnotationPosition(row.positionJson)
    if (!position) continue
    results.push({
      key: row.annotationKey,
      itemUri: row.itemUri,
      type: row.annotationType,
      pageIndex: row.pageIndex,
      rects: position.rects,
      inkPaths: position.inkPaths,
      color: row.color,
      text: row.text,
      comment: row.comment,
      author: row.author,
      sortIndex: row.sortIndex,
      modifiedAt: row.modifiedAt,
      position,
    })
  }
  return results
}

/** 登记/更新文献来源记录（Zotero 同步与 vault 导入共用）。 */
export function upsertLiteratureRecord(
  db: CsLabDatabase,
  record: CsLabLiteratureSourceRecord,
): void {
  upsertLiteratureSource(db, record)
}

/** 读取 PDF 字节（供文本索引与 GraphRAG 使用）。 */
export async function readLiteratureBuffer(
  labId: string,
  uri: string,
  maxBytes = 128 * 1024 * 1024,
): Promise<Buffer | null> {
  const resolved = getLiteratureFilePath(labId, uri)
  if (!resolved.path) return null
  const stat = await fs.stat(resolved.path)
  if (!stat.isFile() || stat.size > maxBytes) return null
  return fs.readFile(resolved.path)
}

/** 供测试与内部使用的实体存在性检查。 */
export function literatureEntityExists(labId: string, uri: string): boolean {
  const entity = getEntityByUri(labDb(assertLabId(labId)), uri)
  return !!entity && entity.layerType === 'lit'
}

/** 列出实验室 literature 实体（GraphRAG 索引使用）。 */
export function listLiteratureEntities(labId: string) {
  return listEntities(labDb(assertLabId(labId)), labId).filter(
    (entity) => entity.layerType === 'lit',
  )
}
