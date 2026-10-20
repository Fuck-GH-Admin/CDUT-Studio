/**
 * CSLab SQLite 适配层
 *
 * 红线（审计修正）：
 * 1. 业务层禁止直接 new DatabaseSync，统一经 getCsLabDatabase 获取；
 * 2. 不依赖 DatabaseSync.prototype.transaction（Bun/Node 实现存在差异），
 *    统一使用 BEGIN IMMEDIATE / COMMIT / ROLLBACK 显式事务；
 * 3. 打开即启用 WAL 与 busy_timeout，保证主进程异步写入不锁死 UI。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type {
  CsLabCapsule,
  CsLabLayerType,
  CsLabRunLink,
  CsLabRunStatus,
} from '@profer/shared'

interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

export interface CsLabDatabase {
  readonly dbPath: string
  readonly raw: SqliteDatabase
}

export interface CsLabEntityRecord {
  uri: string
  labId: string
  layerType: CsLabLayerType
  entityUuid: string
  title: string
  format?: string
  relPath?: string
  sha256?: string
  bytes?: number
  revision: number
  locked: boolean
  unsupported?: string
  createdAt: number
  updatedAt: number
}

export interface CsLabTableRecord {
  uri: string
  parquetRelPath: string
  previewRelPath: string
  columnsJson: string
  rowCount: number
  revision: number
}

export interface CsLabManuscriptRecord {
  uri: string
  title: string
  relPath: string
  sidecarRelPath: string
  docxRelPath?: string
  updatedAt: number
}

export interface CsLabLiteratureSourceRecord {
  uri: string
  labId: string
  source: 'vault' | 'zotero'
  relPath?: string
  absPath?: string
  zoteroItemKey?: string
  zoteroAttachmentKey?: string
  metadataJson?: string
  pageCount?: number
  sha256?: string
  updatedAt: number
}

export interface CsLabZoteroAnnotationRecord {
  annotationKey: string
  labId: string
  itemUri: string
  annotationType: string
  pageIndex: number
  positionJson: string
  color?: string
  text?: string
  comment?: string
  sortIndex?: string
  author?: string
  modifiedAt?: number
  version: number
}

export interface CsLabZoteroCollectionRecord {
  collectionKey: string
  labId: string
  name: string
  path: string
  parentKey?: string
  version: number
}

const connections = new Map<string, CsLabDatabase>()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entities (
  uri TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  layer_type TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT,
  rel_path TEXT,
  sha256 TEXT,
  bytes INTEGER,
  meta_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  unsupported TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_uuid ON entities(lab_id, entity_uuid);
CREATE INDEX IF NOT EXISTS idx_entities_layer ON entities(lab_id, layer_type);
CREATE INDEX IF NOT EXISTS idx_entities_sha ON entities(lab_id, sha256);

CREATE TABLE IF NOT EXISTS provenance_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id TEXT NOT NULL,
  from_uri TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  relation TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_to ON provenance_edges(to_uri);
CREATE INDEX IF NOT EXISTS idx_edges_from ON provenance_edges(from_uri);

CREATE TABLE IF NOT EXISTS tables (
  uri TEXT PRIMARY KEY,
  parquet_rel_path TEXT NOT NULL,
  preview_rel_path TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS capsule_bindings (
  capsule_id TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  manuscript_uri TEXT,
  table_uri TEXT NOT NULL,
  column TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  revision_at_bind INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manuscripts (
  uri TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  sidecar_rel_path TEXT NOT NULL,
  docx_rel_path TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS literature_sources (
  uri TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  source TEXT NOT NULL,
  rel_path TEXT,
  abs_path TEXT,
  zotero_item_key TEXT,
  zotero_attachment_key TEXT,
  metadata_json TEXT,
  page_count INTEGER,
  sha256 TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lit_lab ON literature_sources(lab_id);
CREATE INDEX IF NOT EXISTS idx_lit_zotero ON literature_sources(lab_id, zotero_item_key);

CREATE TABLE IF NOT EXISTS zotero_annotations (
  annotation_key TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  item_uri TEXT NOT NULL,
  annotation_type TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  position_json TEXT NOT NULL,
  color TEXT,
  text TEXT,
  comment TEXT,
  sort_index TEXT,
  author TEXT,
  modified_at INTEGER,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anno_item ON zotero_annotations(item_uri);
CREATE INDEX IF NOT EXISTS idx_anno_lab ON zotero_annotations(lab_id);

CREATE TABLE IF NOT EXISTS zotero_collections (
  collection_key TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_key TEXT,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collection_lab ON zotero_collections(lab_id);

CREATE TABLE IF NOT EXISTS protocols (
  uri TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  title TEXT NOT NULL,
  method TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  steps_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_protocols_lab ON protocols(lab_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  uri TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  protocol_uri TEXT,
  protocol_title TEXT,
  protocol_version INTEGER,
  title TEXT NOT NULL,
  batch_no TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  operator TEXT,
  parameters_json TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '',
  outcome TEXT,
  links_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_lab ON runs(lab_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_batch ON runs(lab_id, batch_no);
`

/** 打开（或复用）指定实验室的 central_meta.sqlite。 */
export function getCsLabDatabase(dbPath: string): CsLabDatabase {
  const cached = connections.get(dbPath)
  if (cached) return cached

  const dir = join(dbPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const raw = new DatabaseSync(dbPath)
  raw.exec(SCHEMA_SQL)

  const database: CsLabDatabase = { dbPath, raw }
  connections.set(dbPath, database)
  return database
}

/** 关闭缓存连接（测试与实验室切换时使用）。 */
export function closeCsLabDatabase(dbPath: string): void {
  const cached = connections.get(dbPath)
  if (!cached) return
  try {
    cached.raw.close()
  } catch {
    // 连接可能已被宿主关闭，忽略。
  }
  connections.delete(dbPath)
}

export function closeAllCsLabDatabases(): void {
  for (const dbPath of [...connections.keys()]) closeCsLabDatabase(dbPath)
}

/**
 * 显式事务封装：不依赖 DatabaseSync.prototype.transaction。
 */
export function withTransaction<T>(db: CsLabDatabase, work: () => T): T {
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.raw.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.raw.exec('ROLLBACK')
    } catch {
      // SQLite 可能已因错误自动回滚。
    }
    throw error
  }
}

