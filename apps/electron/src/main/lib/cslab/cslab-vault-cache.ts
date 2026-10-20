/**
 * CSLab Vault 笔记索引缓存（node:sqlite）
 *
 * 每个实验室独立 `db/vault_cache.sqlite`，与 central_meta 完全隔离。
 * payload 使用紧凑 JSON 文本：读取必须 try-catch，坏行回退物理文件重解析。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { assertLabId, resolveLabDir } from './cslab-paths'

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

export interface CsLabVaultCache {
  readonly dbPath: string
  readonly raw: SqliteDatabase
}

export interface CsLabVaultIndexRow {
  relPath: string
  mtimeMs: number
  size: number
  contentHash: string
  payload: string
  updatedAt: number
}

const connections = new Map<string, CsLabVaultCache>()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS vault_index (
  rel_path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_links (
  rel_path TEXT NOT NULL,
  target_key TEXT NOT NULL,
  PRIMARY KEY (rel_path, target_key)
);
CREATE INDEX IF NOT EXISTS idx_vault_links_target ON vault_links(target_key);
`

export function getVaultCachePath(labIdInput: string): string {
  const labId = assertLabId(labIdInput)
  return join(resolveLabDir(labId), 'db', 'vault_cache.sqlite')
}

export function getCsLabVaultCache(labIdInput: string): CsLabVaultCache {
  const dbPath = getVaultCachePath(labIdInput)
  const cached = connections.get(dbPath)
  if (cached) return cached

  const dir = join(dbPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const raw = new DatabaseSync(dbPath)
  raw.exec(SCHEMA_SQL)

  const cache: CsLabVaultCache = { dbPath, raw }
  connections.set(dbPath, cache)
  return cache
}

export function closeCsLabVaultCache(labId: string): void {
  try {
    const dbPath = getVaultCachePath(labId)
    const cached = connections.get(dbPath)
    if (!cached) return
    try {
      cached.raw.close()
    } catch {
      // 已关闭时忽略。
    }
    connections.delete(dbPath)
  } catch {
    // labId 无效或目录已删除，忽略。
  }
}

export function closeAllCsLabVaultCaches(): void {
  for (const [dbPath, cache] of [...connections.entries()]) {
    try {
      cache.raw.close()
    } catch {
      // ignore
    }
    connections.delete(dbPath)
  }
}

function rowToIndex(row: Record<string, unknown>): CsLabVaultIndexRow {
  return {
    relPath: String(row.rel_path),
    mtimeMs: Number(row.mtime_ms),
    size: Number(row.size),
    contentHash: String(row.content_hash),
    payload: String(row.payload),
    updatedAt: Number(row.updated_at),
  }
}

export function getVaultIndexRow(
  cache: CsLabVaultCache,
  relPath: string,
): CsLabVaultIndexRow | null {
  const row = cache.raw.prepare('SELECT * FROM vault_index WHERE rel_path = ?').get(relPath) as
    | Record<string, unknown>
    | undefined
  return row ? rowToIndex(row) : null
}

export function listVaultIndexRows(cache: CsLabVaultCache): CsLabVaultIndexRow[] {
  const rows = cache.raw.prepare('SELECT * FROM vault_index').all() as Array<
    Record<string, unknown>
  >
  return rows.map(rowToIndex)
}

export function upsertVaultIndexRow(cache: CsLabVaultCache, row: CsLabVaultIndexRow): void {
  cache.raw
    .prepare(`
      INSERT INTO vault_index (rel_path, mtime_ms, size, content_hash, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(rel_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        content_hash = excluded.content_hash,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `)
    .run(row.relPath, row.mtimeMs, row.size, row.contentHash, row.payload, row.updatedAt)
}

export function deleteVaultIndexRow(cache: CsLabVaultCache, relPath: string): void {
  cache.raw.prepare('DELETE FROM vault_index WHERE rel_path = ?').run(relPath)
}

export interface VaultLinkEntry {
  relPath: string
  targetKeys: string[]
}

/**
 * 全量重建双链索引表。
 * 不自开事务：必须由调用方的 `withVaultCacheTransaction` 包裹，避免嵌套事务报错。
 */
export function replaceVaultLinks(cache: CsLabVaultCache, entries: VaultLinkEntry[]): void {
  cache.raw.prepare('DELETE FROM vault_links').run()
  const insert = cache.raw.prepare(
    'INSERT OR IGNORE INTO vault_links (rel_path, target_key) VALUES (?, ?)',
  )
  for (const entry of entries) {
    for (const targetKey of new Set(entry.targetKeys)) {
      insert.run(entry.relPath, targetKey)
    }
  }
}

/** 统计指向给定链接键的反链数量；空键集合直接返回 0（SQLite 不支持 IN ()）。 */
export function countVaultBacklinks(
  cache: CsLabVaultCache,
  targetKeys: string[],
  excludeRelPath: string,
): number {
  if (targetKeys.length === 0) return 0
  const placeholders = targetKeys.map(() => '?').join(',')
  const row = cache.raw
    .prepare(
      `SELECT COUNT(DISTINCT rel_path) AS count FROM vault_links
       WHERE target_key IN (${placeholders}) AND rel_path <> ?`,
    )
    .get(...targetKeys, excludeRelPath) as { count?: number } | undefined
  return Number(row?.count ?? 0)
}

export function setVaultMeta(cache: CsLabVaultCache, key: string, value: string): void {
  cache.raw
    .prepare(
      'INSERT INTO vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value)
}

export function getVaultMeta(cache: CsLabVaultCache, key: string): string | null {
  const row = cache.raw.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? String(row.value) : null
}

export function withVaultCacheTransaction<T>(cache: CsLabVaultCache, work: () => T): T {
  cache.raw.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    cache.raw.exec('COMMIT')
    return result
  } catch (error) {
    try {
      cache.raw.exec('ROLLBACK')
    } catch {
      // 可能已自动回滚。
    }
    throw error
  }
}
