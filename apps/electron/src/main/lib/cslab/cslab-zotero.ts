/**
 * Zotero 6/7 只读增量同步引擎
 *
 * 红线（评审加固 11.1）：
 * 1. 绝不打开真实 `zotero.sqlite`，只读取影子副本；
 * 2. Windows 下 WAL/SHM 可能被 Zotero 独占，复制必须做 EBUSY 重试与只读流降级，
 *    WAL 仍不可读时允许仅基于主库快照继续同步，绝不抛出未捕获异常；
 * 3. 写入仅发生在实验室 central_meta.sqlite，Zotero 源库保持只读。
 */

import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createDebouncer } from './cslab-debounce'
import type {
  CsLabLiteratureItem,
  CsLabZoteroDiscovery,
  CsLabZoteroStatus,
  CsLabZoteroSyncOptions,
  CsLabZoteroSyncResult,
} from '@profer/shared'
import {
  countZoteroAnnotations,
  getCsLabDatabase,
  getLabState,
  getLiteratureSource,
  listLiteratureSources,
  listZoteroCollections,
  listZoteroAnnotations as listStoredAnnotations,
  nextLabRevision,
  setLabState,
  upsertEntity,
  upsertLiteratureSource,
  upsertZoteroAnnotation,
  upsertZoteroCollection,
  withTransaction,
  type CsLabDatabase,
  type CsLabEntityRecord,
  type CsLabLiteratureSourceRecord,
  type CsLabZoteroAnnotationRecord,
} from './cslab-db'
import { assertLabId, resolveLabDir } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import { getLiteratureItem, listLiterature, listLiteratureAnnotations } from './cslab-literature'
import {
  parseZoteroAnnotationPosition,
  resolveZoteroAttachmentPath,
} from './cslab-zotero-format'
import { getZoteroBridgeStatus } from './cslab-zotero-bridge'

/** Zotero 同步单批事务条数：批次间让出事件循环，避免长事务阻塞主进程。 */
const ZOTERO_TX_BATCH_SIZE = 200

// ===== 内部类型 =====

interface SqliteStatement {
  run(...params: unknown[]): unknown
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

interface ZoteroCollectionRow {
  collectionID: number
  collectionKey: string
  collectionName: string
  parentCollectionID: number | null
  path: string
  version: number
}

interface ZoteroItemRow {
  itemID: number
  key: string
  typeName: string
  version: number
  dateModified?: string
  title?: string
  doi?: string
  date?: string
  publicationTitle?: string
  abstractNote?: string
  url?: string
}

interface ZoteroAttachmentRow {
  parentItemID: number
  attachmentKey: string
  path: string
  contentType: string
}

interface ZoteroAnnotationRow {
  annotationKey: string
  parentAttachmentKey: string
  type: unknown
  text?: string
  comment?: string
  color?: string
  sortIndex?: string
  position: string
  author?: string
  modificationTime?: number
  version: number
}

export interface ZoteroWatcherHandle {
  watching: boolean
  message: string
}

interface WatcherLike {
  on(event: string, listener: (...args: unknown[]) => void): void
  close(): Promise<void>
}

interface ActiveWatcher {
  close: () => Promise<void>
  labId: string
  dataDir: string
}

const watchers = new Map<string, ActiveWatcher>()
const syncingLabs = new Set<string>()

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms)
    timer.unref?.()
  })
}

function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

// ===== 数据目录发现 =====

function defaultDataDirCandidates(): string[] {
  const home = homedir()
  const candidates = [join(home, 'Zotero')]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) candidates.push(join(appData, 'Zotero', 'Zotero', 'data'))
  }
  return [...new Set(candidates)]
}

function profileRootCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(appData, 'Zotero', 'Zotero', 'Profiles'), join(appData, 'Zotero', 'Profiles')]
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Zotero', 'Profiles')]
  }
  return [join(home, '.zotero', 'zotero'), join(home, '.zotero', 'zotero', 'Profiles')]
}

interface ParsedPrefs {
  profilePath?: string
  dataDir?: string
  linkedBasePath?: string
}