// ===== 实体 =====

function rowToEntity(row: Record<string, unknown>): CsLabEntityRecord {
  return {
    uri: String(row.uri),
    labId: String(row.lab_id),
    layerType: String(row.layer_type) as CsLabLayerType,
    entityUuid: String(row.entity_uuid),
    title: String(row.title),
    format: row.format == null ? undefined : String(row.format),
    relPath: row.rel_path == null ? undefined : String(row.rel_path),
    sha256: row.sha256 == null ? undefined : String(row.sha256),
    bytes: row.bytes == null ? undefined : Number(row.bytes),
    revision: Number(row.revision),
    locked: Number(row.locked) === 1,
    unsupported: row.unsupported == null ? undefined : String(row.unsupported),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function upsertEntity(db: CsLabDatabase, entity: CsLabEntityRecord): void {
  db.raw
    .prepare(`
      INSERT INTO entities (
        uri, lab_id, layer_type, entity_uuid, title, format, rel_path, sha256, bytes,
        revision, locked, unsupported, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        title = excluded.title,
        format = excluded.format,
        rel_path = excluded.rel_path,
        sha256 = excluded.sha256,
        bytes = excluded.bytes,
        revision = excluded.revision,
        locked = excluded.locked,
        unsupported = excluded.unsupported,
        updated_at = excluded.updated_at
    `)
    .run(
      entity.uri,
      entity.labId,
      entity.layerType,
      entity.entityUuid,
      entity.title,
      entity.format ?? null,
      entity.relPath ?? null,
      entity.sha256 ?? null,
      entity.bytes ?? null,
      entity.revision,
      entity.locked ? 1 : 0,
      entity.unsupported ?? null,
      entity.createdAt,
      entity.updatedAt,
    )
}

export function getEntityByUri(db: CsLabDatabase, uri: string): CsLabEntityRecord | null {
  const row = db.raw.prepare('SELECT * FROM entities WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  return row ? rowToEntity(row) : null
}

export function findEntityBySha(
  db: CsLabDatabase,
  labId: string,
  sha256: string,
): CsLabEntityRecord | null {
  // 只匹配 raw 实体：数据表实体共享同一 SHA-256，若命中表会导致去重逻辑拿错 URI。
  const row = db.raw
    .prepare(
      "SELECT * FROM entities WHERE lab_id = ? AND sha256 = ? AND layer_type = 'raw' ORDER BY updated_at DESC LIMIT 1",
    )
    .get(labId, sha256) as Record<string, unknown> | undefined
  return row ? rowToEntity(row) : null
}

export function listEntities(db: CsLabDatabase, labId: string): CsLabEntityRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM entities WHERE lab_id = ? ORDER BY updated_at DESC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToEntity)
}

/** 按标题查找同维度实体（用于同名数据表增量覆盖，保持 URI 稳定）。 */
export function findEntityByTitle(
  db: CsLabDatabase,
  labId: string,
  title: string,
  layerType: CsLabLayerType,
): CsLabEntityRecord | null {
  const row = db.raw
    .prepare(
      'SELECT * FROM entities WHERE lab_id = ? AND title = ? AND layer_type = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(labId, title, layerType) as Record<string, unknown> | undefined
  return row ? rowToEntity(row) : null
}

export function countEntities(db: CsLabDatabase, labId: string): Record<CsLabLayerType, number> {
  const rows = db.raw
    .prepare('SELECT layer_type, COUNT(*) AS count FROM entities WHERE lab_id = ? GROUP BY layer_type')
    .all(labId) as Array<{ layer_type: string; count: number }>
  const counts = {} as Record<CsLabLayerType, number>
  for (const row of rows) counts[row.layer_type as CsLabLayerType] = Number(row.count)
  return counts
}

// ===== 血缘 =====

export function insertEdge(
  db: CsLabDatabase,
  labId: string,
  fromUri: string,
  toUri: string,
  relation: string,
  detail?: unknown,
): void {
  db.raw
    .prepare(
      'INSERT INTO provenance_edges (lab_id, from_uri, to_uri, relation, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(labId, fromUri, toUri, relation, detail == null ? null : JSON.stringify(detail), Date.now())
}

export interface CsLabEdgeRow {
  fromUri: string
  toUri: string
  relation: string
  createdAt: number
}

export function listEdgesTo(db: CsLabDatabase, toUri: string): CsLabEdgeRow[] {
  const rows = db.raw
    .prepare('SELECT from_uri, to_uri, relation, created_at FROM provenance_edges WHERE to_uri = ? ORDER BY id ASC')
    .all(toUri) as Array<{ from_uri: string; to_uri: string; relation: string; created_at: number }>
  return rows.map((row) => ({
    fromUri: row.from_uri,
    toUri: row.to_uri,
    relation: row.relation,
    createdAt: Number(row.created_at),
  }))
}

export function listEdgesFrom(db: CsLabDatabase, fromUri: string): CsLabEdgeRow[] {
  const rows = db.raw
    .prepare('SELECT from_uri, to_uri, relation, created_at FROM provenance_edges WHERE from_uri = ? ORDER BY id ASC')
    .all(fromUri) as Array<{ from_uri: string; to_uri: string; relation: string; created_at: number }>
  return rows.map((row) => ({
    fromUri: row.from_uri,
    toUri: row.to_uri,
    relation: row.relation,
    createdAt: Number(row.created_at),
  }))
}

// ===== 实验室级 revision =====

export function nextLabRevision(db: CsLabDatabase): number {
  const row = db.raw.prepare("SELECT value FROM lab_state WHERE key = 'revision'").get() as
    | { value: string }
    | undefined
  const next = Number(row?.value ?? '0') + 1
  db.raw
    .prepare("INSERT INTO lab_state (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(next))
  return next
}

export function getLabRevision(db: CsLabDatabase): number {
  const row = db.raw.prepare("SELECT value FROM lab_state WHERE key = 'revision'").get() as
    | { value: string }
    | undefined
  return Number(row?.value ?? '0')
}

export function setLabState(db: CsLabDatabase, key: string, value: string): void {
  db.raw
    .prepare('INSERT INTO lab_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

export function getLabState(db: CsLabDatabase, key: string): string | null {
  const row = db.raw.prepare('SELECT value FROM lab_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? String(row.value) : null
}

// ===== 表格 =====

export function upsertTable(db: CsLabDatabase, table: CsLabTableRecord): void {
  db.raw
    .prepare(`
      INSERT INTO tables (uri, parquet_rel_path, preview_rel_path, columns_json, row_count, revision)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        parquet_rel_path = excluded.parquet_rel_path,
        preview_rel_path = excluded.preview_rel_path,
        columns_json = excluded.columns_json,
        row_count = excluded.row_count,
        revision = excluded.revision
    `)
    .run(table.uri, table.parquetRelPath, table.previewRelPath, table.columnsJson, table.rowCount, table.revision)
}

export function getTable(db: CsLabDatabase, uri: string): CsLabTableRecord | null {
  const row = db.raw.prepare('SELECT * FROM tables WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    uri: String(row.uri),
    parquetRelPath: String(row.parquet_rel_path),
    previewRelPath: String(row.preview_rel_path),
    columnsJson: String(row.columns_json),
    rowCount: Number(row.row_count),
    revision: Number(row.revision),
  }
}

// ===== 胶囊 =====

export function upsertCapsule(
  db: CsLabDatabase,
  capsule: CsLabCapsule,
  manuscriptUri?: string,
): void {
  db.raw
    .prepare(`
      INSERT INTO capsule_bindings (
        capsule_id, lab_id, manuscript_uri, table_uri, column, row_index, value, unit, revision_at_bind, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capsule_id) DO UPDATE SET
        manuscript_uri = excluded.manuscript_uri,
        table_uri = excluded.table_uri,
        column = excluded.column,
        row_index = excluded.row_index,
        value = excluded.value,
        unit = excluded.unit,
        revision_at_bind = excluded.revision_at_bind,
        updated_at = excluded.updated_at
    `)
    .run(
      capsule.id,
      capsule.labId,
      manuscriptUri ?? null,
      capsule.tableUri,
      capsule.column,
      capsule.rowIndex,
      capsule.value,
      capsule.unit ?? null,
      capsule.revisionAtBind,
      capsule.updatedAt,
    )
}

export function getCapsule(db: CsLabDatabase, capsuleId: string): CsLabCapsule | null {
  const row = db.raw.prepare('SELECT * FROM capsule_bindings WHERE capsule_id = ?').get(capsuleId) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    id: String(row.capsule_id),
    labId: String(row.lab_id),
    label: String(row.column),
    value: String(row.value),
    unit: row.unit == null ? undefined : String(row.unit),
    tableUri: String(row.table_uri),
    column: String(row.column),
    rowIndex: Number(row.row_index),
    revisionAtBind: Number(row.revision_at_bind),
    status: 'fresh',
    updatedAt: Number(row.updated_at),
  }
}

export function listCapsules(db: CsLabDatabase, labId: string): CsLabCapsule[] {
  const rows = db.raw
    .prepare('SELECT * FROM capsule_bindings WHERE lab_id = ? ORDER BY updated_at DESC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.capsule_id),
    labId: String(row.lab_id),
    label: String(row.column),
    value: String(row.value),
    unit: row.unit == null ? undefined : String(row.unit),
    tableUri: String(row.table_uri),
    column: String(row.column),
    rowIndex: Number(row.row_index),
    revisionAtBind: Number(row.revision_at_bind),
    status: 'fresh',
    updatedAt: Number(row.updated_at),
  }))
}

export function deleteCapsule(db: CsLabDatabase, capsuleId: string): void {
  db.raw.prepare('DELETE FROM capsule_bindings WHERE capsule_id = ?').run(capsuleId)
}

export function deleteCapsulesByManuscript(db: CsLabDatabase, manuscriptUri: string): void {
  db.raw.prepare('DELETE FROM capsule_bindings WHERE manuscript_uri = ?').run(manuscriptUri)
}

export interface CsLabCapsuleRevisionRow {
  capsuleId: string
  tableUri: string
  revisionAtBind: number
  tableRevision: number | null
}

/** 用于陈旧检测：比较绑定 revision 与数据表当前 revision。 */
export function listCapsuleRevisionRows(
  db: CsLabDatabase,
  labId: string,
): CsLabCapsuleRevisionRow[] {
  const rows = db.raw
    .prepare(`
      SELECT c.capsule_id, c.table_uri, c.revision_at_bind, t.revision AS table_revision
      FROM capsule_bindings c
      LEFT JOIN tables t ON t.uri = c.table_uri
      WHERE c.lab_id = ?
    `)
    .all(labId) as Array<{
    capsule_id: string
    table_uri: string
    revision_at_bind: number
    table_revision: number | null
  }>
  return rows.map((row) => ({
    capsuleId: String(row.capsule_id),
    tableUri: String(row.table_uri),
    revisionAtBind: Number(row.revision_at_bind),
    tableRevision: row.table_revision == null ? null : Number(row.table_revision),
  }))
}

// ===== 文稿 =====

export function upsertManuscript(db: CsLabDatabase, record: CsLabManuscriptRecord): void {
  db.raw
    .prepare(`
      INSERT INTO manuscripts (uri, title, rel_path, sidecar_rel_path, docx_rel_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        title = excluded.title,
        rel_path = excluded.rel_path,
        sidecar_rel_path = excluded.sidecar_rel_path,
        docx_rel_path = excluded.docx_rel_path,
        updated_at = excluded.updated_at
    `)
    .run(
      record.uri,
      record.title,
      record.relPath,
      record.sidecarRelPath,
      record.docxRelPath ?? null,
      record.updatedAt,
    )
}

export function getManuscriptRecord(db: CsLabDatabase, uri: string): CsLabManuscriptRecord | null {
  const row = db.raw.prepare('SELECT * FROM manuscripts WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    uri: String(row.uri),
    title: String(row.title),
    relPath: String(row.rel_path),
    sidecarRelPath: String(row.sidecar_rel_path),
    docxRelPath: row.docx_rel_path == null ? undefined : String(row.docx_rel_path),
    updatedAt: Number(row.updated_at),
  }
}

export function listManuscriptRecords(db: CsLabDatabase): CsLabManuscriptRecord[] {
  const rows = db.raw.prepare('SELECT * FROM manuscripts ORDER BY updated_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => ({
    uri: String(row.uri),
    title: String(row.title),
    relPath: String(row.rel_path),
    sidecarRelPath: String(row.sidecar_rel_path),
    docxRelPath: row.docx_rel_path == null ? undefined : String(row.docx_rel_path),
    updatedAt: Number(row.updated_at),
  }))
}

// ===== 文献来源（Phase 2） =====

function rowToLiteratureSource(row: Record<string, unknown>): CsLabLiteratureSourceRecord {
  return {
    uri: String(row.uri),
    labId: String(row.lab_id),
    source: String(row.source) === 'zotero' ? 'zotero' : 'vault',
    relPath: row.rel_path == null ? undefined : String(row.rel_path),
    absPath: row.abs_path == null ? undefined : String(row.abs_path),
    zoteroItemKey: row.zotero_item_key == null ? undefined : String(row.zotero_item_key),
    zoteroAttachmentKey:
      row.zotero_attachment_key == null ? undefined : String(row.zotero_attachment_key),
    metadataJson: row.metadata_json == null ? undefined : String(row.metadata_json),
    pageCount: row.page_count == null ? undefined : Number(row.page_count),
    sha256: row.sha256 == null ? undefined : String(row.sha256),
    updatedAt: Number(row.updated_at),
  }
}

export function upsertLiteratureSource(db: CsLabDatabase, record: CsLabLiteratureSourceRecord): void {
  db.raw
    .prepare(`
      INSERT INTO literature_sources (
        uri, lab_id, source, rel_path, abs_path, zotero_item_key, zotero_attachment_key,
        metadata_json, page_count, sha256, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        source = excluded.source,
        rel_path = excluded.rel_path,
        abs_path = excluded.abs_path,
        zotero_item_key = excluded.zotero_item_key,
        zotero_attachment_key = excluded.zotero_attachment_key,
        metadata_json = excluded.metadata_json,
        page_count = excluded.page_count,
        sha256 = excluded.sha256,
        updated_at = excluded.updated_at
    `)
    .run(
      record.uri,
      record.labId,
      record.source,
      record.relPath ?? null,
      record.absPath ?? null,
      record.zoteroItemKey ?? null,
      record.zoteroAttachmentKey ?? null,
      record.metadataJson ?? null,
      record.pageCount ?? null,
      record.sha256 ?? null,
      record.updatedAt,
    )
}

export function getLiteratureSource(db: CsLabDatabase, uri: string): CsLabLiteratureSourceRecord | null {
  const row = db.raw.prepare('SELECT * FROM literature_sources WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  return row ? rowToLiteratureSource(row) : null
}

export function listLiteratureSources(
  db: CsLabDatabase,
  labId: string,
): CsLabLiteratureSourceRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM literature_sources WHERE lab_id = ? ORDER BY updated_at DESC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToLiteratureSource)
}

export function findLiteratureByZoteroKey(
  db: CsLabDatabase,
  labId: string,
  zoteroItemKey: string,
): CsLabLiteratureSourceRecord | null {
  const row = db.raw
    .prepare('SELECT * FROM literature_sources WHERE lab_id = ? AND zotero_item_key = ? LIMIT 1')
    .get(labId, zoteroItemKey) as Record<string, unknown> | undefined
  return row ? rowToLiteratureSource(row) : null
}

export function findLiteratureBySha(
  db: CsLabDatabase,
  labId: string,
  sha256: string,
): CsLabLiteratureSourceRecord | null {
  const row = db.raw
    .prepare('SELECT * FROM literature_sources WHERE lab_id = ? AND sha256 = ? LIMIT 1')
    .get(labId, sha256) as Record<string, unknown> | undefined
  return row ? rowToLiteratureSource(row) : null
}

export function deleteLiteratureSource(db: CsLabDatabase, uri: string): void {
  db.raw.prepare('DELETE FROM literature_sources WHERE uri = ?').run(uri)
}

/** 按维度查找同 SHA 的实体（文献去重不与 raw 混用）。 */
export function findEntityByShaAndLayer(
  db: CsLabDatabase,
  labId: string,
  sha256: string,
  layerType: CsLabLayerType,
): CsLabEntityRecord | null {
  const row = db.raw
    .prepare(
      'SELECT * FROM entities WHERE lab_id = ? AND sha256 = ? AND layer_type = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(labId, sha256, layerType) as Record<string, unknown> | undefined
  return row ? rowToEntity(row) : null
}

// ===== Zotero 批注与分类（Phase 2） =====

export function upsertZoteroAnnotation(db: CsLabDatabase, record: CsLabZoteroAnnotationRecord): void {
  db.raw
    .prepare(`
      INSERT INTO zotero_annotations (
        annotation_key, lab_id, item_uri, annotation_type, page_index, position_json,
        color, text, comment, sort_index, author, modified_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(annotation_key) DO UPDATE SET
        item_uri = excluded.item_uri,
        annotation_type = excluded.annotation_type,
        page_index = excluded.page_index,
        position_json = excluded.position_json,
        color = excluded.color,
        text = excluded.text,
        comment = excluded.comment,
        sort_index = excluded.sort_index,
        author = excluded.author,
        modified_at = excluded.modified_at,
        version = excluded.version
    `)
    .run(
      record.annotationKey,
      record.labId,
      record.itemUri,
      record.annotationType,
      record.pageIndex,
      record.positionJson,
      record.color ?? null,
      record.text ?? null,
      record.comment ?? null,
      record.sortIndex ?? null,
      record.author ?? null,
      record.modifiedAt ?? null,
      record.version,
    )
}

export function listZoteroAnnotations(
  db: CsLabDatabase,
  labId: string,
  itemUri?: string,
): CsLabZoteroAnnotationRecord[] {
  const rows = itemUri
    ? (db.raw
        .prepare(
          'SELECT * FROM zotero_annotations WHERE lab_id = ? AND item_uri = ? ORDER BY sort_index ASC, page_index ASC',
        )
        .all(labId, itemUri) as Array<Record<string, unknown>>)
    : (db.raw
        .prepare('SELECT * FROM zotero_annotations WHERE lab_id = ? ORDER BY sort_index ASC, page_index ASC')
        .all(labId) as Array<Record<string, unknown>>)

  return rows.map((row) => ({
    annotationKey: String(row.annotation_key),
    labId: String(row.lab_id),
    itemUri: String(row.item_uri),
    annotationType: String(row.annotation_type),
    pageIndex: Number(row.page_index),
    positionJson: String(row.position_json),
    color: row.color == null ? undefined : String(row.color),
    text: row.text == null ? undefined : String(row.text),
    comment: row.comment == null ? undefined : String(row.comment),
    sortIndex: row.sort_index == null ? undefined : String(row.sort_index),
    author: row.author == null ? undefined : String(row.author),
    modifiedAt: row.modified_at == null ? undefined : Number(row.modified_at),
    version: Number(row.version),
  }))
}

export function countZoteroAnnotations(db: CsLabDatabase, labId: string): number {
  const row = db.raw
    .prepare('SELECT COUNT(*) AS count FROM zotero_annotations WHERE lab_id = ?')
    .get(labId) as { count: number } | undefined
  return Number(row?.count ?? 0)
}

export function countAnnotationsForItem(db: CsLabDatabase, labId: string, itemUri: string): number {
  const row = db.raw
    .prepare('SELECT COUNT(*) AS count FROM zotero_annotations WHERE lab_id = ? AND item_uri = ?')
    .get(labId, itemUri) as { count: number } | undefined
  return Number(row?.count ?? 0)
}

export function upsertZoteroCollection(
  db: CsLabDatabase,
  record: CsLabZoteroCollectionRecord,
): void {
  db.raw
    .prepare(`
      INSERT INTO zotero_collections (collection_key, lab_id, name, path, parent_key, version)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection_key) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        parent_key = excluded.parent_key,
        version = excluded.version
    `)
    .run(
      record.collectionKey,
      record.labId,
      record.name,
      record.path,
      record.parentKey ?? null,
      record.version,
    )
}

export function listZoteroCollections(
  db: CsLabDatabase,
  labId: string,
): CsLabZoteroCollectionRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM zotero_collections WHERE lab_id = ? ORDER BY path ASC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    collectionKey: String(row.collection_key),
    labId: String(row.lab_id),
    name: String(row.name),
    path: String(row.path),
    parentKey: row.parent_key == null ? undefined : String(row.parent_key),
    version: Number(row.version),
  }))
}

