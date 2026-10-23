/**
 * CSLab 超算作业上下文库（node:sqlite）
 *
 * 每实验室独立 `db/hpc_jobs.sqlite`：
 * - hpc_profiles：集群档案（口令只存密文）；
 * - hpc_jobs：JobContext（含确定性 UUID），是「关掉应用数天后重水合」的唯一事实源。
 *
 * 红线：本模块只做持久化，不发起任何网络请求。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type {
  CsLabHpcArtifact,
  CsLabHpcJob,
  CsLabHpcJobState,
  CsLabHpcScheduler,
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

export interface CsLabHpcDatabase {
  readonly dbPath: string
  readonly raw: SqliteDatabase
}

export interface CsLabHpcBastionRecord {
  host: string
  port?: number
  username: string
  privateKeyPath?: string
  passphraseCipher?: string
}

export interface CsLabHpcProfileRow {
  id: string
  labId: string
  name: string
  host: string
  port: number
  username: string
  scheduler: CsLabHpcScheduler
  remoteWorkDir: string
  privateKeyPath?: string
  passphraseCipher?: string
  bastion?: CsLabHpcBastionRecord
  updatedAt: number
}

export interface CsLabHpcJobRow {
  key: string
  labId: string
  profileId: string
  jobId?: string
  jobName: string
  uuid: string
  state: CsLabHpcJobState
  remoteWorkDir: string
  submittedAt: number
  lastCheckedAt?: number
  endedAt?: number
  message?: string
  artifacts: CsLabHpcArtifact[]
}

const connections = new Map<string, CsLabHpcDatabase>()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS hpc_profiles (
  id TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  scheduler TEXT NOT NULL,
  remote_work_dir TEXT NOT NULL,
  private_key_path TEXT,
  passphrase_cipher TEXT,
  bastion_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hpc_profiles_lab ON hpc_profiles(lab_id);

CREATE TABLE IF NOT EXISTS hpc_jobs (
  key TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  job_id TEXT,
  job_name TEXT NOT NULL,
  uuid TEXT NOT NULL,
  state TEXT NOT NULL,
  remote_work_dir TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  ended_at INTEGER,
  message TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_hpc_jobs_lab ON hpc_jobs(lab_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hpc_jobs_uuid ON hpc_jobs(lab_id, uuid);
`

export function getHpcDbPath(labIdInput: string): string {
  const labId = assertLabId(labIdInput)
  return join(resolveLabDir(labId), 'db', 'hpc_jobs.sqlite')
}

export function getHpcDatabase(labIdInput: string): CsLabHpcDatabase {
  const dbPath = getHpcDbPath(labIdInput)
  const cached = connections.get(dbPath)
  if (cached) return cached

  const dir = join(dbPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const raw = new DatabaseSync(dbPath)
  raw.exec(SCHEMA_SQL)

  const database: CsLabHpcDatabase = { dbPath, raw }
  connections.set(dbPath, database)
  return database
}

export function closeAllHpcDatabases(): void {
  for (const [dbPath, database] of [...connections.entries()]) {
    try {
      database.raw.close()
    } catch {
      // 进程退出路径，忽略。
    }
    connections.delete(dbPath)
  }
}

/** 只关闭指定实验室的 HPC 数据库连接，避免误伤其它活跃实验室。 */
export function closeHpcDatabase(labIdInput: string): void {
  const dbPath = getHpcDbPath(labIdInput)
  const database = connections.get(dbPath)
  if (!database) return
  try {
    database.raw.close()
  } catch {
    // 可能已被其它路径关闭，忽略。
  }
  connections.delete(dbPath)
}

function asScheduler(raw: unknown): CsLabHpcScheduler {
  return raw === 'pbs' || raw === 'lsf' ? raw : 'slurm'
}

function asState(raw: unknown): CsLabHpcJobState {
  switch (raw) {
    case 'PENDING':
    case 'RUNNING':
    case 'COMPLETED':
    case 'FAILED':
    case 'TIMEOUT':
    case 'CANCELLED':
    case 'UNKNOWN':
      return raw
    default:
      return 'UNKNOWN'
  }
}

function parseBastion(raw: unknown): CsLabHpcBastionRecord | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<CsLabHpcBastionRecord>
    if (!parsed.host || !parsed.username) return undefined
    return {
      host: String(parsed.host),
      port: parsed.port == null ? undefined : Number(parsed.port),
      username: String(parsed.username),
      privateKeyPath: parsed.privateKeyPath ? String(parsed.privateKeyPath) : undefined,
      passphraseCipher: parsed.passphraseCipher ? String(parsed.passphraseCipher) : undefined,
    }
  } catch {
    return undefined
  }
}

function rowToProfile(row: Record<string, unknown>): CsLabHpcProfileRow {
  return {
    id: String(row.id),
    labId: String(row.lab_id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port ?? 22),
    username: String(row.username),
    scheduler: asScheduler(row.scheduler),
    remoteWorkDir: String(row.remote_work_dir),
    privateKeyPath: row.private_key_path == null ? undefined : String(row.private_key_path),
    passphraseCipher:
      row.passphrase_cipher == null ? undefined : String(row.passphrase_cipher),
    bastion: parseBastion(row.bastion_json),
    updatedAt: Number(row.updated_at),
  }
}

