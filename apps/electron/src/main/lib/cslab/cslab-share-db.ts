/**
 * CSLab 局域网共享盘观测库（node:sqlite）
 *
 * 每实验室独立 `db/share_watch.sqlite`，与 central_meta 隔离：
 * - share_sources：源配置、水位、扫描状态（WebDAV 密码仅存密文）；
 * - share_candidates：逐文件生命周期（含租约证据与重试退避）。
 *
 * 红线：本模块只做持久化，不做任何网络/文件系统探测。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type {
  CsLabShareCandidate,
  CsLabShareCandidateState,
  CsLabShareEvidence,
  CsLabShareKind,
  CsLabShareLeaseType,
  CsLabShareSourceStatus,
} from '@profer/shared'
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

export interface CsLabShareDatabase {
  readonly dbPath: string
  readonly raw: SqliteDatabase
}

export interface CsLabShareSourceRow {
  id: string
  labId: string
  label: string
  kind: CsLabShareKind
  rootPath: string
  include: string[]
  quietSeconds: number
  pollSeconds: number
  username?: string
  secretCipher?: string
  watermarkMs?: number
  lastScanAt?: number
  status: CsLabShareSourceStatus
  message?: string
}

export interface CsLabShareCandidateRow {
  id: string
  labId: string
  sourceId: string
  relPath: string
  size: number
  mtimeMs: number
  fingerprint: string
  state: CsLabShareCandidateState
  leaseType: CsLabShareLeaseType
  evidence?: CsLabShareEvidence
  attempts: number
  nextAttemptAt?: number
  sha256?: string
  assetUri?: string
  message?: string
  updatedAt: number
}

const connections = new Map<string, CsLabShareDatabase>()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS share_sources (
  id TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_path TEXT NOT NULL,
  include_json TEXT NOT NULL DEFAULT '[]',
  quiet_seconds INTEGER NOT NULL DEFAULT 45,
  poll_seconds INTEGER NOT NULL DEFAULT 30,
  username TEXT,
  secret_cipher TEXT,
  watermark_ms INTEGER,
  last_scan_at INTEGER,
  status TEXT NOT NULL DEFAULT 'offline',
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_sources_lab ON share_sources(lab_id);

CREATE TABLE IF NOT EXISTS share_candidates (
  id TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_type TEXT NOT NULL DEFAULT 'pending',
  evidence TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  sha256 TEXT,
  asset_uri TEXT,
  message TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_candidate_path ON share_candidates(source_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_share_candidate_lab ON share_candidates(lab_id, state);
`

export function getShareDbPath(labIdInput: string): string {
  const labId = assertLabId(labIdInput)
  return join(resolveLabDir(labId), 'db', 'share_watch.sqlite')
}

export function getShareDatabase(labIdInput: string): CsLabShareDatabase {
  const dbPath = getShareDbPath(labIdInput)
  const cached = connections.get(dbPath)
  if (cached) return cached

  const dir = join(dbPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const raw = new DatabaseSync(dbPath)
  raw.exec(SCHEMA_SQL)

  const database: CsLabShareDatabase = { dbPath, raw }
  connections.set(dbPath, database)
  return database
}

export function closeAllShareDatabases(): void {
  for (const [dbPath, database] of [...connections.entries()]) {
    try {
      database.raw.close()
    } catch {
      // 进程退出路径，忽略。
    }
    connections.delete(dbPath)
  }
}

/** 只关闭指定实验室的共享盘数据库连接，避免误伤其它活跃实验室。 */
export function closeShareDatabase(labIdInput: string): void {
  const dbPath = getShareDbPath(labIdInput)
  const database = connections.get(dbPath)
  if (!database) return
  try {
    database.raw.close()
  } catch {
    // 可能已被其它路径关闭，忽略。
  }
  connections.delete(dbPath)
}