function parsePrefsFile(content: string): { dataDir?: string; linkedBasePath?: string } {
  const result: { dataDir?: string; linkedBasePath?: string } = {}
  const patterns: Array<[RegExp, 'dataDir' | 'linkedBasePath']> = [
    [/user_pref\(\s*["']extensions\.zotero\.dataDir["']\s*,\s*["']([^"']+)["']\s*\)\s*;/, 'dataDir'],
    [
      /user_pref\(\s*["']extensions\.zotero\.baseAttachmentPath["']\s*,\s*["']([^"']+)["']\s*\)\s*;/,
      'linkedBasePath',
    ],
  ]
  for (const [pattern, key] of patterns) {
    const match = pattern.exec(content)
    if (match?.[1]) {
      // prefs.js 中 Windows 路径通常以双反斜杠或正斜杠混合出现，统一还原。
      result[key] = match[1].replace(/\\\\/g, '\\')
    }
  }
  return result
}

async function discoverProfile(): Promise<ParsedPrefs> {
  for (const root of profileRootCandidates()) {
    if (!existsSync(root)) continue
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const profiles = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort()
    for (const profilePath of profiles) {
      const prefsPath = join(profilePath, 'prefs.js')
      if (!existsSync(prefsPath)) continue
      const content = await fs.readFile(prefsPath, 'utf-8').catch(() => '')
      if (!content) continue
      const parsed = parsePrefsFile(content)
      if (parsed.dataDir || parsed.linkedBasePath) {
        return { profilePath, ...parsed }
      }
    }
    // 某些平台把 prefs.js 直接放在 profileRoot 下。
    const rootPrefs = join(root, 'prefs.js')
    if (existsSync(rootPrefs)) {
      const content = await fs.readFile(rootPrefs, 'utf-8').catch(() => '')
      const parsed = parsePrefsFile(content)
      if (parsed.dataDir || parsed.linkedBasePath) {
        return { profilePath: root, ...parsed }
      }
    }
  }
  return {}
}

async function resolveDataDir(labId: string, override?: string): Promise<{
  dataDir?: string
  preferences: ParsedPrefs
  searched: string[]
}> {
  const db = labDb(labId)
  const remembered = getLabState(db, 'zotero.dataDir')
  const prefs = await discoverProfile()
  const candidates = [
    override?.trim(),
    remembered?.trim(),
    prefs.dataDir?.trim(),
    ...defaultDataDirCandidates(),
  ].filter((candidate): candidate is string => !!candidate)

  const searched: string[] = []
  for (const candidate of candidates) {
    const normalized = resolve(candidate)
    if (searched.includes(normalized)) continue
    searched.push(normalized)
    if (existsSync(join(normalized, 'zotero.sqlite'))) {
      return { dataDir: normalized, preferences: prefs, searched }
    }
  }
  return { dataDir: undefined, preferences: prefs, searched }
}

// ===== 影子副本（EBUSY 防护） =====

async function copyWithRetry(source: string, target: string): Promise<boolean> {
  for (const delay of [0, 100, 200, 400]) {
    if (delay > 0) await sleep(delay)
    try {
      await fs.copyFile(source, target)
      return true
    } catch (error) {
      if (!isBusyError(error)) throw error
    }
  }

  // 只读流复制：libuv 以共享读句柄打开源文件，Windows 下通常可绕过 copyFile 的句柄保护。
  try {
    await fs.rm(target, { force: true })
    await pipeline(createReadStream(source, { flags: 'r' }), createWriteStream(target))
    return true
  } catch (error) {
    if (isBusyError(error)) return false
    throw error
  }
}

interface ShadowRefreshResult {
  shadowPath: string
  walCopied: boolean
  shmCopied: boolean
  degraded: boolean
}

async function refreshZoteroShadow(dataDir: string, labId: string): Promise<ShadowRefreshResult> {
  const shadowDir = join(resolveLabDir(labId), 'db', 'zotero-shadow')
  await fs.mkdir(shadowDir, { recursive: true })
  // 清理旧副本，避免把上一次的 WAL 误认为最新状态。
  for (const entry of await fs.readdir(shadowDir).catch(() => [])) {
    await fs.rm(join(shadowDir, entry), { force: true, recursive: true }).catch(() => undefined)
  }

  const sourceDb = join(dataDir, 'zotero.sqlite')
  const shadowPath = join(shadowDir, 'zotero.sqlite')
  const mainCopied = await copyWithRetry(sourceDb, shadowPath)
  if (!mainCopied) throw new Error('Zotero 主库被占用，无法建立只读影子副本')

  const walSource = `${sourceDb}-wal`
  const shmSource = `${sourceDb}-shm`
  let walCopied = false
  let shmCopied = false

  if (existsSync(walSource)) {
    walCopied = await copyWithRetry(walSource, `${shadowPath}-wal`).catch(() => false)
  }
  if (existsSync(shmSource)) {
    shmCopied = await copyWithRetry(shmSource, `${shadowPath}-shm`).catch(() => false)
  }

  // WAL 未复制成功时删除可能残留的空 shm，让 SQLite 以主库快照打开。
  if (!walCopied) {
    await fs.rm(`${shadowPath}-wal`, { force: true }).catch(() => undefined)
    await fs.rm(`${shadowPath}-shm`, { force: true }).catch(() => undefined)
  }

  return {
    shadowPath,
    walCopied,
    shmCopied,
    degraded: existsSync(walSource) && !walCopied,
  }
}

function openShadow(shadowPath: string): SqliteDatabase {
  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const db = new DatabaseSync(shadowPath)
  db.exec('PRAGMA query_only = ON;')
  db.exec('PRAGMA busy_timeout = 0;')
  return db
}

function tableColumns(db: SqliteDatabase, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
    return rows.map((row) => String(row.name ?? '')).filter(Boolean)
  } catch {
    return []
  }
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined
  return !!row?.name
}

const REQUIRED_TABLES = [
  'items',
  'itemTypes',
  'fields',
  'itemData',
  'itemDataValues',
  'collections',
  'collectionItems',
  'itemAttachments',
  'creators',
  'itemCreators',
]

function probeSchema(db: SqliteDatabase): { ok: boolean; message: string } {
  for (const table of REQUIRED_TABLES) {
    if (!hasTable(db, table)) return { ok: false, message: `Zotero 数据库缺少数据表：${table}` }
  }
  const itemColumns = tableColumns(db, 'items')
  if (!itemColumns.includes('version')) {
    return { ok: false, message: 'Zotero items 表缺少 version 列，无法进行增量同步' }
  }
  return { ok: true, message: '' }
}

// ===== Zotero 查询 =====

function readCollections(db: SqliteDatabase, labId: string): ZoteroCollectionRow[] {
  const collectionColumns = tableColumns(db, 'collections')
  const keySelect = collectionColumns.includes('key')
    ? 'c.key'
    : 'CAST(c.collectionID AS TEXT)'
  const versionSelect = collectionColumns.includes('version') ? 'c.version' : '0'
  const sql = `
    WITH RECURSIVE paths(collectionID, collectionName, parentCollectionID, path) AS (
      SELECT collectionID, collectionName, parentCollectionID, collectionName
      FROM collections WHERE parentCollectionID IS NULL
      UNION ALL
      SELECT c.collectionID, c.collectionName, c.parentCollectionID,
             p.path || ' > ' || c.collectionName
      FROM collections c JOIN paths p ON c.parentCollectionID = p.collectionID
    )
    SELECT p.collectionID AS collectionID, p.collectionName AS collectionName,
           p.parentCollectionID AS parentCollectionID, p.path AS path,
           ${keySelect} AS collectionKey, ${versionSelect} AS version
    FROM paths p JOIN collections c ON c.collectionID = p.collectionID
  `
  const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    collectionID: Number(row.collectionID ?? 0),
    collectionKey: String(row.collectionKey ?? row.collectionID ?? ''),
    collectionName: String(row.collectionName ?? ''),
    parentCollectionID:
      row.parentCollectionID == null ? null : Number(row.parentCollectionID),
    path: String(row.path ?? row.collectionName ?? ''),
    version: Number(row.version ?? 0),
  }))
}

function readItemDeltas(db: SqliteDatabase, cursor: number): ZoteroItemRow[] {
  const sql = `
    SELECT
      i.itemID AS itemID,
      i.key AS key,
      it.typeName AS typeName,
      i.version AS version,
      i.dateModified AS dateModified,
      MAX(CASE WHEN f.fieldName = 'title' THEN v.value END) AS title,
      MAX(CASE WHEN f.fieldName = 'DOI' THEN v.value END) AS doi,
      MAX(CASE WHEN f.fieldName = 'date' THEN v.value END) AS date,
      MAX(CASE WHEN f.fieldName = 'publicationTitle' THEN v.value END) AS publicationTitle,
      MAX(CASE WHEN f.fieldName = 'abstractNote' THEN v.value END) AS abstractNote,
      MAX(CASE WHEN f.fieldName = 'url' THEN v.value END) AS url
    FROM items i
    JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
    LEFT JOIN itemData d ON d.itemID = i.itemID
    LEFT JOIN itemDataValues v ON v.valueID = d.valueID
    LEFT JOIN fields f ON f.fieldID = d.fieldID
    WHERE i.deleted = 0
      AND i.version > ?
      AND it.typeName NOT IN ('attachment', 'note', 'annotation')
    GROUP BY i.itemID
    ORDER BY i.version ASC
  `
  const rows = db.prepare(sql).all(cursor) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    itemID: Number(row.itemID),
    key: String(row.key ?? ''),
    typeName: String(row.typeName ?? ''),
    version: Number(row.version ?? 0),
    dateModified: row.dateModified == null ? undefined : String(row.dateModified),
    title: row.title == null ? undefined : String(row.title),
    doi: row.doi == null ? undefined : String(row.doi),
    date: row.date == null ? undefined : String(row.date),
    publicationTitle:
      row.publicationTitle == null ? undefined : String(row.publicationTitle),
    abstractNote: row.abstractNote == null ? undefined : String(row.abstractNote),
    url: row.url == null ? undefined : String(row.url),
  }))
}