function rowToJob(row: Record<string, unknown>): CsLabHpcJobRow {
  let artifacts: CsLabHpcArtifact[] = []
  try {
    const parsed = JSON.parse(String(row.artifacts_json ?? '[]')) as unknown
    if (Array.isArray(parsed)) artifacts = parsed as CsLabHpcArtifact[]
  } catch {
    artifacts = []
  }
  return {
    key: String(row.key),
    labId: String(row.lab_id),
    profileId: String(row.profile_id),
    jobId: row.job_id == null ? undefined : String(row.job_id),
    jobName: String(row.job_name),
    uuid: String(row.uuid),
    state: asState(row.state),
    remoteWorkDir: String(row.remote_work_dir),
    submittedAt: Number(row.submitted_at),
    lastCheckedAt: row.last_checked_at == null ? undefined : Number(row.last_checked_at),
    endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
    message: row.message == null ? undefined : String(row.message),
    artifacts,
  }
}

// ===== 档案 =====

export function listHpcProfileRows(
  db: CsLabHpcDatabase,
  labId: string,
): CsLabHpcProfileRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM hpc_profiles WHERE lab_id = ? ORDER BY name ASC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToProfile)
}

export function getHpcProfileRow(
  db: CsLabHpcDatabase,
  id: string,
): CsLabHpcProfileRow | null {
  const row = db.raw.prepare('SELECT * FROM hpc_profiles WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToProfile(row) : null
}

export function upsertHpcProfileRow(
  db: CsLabHpcDatabase,
  profile: CsLabHpcProfileRow,
): void {
  db.raw
    .prepare(`
      INSERT INTO hpc_profiles (
        id, lab_id, name, host, port, username, scheduler, remote_work_dir,
        private_key_path, passphrase_cipher, bastion_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        port = excluded.port,
        username = excluded.username,
        scheduler = excluded.scheduler,
        remote_work_dir = excluded.remote_work_dir,
        private_key_path = excluded.private_key_path,
        passphrase_cipher = excluded.passphrase_cipher,
        bastion_json = excluded.bastion_json,
        updated_at = excluded.updated_at
    `)
    .run(
      profile.id,
      profile.labId,
      profile.name,
      profile.host,
      profile.port,
      profile.username,
      profile.scheduler,
      profile.remoteWorkDir,
      profile.privateKeyPath ?? null,
      profile.passphraseCipher ?? null,
      profile.bastion ? JSON.stringify(profile.bastion) : null,
      profile.updatedAt,
    )
}

export function deleteHpcProfileRow(db: CsLabHpcDatabase, id: string): void {
  db.raw.prepare('DELETE FROM hpc_profiles WHERE id = ?').run(id)
}

// ===== 作业 =====

export function upsertHpcJobRow(db: CsLabHpcDatabase, job: CsLabHpcJobRow): void {
  db.raw
    .prepare(`
      INSERT INTO hpc_jobs (
        key, lab_id, profile_id, job_id, job_name, uuid, state, remote_work_dir,
        submitted_at, last_checked_at, ended_at, message, artifacts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        job_id = excluded.job_id,
        job_name = excluded.job_name,
        uuid = excluded.uuid,
        state = excluded.state,
        remote_work_dir = excluded.remote_work_dir,
        last_checked_at = excluded.last_checked_at,
        ended_at = excluded.ended_at,
        message = excluded.message,
        artifacts_json = excluded.artifacts_json
    `)
    .run(
      job.key,
      job.labId,
      job.profileId,
      job.jobId ?? null,
      job.jobName,
      job.uuid,
      job.state,
      job.remoteWorkDir,
      job.submittedAt,
      job.lastCheckedAt ?? null,
      job.endedAt ?? null,
      job.message ?? null,
      JSON.stringify(job.artifacts),
    )
}

export function getHpcJobRow(db: CsLabHpcDatabase, key: string): CsLabHpcJobRow | null {
  const row = db.raw.prepare('SELECT * FROM hpc_jobs WHERE key = ?').get(key) as
    | Record<string, unknown>
    | undefined
  return row ? rowToJob(row) : null
}

export function listHpcJobRows(db: CsLabHpcDatabase, labId: string): CsLabHpcJobRow[] {
  const rows = db.raw
    .prepare('SELECT * FROM hpc_jobs WHERE lab_id = ? ORDER BY submitted_at DESC')
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToJob)
}

/** 非终态作业（重水合扫描的输入）。 */
export function listActiveHpcJobRows(
  db: CsLabHpcDatabase,
  labId: string,
): CsLabHpcJobRow[] {
  const rows = db.raw
    .prepare(
      "SELECT * FROM hpc_jobs WHERE lab_id = ? AND state NOT IN ('COMPLETED','FAILED','TIMEOUT','CANCELLED') ORDER BY submitted_at DESC",
    )
    .all(labId) as Array<Record<string, unknown>>
  return rows.map(rowToJob)
}

export function findHpcJobByRemoteId(
  db: CsLabHpcDatabase,
  labId: string,
  jobId: string,
): CsLabHpcJobRow | null {
  const row = db.raw
    .prepare('SELECT * FROM hpc_jobs WHERE lab_id = ? AND job_id = ? LIMIT 1')
    .get(labId, jobId) as Record<string, unknown> | undefined
  return row ? rowToJob(row) : null
}

export function toHpcJob(row: CsLabHpcJobRow): CsLabHpcJob {
  return {
    key: row.key,
    labId: row.labId,
    profileId: row.profileId,
    jobId: row.jobId,
    schedulerJobName: row.jobName,
    uuid: row.uuid,
    state: row.state,
    remoteWorkDir: row.remoteWorkDir,
    submittedAt: row.submittedAt,
    lastCheckedAt: row.lastCheckedAt,
    endedAt: row.endedAt,
    message: row.message,
    artifacts: row.artifacts,
  }
}