function parseInclude(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function asKind(raw: unknown): CsLabShareKind {
  return raw === 'unc' || raw === 'webdav' ? raw : 'local'
}

function asStatus(raw: unknown): CsLabShareSourceStatus {
  return raw === 'online' || raw === 'error' ? raw : 'offline'
}

function asCandidateState(raw: unknown): CsLabShareCandidateState {
  switch (raw) {
    case 'observed':
    case 'debouncing':
    case 'capturing':
    case 'published':
    case 'retry':
    case 'quarantined':
      return raw
    default:
      return 'observed'
  }
}

function asLeaseType(raw: unknown): CsLabShareLeaseType {
  switch (raw) {
    case 'protected-lease':
    case 'inline-command-lease':
    case 'node-stream-stability':
      return raw
    default:
      return 'pending'
  }
}

function asEvidence(raw: unknown): CsLabShareEvidence | undefined {
  return raw === 'protected-lease' || raw === 'quiet-interval' || raw === 'eof'
    ? raw
    : undefined
}

function rowToSource(row: Record<string, unknown>): CsLabShareSourceRow {
  return {
    id: String(row.id),
    labId: String(row.lab_id),
    label: String(row.label),
    kind: asKind(row.kind),
    rootPath: String(row.root_path),
    include: parseInclude(row.include_json),
    quietSeconds: Number(row.quiet_seconds ?? 45),
    pollSeconds: Number(row.poll_seconds ?? 30),
    username: row.username == null ? undefined : String(row.username),
    secretCipher: row.secret_cipher == null ? undefined : String(row.secret_cipher),
    watermarkMs: row.watermark_ms == null ? undefined : Number(row.watermark_ms),
    lastScanAt: row.last_scan_at == null ? undefined : Number(row.last_scan_at),
    status: asStatus(row.status),
    message: row.message == null ? undefined : String(row.message),
  }
}

function rowToCandidate(row: Record<string, unknown>): CsLabShareCandidateRow {
  return {
    id: String(row.id),
    labId: String(row.lab_id),
    sourceId: String(row.source_id),
    relPath: String(row.rel_path),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    fingerprint: String(row.fingerprint),
    state: asCandidateState(row.state),
    leaseType: asLeaseType(row.lease_type),
    evidence: asEvidence(row.evidence),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at == null ? undefined : Number(row.next_attempt_at),
    sha256: row.sha256 == null ? undefined : String(row.sha256),
    assetUri: row.asset_uri == null ? undefined : String(row.asset_uri),
    message: row.message == null ? undefined : String(row.message),
    updatedAt: Number(row.updated_at),
  }
}

// ===== 源 =====

export function listShareSourceRows(
  db: CsLabShareDatabase,
  labId: string,
): CsLabShareSourceRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM share_sources WHERE lab_id = ? ORDER BY label ASC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToSource)
}