function readDeletedDeltas(db: SqliteDatabase, cursor: number): ZoteroItemRow[] {
  const sql = `
    SELECT i.itemID AS itemID, i.key AS key, i.version AS version
    FROM items i
    WHERE i.deleted = 1 AND i.version > ?
    ORDER BY i.version ASC
  `
  const rows = db.prepare(sql).all(cursor) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    itemID: Number(row.itemID),
    key: String(row.key ?? ''),
    typeName: '',
    version: Number(row.version ?? 0),
  }))
}

function chunkIds(ids: number[]): number[][] {
  const chunks: number[][] = []
  for (let index = 0; index < ids.length; index += 400) {
    chunks.push(ids.slice(index, index + 400))
  }
  return chunks
}

function readAttachments(db: SqliteDatabase, itemIds: number[]): Map<number, ZoteroAttachmentRow> {
  const result = new Map<number, ZoteroAttachmentRow>()
  const attachmentColumns = tableColumns(db, 'itemAttachments')
  const contentTypeSelect = attachmentColumns.includes('contentType')
    ? 'ia.contentType AS contentType'
    : "'' AS contentType"
  const pdfFilter = attachmentColumns.includes('contentType')
    ? "(ia.contentType = 'application/pdf' OR lower(ia.path) LIKE '%.pdf')"
    : "lower(ia.path) LIKE '%.pdf'"

  for (const chunk of chunkIds(itemIds)) {
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    const sql = `
      SELECT ia.parentItemID AS parentItemID, ai.key AS attachmentKey, ia.path AS path,
             ${contentTypeSelect}
      FROM itemAttachments ia
      JOIN items ai ON ai.itemID = ia.itemID
      WHERE ia.parentItemID IN (${placeholders})
        AND ${pdfFilter}
        AND ai.deleted = 0
      ORDER BY ia.parentItemID ASC, ia.itemID ASC
    `
    const rows = db.prepare(sql).all(...chunk) as Array<Record<string, unknown>>
    for (const row of rows) {
      const parentItemID = Number(row.parentItemID)
      if (result.has(parentItemID)) continue
      result.set(parentItemID, {
        parentItemID,
        attachmentKey: String(row.attachmentKey ?? ''),
        path: String(row.path ?? ''),
        contentType: String(row.contentType ?? ''),
      })
    }
  }
  return result
}