// ===== 实验规程与批次（Phase 3） =====

export interface CsLabProtocolRecord {
  uri: string
  labId: string
  title: string
  method: string
  version: number
  stepsJson: string
  parametersJson: string
  createdAt: number
  updatedAt: number
}

export interface CsLabRunRecord {
  uri: string
  labId: string
  protocolUri?: string
  protocolTitle?: string
  protocolVersion?: number
  title: string
  batchNo: string
  status: CsLabRunStatus
  startedAt?: number
  endedAt?: number
  operator?: string
  parametersJson: string
  observations: string
  outcome?: string
  linksJson: string
  createdAt: number
  updatedAt: number
}

function rowToProtocol(row: Record<string, unknown>): CsLabProtocolRecord {
  return {
    uri: String(row.uri),
    labId: String(row.lab_id),
    title: String(row.title),
    method: String(row.method),
    version: Number(row.version),
    stepsJson: String(row.steps_json),
    parametersJson: String(row.parameters_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function rowToRun(row: Record<string, unknown>): CsLabRunRecord {
  return {
    uri: String(row.uri),
    labId: String(row.lab_id),
    protocolUri: row.protocol_uri == null ? undefined : String(row.protocol_uri),
    protocolTitle: row.protocol_title == null ? undefined : String(row.protocol_title),
    protocolVersion:
      row.protocol_version == null ? undefined : Number(row.protocol_version),
    title: String(row.title),
    batchNo: String(row.batch_no),
    status: String(row.status) as CsLabRunStatus,
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
    operator: row.operator == null ? undefined : String(row.operator),
    parametersJson: String(row.parameters_json),
    observations: String(row.observations ?? ''),
    outcome: row.outcome == null ? undefined : String(row.outcome),
    linksJson: String(row.links_json ?? '[]'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function upsertProtocol(db: CsLabDatabase, record: CsLabProtocolRecord): void {
  db.raw
    .prepare(`
      INSERT INTO protocols (
        uri, lab_id, title, method, version, steps_json, parameters_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        title = excluded.title,
        method = excluded.method,
        version = excluded.version,
        steps_json = excluded.steps_json,
        parameters_json = excluded.parameters_json,
        updated_at = excluded.updated_at
    `)
    .run(
      record.uri,
      record.labId,
      record.title,
      record.method,
      record.version,
      record.stepsJson,
      record.parametersJson,
      record.createdAt,
      record.updatedAt,
    )
}

export function getProtocolRecord(db: CsLabDatabase, uri: string): CsLabProtocolRecord | null {
  const row = db.raw.prepare('SELECT * FROM protocols WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  return row ? rowToProtocol(row) : null
}

export function listProtocolRecords(db: CsLabDatabase, labId: string): CsLabProtocolRecord[] {
  const rows = db.raw
    .prepare('SELECT * FROM protocols WHERE lab_id = ? ORDER BY updated_at DESC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToProtocol)
}

export function upsertRun(db: CsLabDatabase, record: CsLabRunRecord): void {
  db.raw
    .prepare(`
      INSERT INTO runs (
        uri, lab_id, protocol_uri, protocol_title, protocol_version, title, batch_no,
        status, started_at, ended_at, operator, parameters_json, observations,
        outcome, links_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        protocol_uri = excluded.protocol_uri,
        protocol_title = excluded.protocol_title,
        protocol_version = excluded.protocol_version,
        title = excluded.title,
        batch_no = excluded.batch_no,
        status = excluded.status,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        operator = excluded.operator,
        parameters_json = excluded.parameters_json,
        observations = excluded.observations,
        outcome = excluded.outcome,
        links_json = excluded.links_json,
        updated_at = excluded.updated_at
    `)
    .run(
      record.uri,
      record.labId,
      record.protocolUri ?? null,
      record.protocolTitle ?? null,
      record.protocolVersion ?? null,
      record.title,
      record.batchNo,
      record.status,
      record.startedAt ?? null,
      record.endedAt ?? null,
      record.operator ?? null,
      record.parametersJson,
      record.observations,
      record.outcome ?? null,
      record.linksJson,
      record.createdAt,
      record.updatedAt,
    )
}

export function getRunRecord(db: CsLabDatabase, uri: string): CsLabRunRecord | null {
  const row = db.raw.prepare('SELECT * FROM runs WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  return row ? rowToRun(row) : null
}

export function listRunRecords(
  db: CsLabDatabase,
  labId: string,
  protocolUri?: string,
): CsLabRunRecord[] {
  const rows = protocolUri
    ? (db.raw
        .prepare(
          'SELECT * FROM runs WHERE lab_id = ? AND protocol_uri = ? ORDER BY created_at DESC',
        )
        .all(labId, protocolUri) as Array<Record<string, unknown>>)
    : (db.raw
        .prepare('SELECT * FROM runs WHERE lab_id = ? ORDER BY created_at DESC')
        .all(labId) as Array<Record<string, unknown>>)
  return rows.map(rowToRun)
}

/** 查询某日批次号前缀下的最大批次号，供事务内生成单调递增批次。 */
export function findMaxRunBatchNo(
  db: CsLabDatabase,
  labId: string,
  prefix: string,
): string | null {
  const row = db.raw
    .prepare(
      'SELECT batch_no FROM runs WHERE lab_id = ? AND batch_no LIKE ? ORDER BY LENGTH(batch_no) DESC, batch_no DESC LIMIT 1',
    )
    .get(labId, `${prefix}%`) as { batch_no: string | null } | undefined
  return row?.batch_no ?? null
}

export function decodeRunLinks(record: CsLabRunRecord): CsLabRunLink[] {
  try {
    const parsed = JSON.parse(record.linksJson) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is CsLabRunLink =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as CsLabRunLink).uri === 'string' &&
        typeof (item as CsLabRunLink).title === 'string' &&
        ((item as CsLabRunLink).relation === 'consumes' ||
          (item as CsLabRunLink).relation === 'produces'),
    )
  } catch {
    return []
  }
}

// ===== 实体删除（Vault 同步使用） =====

export function deleteEntity(db: CsLabDatabase, uri: string): void {
  db.raw.prepare('DELETE FROM entities WHERE uri = ?').run(uri)
}

export function deleteEdge(
  db: CsLabDatabase,
  fromUri: string,
  toUri: string,
  relation: string,
): void {
  db.raw
    .prepare('DELETE FROM provenance_edges WHERE from_uri = ? AND to_uri = ? AND relation = ?')
    .run(fromUri, toUri, relation)
}