export function getShareSourceRow(
  db: CsLabShareDatabase,
  id: string,
): CsLabShareSourceRow | null {
  const row = db.raw.prepare('SELECT * FROM share_sources WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToSource(row) : null
}

export function upsertShareSourceRow(db: CsLabShareDatabase, source: CsLabShareSourceRow): void {
  db.raw
    .prepare(`
      INSERT INTO share_sources (
        id, lab_id, label, kind, root_path, include_json, quiet_seconds, poll_seconds,
        username, secret_cipher, watermark_ms, last_scan_at, status, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        kind = excluded.kind,
        root_path = excluded.root_path,
        include_json = excluded.include_json,
        quiet_seconds = excluded.quiet_seconds,
        poll_seconds = excluded.poll_seconds,
        username = excluded.username,
        secret_cipher = excluded.secret_cipher,
        watermark_ms = excluded.watermark_ms,
        last_scan_at = excluded.last_scan_at,
        status = excluded.status,
        message = excluded.message
    `)
    .run(
      source.id,
      source.labId,
      source.label,
      source.kind,
      source.rootPath,
      JSON.stringify(source.include),
      source.quietSeconds,
      source.pollSeconds,
      source.username ?? null,
      source.secretCipher ?? null,
      source.watermarkMs ?? null,
      source.lastScanAt ?? null,
      source.status,
      source.message ?? null,
    )
}

export function updateShareSourceStatus(
  db: CsLabShareDatabase,
  id: string,
  patch: {
    status?: CsLabShareSourceStatus
    /** null 表示显式清除历史错误信息。 */
    message?: string | null
    watermarkMs?: number
    lastScanAt?: number
  },
): void {
  const current = getShareSourceRow(db, id)
  if (!current) return
  upsertShareSourceRow(db, {
    ...current,
    status: patch.status ?? current.status,
    message:
      patch.message === null
        ? undefined
        : patch.message === undefined
          ? current.message
          : patch.message,
    watermarkMs: patch.watermarkMs ?? current.watermarkMs,
    lastScanAt: patch.lastScanAt ?? current.lastScanAt,
  })
}

export function deleteShareSourceRow(db: CsLabShareDatabase, id: string): void {
  db.raw.prepare('DELETE FROM share_candidates WHERE source_id = ?').run(id)
  db.raw.prepare('DELETE FROM share_sources WHERE id = ?').run(id)
}

// ===== 候选 =====

export function upsertShareCandidateRow(
  db: CsLabShareDatabase,
  candidate: CsLabShareCandidateRow,
): void {
  db.raw
    .prepare(`
      INSERT INTO share_candidates (
        id, lab_id, source_id, rel_path, size, mtime_ms, fingerprint, state, lease_type,
        evidence, attempts, next_attempt_at, sha256, asset_uri, message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, rel_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        fingerprint = excluded.fingerprint,
        state = excluded.state,
        lease_type = excluded.lease_type,
        evidence = excluded.evidence,
        attempts = excluded.attempts,
        next_attempt_at = excluded.next_attempt_at,
        sha256 = excluded.sha256,
        asset_uri = excluded.asset_uri,
        message = excluded.message,
        updated_at = excluded.updated_at
    `)
    .run(
      candidate.id,
      candidate.labId,
      candidate.sourceId,
      candidate.relPath,
      candidate.size,
      candidate.mtimeMs,
      candidate.fingerprint,
      candidate.state,
      candidate.leaseType,
      candidate.evidence ?? null,
      candidate.attempts,
      candidate.nextAttemptAt ?? null,
      candidate.sha256 ?? null,
      candidate.assetUri ?? null,
      candidate.message ?? null,
      candidate.updatedAt,
    )
}

export function listShareCandidateRows(
  db: CsLabShareDatabase,
  labId: string,
  sourceId?: string,
): CsLabShareCandidateRow[] {
  const rows = sourceId
    ? (db.raw
        .prepare(
          'SELECT * FROM share_candidates WHERE lab_id = ? AND source_id = ? ORDER BY updated_at DESC',
        )
        .all(labId, sourceId) as Array<Record<string, unknown>>)
    : (db.raw
        .prepare('SELECT * FROM share_candidates WHERE lab_id = ? ORDER BY updated_at DESC')
        .all(labId) as Array<Record<string, unknown>>)
  return rows.map(rowToCandidate)
}

export function getShareCandidateRow(
  db: CsLabShareDatabase,
  sourceId: string,
  relPath: string,
): CsLabShareCandidateRow | null {
  const row = db.raw
    .prepare('SELECT * FROM share_candidates WHERE source_id = ? AND rel_path = ?')
    .get(sourceId, relPath) as Record<string, unknown> | undefined
  return row ? rowToCandidate(row) : null
}

export function findPublishedCandidateBySha(
  db: CsLabShareDatabase,
  sourceId: string,
  sha256: string,
): CsLabShareCandidateRow | null {
  const row = db.raw
    .prepare(
      "SELECT * FROM share_candidates WHERE source_id = ? AND sha256 = ? AND state = 'published' LIMIT 1",
    )
    .get(sourceId, sha256) as Record<string, unknown> | undefined
  return row ? rowToCandidate(row) : null
}

export function countShareCandidates(db: CsLabShareDatabase, sourceId: string): number {
  const row = db.raw
    .prepare('SELECT COUNT(*) AS count FROM share_candidates WHERE source_id = ?')
    .get(sourceId) as { count: number } | undefined
  return Number(row?.count ?? 0)
}

export function toShareCandidate(row: CsLabShareCandidateRow): CsLabShareCandidate {
  return {
    id: row.id,
    sourceId: row.sourceId,
    relPath: row.relPath,
    size: row.size,
    mtimeMs: row.mtimeMs,
    fingerprint: row.fingerprint,
    state: row.state,
    leaseType: row.leaseType,
    evidence: row.evidence,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    sha256: row.sha256,
    assetUri: row.assetUri,
    message: row.message,
    updatedAt: row.updatedAt,
  }
}