/** 中文姓名在 Zotero 中姓存 lastName、名存 firstName，需按姓前名后拼接。 */
const CJK_NAME_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

function formatCreatorName(firstName: string, lastName: string): string {
  if (!firstName && !lastName) return ''
  if (CJK_NAME_RE.test(firstName + lastName)) return `${lastName}${firstName}`.trim()
  return [firstName, lastName].filter(Boolean).join(' ')
}

function readCreators(db: SqliteDatabase, itemIds: number[]): Map<number, string[]> {
  const result = new Map<number, string[]>()
  for (const chunk of chunkIds(itemIds)) {
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    const sql = `
      SELECT ic.itemID AS itemID, ic.orderIndex AS orderIndex,
             c.firstName AS firstName, c.lastName AS lastName
      FROM itemCreators ic
      JOIN creators c ON c.creatorID = ic.creatorID
      WHERE ic.itemID IN (${placeholders})
      ORDER BY ic.itemID ASC, ic.orderIndex ASC
    `
    const rows = db.prepare(sql).all(...chunk) as Array<Record<string, unknown>>
    for (const row of rows) {
      const itemID = Number(row.itemID)
      const firstName = row.firstName == null ? '' : String(row.firstName).trim()
      const lastName = row.lastName == null ? '' : String(row.lastName).trim()
      const name = formatCreatorName(firstName, lastName)
      if (!name) continue
      const list = result.get(itemID) ?? []
      list.push(name)
      result.set(itemID, list)
    }
  }
  return result
}

function readItemCollections(
  db: SqliteDatabase,
  itemIds: number[],
  pathByCollectionId: Map<number, string>,
): Map<number, string[]> {
  const result = new Map<number, string[]>()
  for (const chunk of chunkIds(itemIds)) {
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT itemID, collectionID FROM collectionItems WHERE itemID IN (${placeholders})`)
      .all(...chunk) as Array<Record<string, unknown>>
    for (const row of rows) {
      const itemID = Number(row.itemID)
      const path = pathByCollectionId.get(Number(row.collectionID))
      if (!path) continue
      const list = result.get(itemID) ?? []
      if (!list.includes(path)) list.push(path)
      result.set(itemID, list)
    }
  }
  return result
}

function readAnnotationDeltas(db: SqliteDatabase, cursor: number): ZoteroAnnotationRow[] {
  if (!hasTable(db, 'annotations')) return []
  const columns = tableColumns(db, 'annotations')
  const pick = (...names: string[]): string | undefined => names.find((name) => columns.includes(name))
  const positionColumn = pick('position', 'annotationPosition')
  const typeColumn = pick('type', 'annotationType')
  const textColumn = pick('text')
  const commentColumn = pick('comment')
  const colorColumn = pick('color')
  const sortColumn = pick('sortIndex')
  const authorColumn = pick('authorName')
  const modifiedColumn = pick('annotationModificationTime', 'modificationTime')
  if (!positionColumn) return []

  const expr = (column: string | undefined, alias: string): string =>
    column ? `a.${column} AS ${alias}` : `NULL AS ${alias}`

  const sql = `
    SELECT
      i.key AS annotationKey,
      p.key AS parentAttachmentKey,
      ${typeColumn ? `a.${typeColumn}` : "'highlight'"} AS type,
      ${expr(textColumn, 'text')},
      ${expr(commentColumn, 'comment')},
      ${expr(colorColumn, 'color')},
      ${expr(sortColumn, 'sortIndex')},
      a.${positionColumn} AS position,
      ${expr(authorColumn, 'author')},
      ${modifiedColumn ? `a.${modifiedColumn} AS modificationTime` : 'NULL AS modificationTime'},
      i.version AS version
    FROM annotations a
    JOIN items i ON i.itemID = a.itemID
    LEFT JOIN items p ON p.itemID = a.parentItemID
    WHERE i.version > ? AND i.deleted = 0
    ORDER BY i.version ASC
  `
  const rows = db.prepare(sql).all(cursor) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    annotationKey: String(row.annotationKey ?? ''),
    parentAttachmentKey: String(row.parentAttachmentKey ?? ''),
    type: row.type,
    text: row.text == null ? undefined : String(row.text),
    comment: row.comment == null ? undefined : String(row.comment),
    color: row.color == null ? undefined : String(row.color),
    sortIndex: row.sortIndex == null ? undefined : String(row.sortIndex),
    position: String(row.position ?? ''),
    author: row.author == null ? undefined : String(row.author),
    modificationTime:
      row.modificationTime == null ? undefined : Number(row.modificationTime),
    version: Number(row.version ?? 0),
  }))
}

function readMaxVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS maxVersion FROM items').get() as
    | { maxVersion?: number | null }
    | undefined
  return Number(row?.maxVersion ?? 0)
}

function mapAnnotationType(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
  const numeric = Number(value)
  const table: Record<number, string> = {
    1: 'highlight',
    2: 'note',
    3: 'image',
    4: 'ink',
    5: 'underline',
    6: 'text',
  }
  return table[numeric] ?? 'annotation'
}

function extractYear(date: string | undefined): string | undefined {
  if (!date) return undefined
  const match = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(date)
  return match?.[1]
}

// ===== 发现与状态 =====

export async function getZoteroStatus(labIdInput: string): Promise<CsLabZoteroStatus> {
  const labId = assertLabId(labIdInput)
  const db = labDb(labId)
  const { dataDir } = await resolveDataDir(labId)
  const bridge = await getZoteroBridgeStatus()
  const sources = listLiteratureSources(db, labId)
  const lastSyncedAtRaw = getLabState(db, 'zotero.lastSyncedAt')
  const lastVersionRaw = getLabState(db, 'zotero.lastVersion')
  const watcher = watchers.get(labId)

  if (!dataDir) {
    return {
      availability: 'not-found',
      itemCount: sources.length,
      annotationCount: countZoteroAnnotations(db, labId),
      lastSyncedAt: lastSyncedAtRaw ? Number(lastSyncedAtRaw) : undefined,
      lastVersion: lastVersionRaw ? Number(lastVersionRaw) : undefined,
      watching: !!watcher,
      bridge,
      message: '未找到 zotero.sqlite；请确认 Zotero 已安装并至少启动过一次，或手动选择数据目录',
    }
  }

  return {
    availability: 'ready',
    dataDir,
    itemCount: sources.length,
    annotationCount: countZoteroAnnotations(db, labId),
    lastSyncedAt: lastSyncedAtRaw ? Number(lastSyncedAtRaw) : undefined,
    lastVersion: lastVersionRaw ? Number(lastVersionRaw) : undefined,
    watching: !!watcher,
    bridge,
    message: 'Zotero 数据目录可用（尚未验证库结构时可执行“重新发现”）',
  }
}

export async function discoverZotero(
  labIdInput: string,
  overrideDataDir?: string,
): Promise<CsLabZoteroDiscovery> {
  const labId = assertLabId(labIdInput)
  const status = await getZoteroStatus(labId)
  const { dataDir, preferences, searched } = await resolveDataDir(labId, overrideDataDir)

  if (!dataDir) {
    return {
      status: {
        ...status,
        availability: 'not-found',
        message: `未找到 zotero.sqlite。已检查：${searched.join('；') || '默认路径'}`,
      },
      preferences,
    }
  }

  try {
    const shadow = await refreshZoteroShadow(dataDir, labId)
    const db = openShadow(shadow.shadowPath)
    try {
      const schema = probeSchema(db)
      if (!schema.ok) {
        return {
          status: { ...status, dataDir, availability: 'schema-unsupported', message: schema.message },
          preferences,
        }
      }
    } finally {
      db.close()
    }
    return {
      status: { ...status, dataDir, availability: 'ready', message: 'Zotero 数据库结构校验通过' },
      preferences,
    }
  } catch (error) {
    return {
      status: {
        ...status,
        dataDir,
        availability: 'no-permission',
        message: error instanceof Error ? error.message : '无法读取 Zotero 数据库',
      },
      preferences,
    }
  }
}

export async function setZoteroDataDir(
  labIdInput: string,
  dataDir: string,
): Promise<CsLabZoteroDiscovery> {
  const labId = assertLabId(labIdInput)
  const normalized = resolve(dataDir)
  if (!existsSync(join(normalized, 'zotero.sqlite'))) {
    throw new Error('所选目录下不存在 zotero.sqlite')
  }
  const db = labDb(labId)
  setLabState(db, 'zotero.dataDir', normalized)
  setLabState(db, 'zotero.lastVersion', '0')
  return discoverZotero(labId, normalized)
}

// ===== 同步主流程 =====

function emptySyncResult(message: string): CsLabZoteroSyncResult {
  return {
    ok: false,
    added: 0,
    updated: 0,
    removed: 0,
    annotationCount: 0,
    collectionCount: 0,
    lastVersion: 0,
    message,
  }
}

export async function syncZoteroLibrary(
  labIdInput: string,
  options: CsLabZoteroSyncOptions = {},
): Promise<CsLabZoteroSyncResult> {
  const labId = assertLabId(labIdInput)
  if (syncingLabs.has(labId)) {
    return emptySyncResult('该实验室正在同步中，请稍候')
  }
  syncingLabs.add(labId)

  try {
    const discovery = await discoverZotero(labId, options.dataDir)
    if (discovery.status.availability !== 'ready' || !discovery.status.dataDir) {
      return emptySyncResult(discovery.status.message)
    }
    const dataDir = discovery.status.dataDir
    const shadow = await refreshZoteroShadow(dataDir, labId)
    const shadowDb = openShadow(shadow.shadowPath)
    const labDatabase = labDb(labId)

    try {
      const schema = probeSchema(shadowDb)
      if (!schema.ok) return emptySyncResult(schema.message)

      const forceFull = options.forceFull === true
      const cursorRaw = forceFull ? '0' : getLabState(labDatabase, 'zotero.lastVersion') ?? '0'
      const cursor = Number(cursorRaw) || 0

      const collections = readCollections(shadowDb, labId)
      const pathByCollectionId = new Map<number, string>()
      for (const collection of collections) {
        pathByCollectionId.set(collection.collectionID, collection.path)
      }

      const itemDeltas = readItemDeltas(shadowDb, cursor)
      const deletedDeltas = readDeletedDeltas(shadowDb, cursor)
      const itemIds = itemDeltas.map((item) => item.itemID)
      const attachments = readAttachments(shadowDb, itemIds)
      const creators = readCreators(shadowDb, itemIds)
      const itemCollections = readItemCollections(shadowDb, itemIds, pathByCollectionId)
      const annotationDeltas = readAnnotationDeltas(shadowDb, cursor)
      const maxVersion = readMaxVersion(shadowDb)

      const existingSources = listLiteratureSources(labDatabase, labId)
      const sourceByItemKey = new Map<string, CsLabLiteratureSourceRecord>()
      const sourceByAttachmentKey = new Map<string, CsLabLiteratureSourceRecord>()
      for (const source of existingSources) {
        if (source.zoteroItemKey) sourceByItemKey.set(source.zoteroItemKey, source)
        if (source.zoteroAttachmentKey) {
          sourceByAttachmentKey.set(source.zoteroAttachmentKey, source)
        }
      }

      let added = 0
      let updated = 0
      let removed = 0

      // 事务外预构建：附件路径解析、元数据序列化全部提前完成，事务内只做密集 SQL。
      const preparedItems: Array<{
        existing: boolean
        entityBase: Omit<CsLabEntityRecord, 'revision'>
        source: CsLabLiteratureSourceRecord
      }> = []
      for (const item of itemDeltas) {
        const attachment = attachments.get(item.itemID)
        const pathResult = attachment
          ? resolveZoteroAttachmentPath({
              path: attachment.path,
              attachmentKey: attachment.attachmentKey,
              dataDir,
              linkedBasePath: discovery.preferences.linkedBasePath,
            })
          : undefined
        // 无本地 PDF 的条目仍登记元数据：hasFile 由读取侧按物理存在性计算，
        // 避免只导入 DOI/BibTeX 的文献在 CSLab 中整条消失。
        const absPath = pathResult?.path

        const existing = sourceByItemKey.get(item.key)
        const entityUuid = existing?.uri.split('/').pop() ?? `zotero-${item.key}`
        const uri = existing?.uri ?? buildCsLabUri(labId, 'lit', entityUuid)
        const now = Date.now()
        const authors = creators.get(item.itemID) ?? []
        const collectionsForItem = itemCollections.get(item.itemID) ?? []
        const metadataJson = JSON.stringify({
          authors,
          year: extractYear(item.date),
          doi: item.doi,
          publication: item.publicationTitle,
          abstract: item.abstractNote,
          collections: collectionsForItem,
          url: item.url,
        })

        const source: CsLabLiteratureSourceRecord = {
          uri,
          labId,
          source: 'zotero',
          relPath: undefined,
          absPath,
          zoteroItemKey: item.key,
          zoteroAttachmentKey: attachment?.attachmentKey,
          metadataJson,
          updatedAt: now,
        }
        preparedItems.push({
          existing: Boolean(existing),
          entityBase: {
            uri,
            labId,
            layerType: 'lit',
            entityUuid,
            title: item.title?.trim() || item.key,
            format: 'pdf',
            relPath: undefined,
            sha256: undefined,
            bytes: undefined,
            locked: true,
            createdAt: existing ? existing.updatedAt : now,
            updatedAt: now,
          },
          source,
        })
        // 批注与删除阶段继续复用映射；更新放在事务外，事务内不再做纯计算。
        sourceByItemKey.set(item.key, source)
        if (attachment?.attachmentKey) {
          sourceByAttachmentKey.set(attachment.attachmentKey, source)
        }
      }

      const preparedAnnotations: CsLabZoteroAnnotationRecord[] = []
      for (const row of annotationDeltas) {
        if (!row.annotationKey || !row.parentAttachmentKey) continue
        const source = sourceByAttachmentKey.get(row.parentAttachmentKey)
        if (!source) continue
        const position = parseZoteroAnnotationPosition(row.position)
        if (!position) continue
        preparedAnnotations.push({
          annotationKey: row.annotationKey,
          labId,
          itemUri: source.uri,
          annotationType: mapAnnotationType(row.type),
          pageIndex: position.pageIndex,
          positionJson: row.position,
          color: row.color,
          text: row.text,
          comment: row.comment,
          sortIndex: row.sortIndex,
          author: row.author,
          modifiedAt: row.modificationTime,
          version: row.version,
        })
      }

      // 集合表很小，单独一个短事务。
      withTransaction(labDatabase, () => {
        for (const collection of collections) {
          upsertZoteroCollection(labDatabase, {
            collectionKey: collection.collectionKey,
            labId,
            name: collection.collectionName,
            path: collection.path,
            parentKey:
              collection.parentCollectionID == null
                ? undefined
                : String(collection.parentCollectionID),
            version: collection.version,
          })
        }
      })

      // 文献实体分批写入；批次间让出事件循环，避免长事务阻塞主进程与前台 IPC。
      for (let index = 0; index < preparedItems.length; index += ZOTERO_TX_BATCH_SIZE) {
        const batch = preparedItems.slice(index, index + ZOTERO_TX_BATCH_SIZE)
        withTransaction(labDatabase, () => {
          for (const item of batch) {
            upsertEntity(labDatabase, {
              ...item.entityBase,
              revision: nextLabRevision(labDatabase),
            })
            upsertLiteratureSource(labDatabase, item.source)
            if (item.existing) updated += 1
            else added += 1
          }
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      // 批注必须在文献实体提交后写入，保证外键引用有效。
      for (let index = 0; index < preparedAnnotations.length; index += ZOTERO_TX_BATCH_SIZE) {
        const batch = preparedAnnotations.slice(index, index + ZOTERO_TX_BATCH_SIZE)
        withTransaction(labDatabase, () => {
          for (const annotation of batch) {
            upsertZoteroAnnotation(labDatabase, annotation)
          }
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      for (const deleted of deletedDeltas) {
        const source = sourceByItemKey.get(deleted.key)
        if (!source) continue
        const entity = getEntityForLab(labDatabase, source.uri)
        if (!entity) continue
        withTransaction(labDatabase, () => {
          upsertEntity(labDatabase, {
            ...entity,
            revision: nextLabRevision(labDatabase),
            unsupported: 'Zotero 中已删除',
            updatedAt: Date.now(),
          })
        })
        removed += 1
      }

      // 全部批次成功后才推进游标；中途失败保持旧游标，下次同步幂等重放。
      withTransaction(labDatabase, () => {
        setLabState(labDatabase, 'zotero.lastVersion', String(Math.max(cursor, maxVersion)))
        setLabState(labDatabase, 'zotero.lastSyncedAt', String(Date.now()))
        setLabState(labDatabase, 'zotero.dataDir', dataDir)
      })

      const annotationCount = countZoteroAnnotations(labDatabase, labId)
      const collectionCount = listZoteroCollections(labDatabase, labId).length
      const messageParts: string[] = []
      if (shadow.degraded) {
        messageParts.push('WAL 暂被 Zotero 锁定，本次同步基于主库快照')
      }
      messageParts.push(`新增 ${added} 篇，更新 ${updated} 篇，批注 ${annotationCount} 条`)
      return {
        ok: true,
        added,
        updated,
        removed,
        annotationCount,
        collectionCount,
        lastVersion: Math.max(cursor, maxVersion),
        message: messageParts.join('；'),
      }
    } finally {
      shadowDb.close()
    }
  } catch (error) {
    return emptySyncResult(
      error instanceof Error ? error.message : 'Zotero 同步失败（未知错误）',
    )
  } finally {
    syncingLabs.delete(labId)
  }
}

function getEntityForLab(db: CsLabDatabase, uri: string): CsLabEntityRecord | null {
  const row = db.raw.prepare('SELECT * FROM entities WHERE uri = ?').get(uri) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    uri: String(row.uri),
    labId: String(row.lab_id),
    layerType: String(row.layer_type) as CsLabEntityRecord['layerType'],
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

// ===== 对外列表 API =====

export function listZoteroLiterature(labIdInput: string): CsLabLiteratureItem[] {
  return listLiterature(labIdInput)
}

export function listLiteratureZoteroAnnotations(
  labIdInput: string,
  literatureUri: string,
): ReturnType<typeof listLiteratureAnnotations> {
  return listLiteratureAnnotations(labIdInput, literatureUri)
}

export function getZoteroLiteratureItem(
  labIdInput: string,
  uri: string,
): CsLabLiteratureItem | null {
  return getLiteratureItem(labIdInput, uri)
}

/** 读取已登记来源（供路由层做 URL 注册）。 */
export function getZoteroSource(labIdInput: string, uri: string) {
  return getLiteratureSource(labDb(assertLabId(labIdInput)), uri)
}

export function listStoredZoteroAnnotations(labIdInput: string, uri?: string) {
  return listStoredAnnotations(labDb(assertLabId(labIdInput)), assertLabId(labIdInput), uri)
}

// ===== WAL 监听（Chokidar） =====

export async function startZoteroWatcher(
  labIdInput: string,
  onChange: (result: CsLabZoteroSyncResult) => void,
): Promise<ZoteroWatcherHandle> {
  const labId = assertLabId(labIdInput)
  const existing = watchers.get(labId)
  if (existing) return { watching: true, message: '监听已开启' }

  const discovery = await discoverZotero(labId)
  if (discovery.status.availability !== 'ready' || !discovery.status.dataDir) {
    return { watching: false, message: discovery.status.message }
  }
  const dataDir = discovery.status.dataDir

  try {
    const module = (await import('chokidar')) as unknown as {
      watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike
      default?: { watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike }
    }
    const watch = module.watch ?? module.default?.watch
    if (!watch) return { watching: false, message: 'Chokidar 不可用，无法监听 Zotero' }

    const watcher = watch(
      [join(dataDir, 'zotero.sqlite-wal'), join(dataDir, 'zotero.sqlite')],
      {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignorePermissionErrors: true,
      },
    )

    let running = false
    const debounced = createDebouncer(
      () => {
        if (running) return
        running = true
        void syncZoteroLibrary(labId)
          .then((result) => {
            if (result.ok) onChange(result)
          })
          .catch((error: unknown) => {
            console.warn('[CSLab] Zotero WAL 自动同步失败:', error)
          })
          .finally(() => {
            running = false
          })
      },
      350,
      1500,
    )

    watcher.on('add', debounced)
    watcher.on('change', debounced)

    watchers.set(labId, {
      labId,
      dataDir,
      close: async () => {
        debounced.cancel()
        await watcher.close()
      },
    })
    return { watching: true, message: '已监听 Zotero WAL 变更' }
  } catch (error) {
    return {
      watching: false,
      message: error instanceof Error ? error.message : '无法启动 Zotero 监听',
    }
  }
}

export async function stopZoteroWatcher(labIdInput: string): Promise<{ watching: boolean }> {
  const labId = assertLabId(labIdInput)
  const watcher = watchers.get(labId)
  if (!watcher) return { watching: false }
  await watcher.close().catch(() => undefined)
  watchers.delete(labId)
  return { watching: false }
}

export async function stopAllZoteroWatchers(): Promise<void> {
  for (const watcher of watchers.values()) {
    await watcher.close().catch(() => undefined)
  }
  watchers.clear()
}

/** 测试辅助：当前是否监听。 */
export function isZoteroWatching(labIdInput: string): boolean {
  return watchers.has(assertLabId(labIdInput))
}

/** 测试辅助：清空所有监听。 */
export async function __resetZoteroWatchersForTest(): Promise<void> {
  await stopAllZoteroWatchers()
}
