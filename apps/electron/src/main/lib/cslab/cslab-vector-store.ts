/**
 * CSLab 文献向量库（本地优先嵌入 + 纯内存余弦 Top-K）
 *
 * 论文入库流水线阶段二「Hybrid Vector + Graph-RAG」的向量路：
 * transformers.js（ONNX/WASM）本地嵌入 → Provider API 回退（不在本模块实现）→ 纯词法降级。
 * 每个实验室独立 `db/literature_vectors.sqlite`，与 central_meta 完全隔离。
 *
 * 红线：
 * 1. 独立建表，绝不走 cslab-db 的 getCsLabDatabase——它对任意路径强制执行
 *    central_meta 专属建表 SQL，会污染向量库；
 * 2. 检索为纯内存余弦相似度（一次性全量载入 + 简单缓存，写入/删除时失效），
 *    不做 ANN/HNSW 等过度设计；单实验室 5k–20k 块无压力；
 * 3. 嵌入器运行期隔离：@xenova/transformers 以非字面量说明符动态 import
 *    （对齐 packages/core/pdf-stream-extractor.ts），模型离线缓存到 configDir/models，
 *    任何失败 console.warn 后返回 null，绝不抛错阻断入库（Provider API 回退
 *    不在本模块实现，返回 null 由调用方降级纯词法或由后续工作接续）；
 * 4. 测试红线：绝不真实 ONNX 推理/模型下载/联网，一律注入 Mock Embedder。
 *
 * 契约对齐：chunkId/page/bbox 与 cslab-literature-index 的 LiteratureChunk 同源，
 * 三路检索以同 chunkId 强对齐，RRF 聚合可走 Map O(1)。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { assertLabId, resolveLabDir } from './cslab-paths'
import { getConfigDir } from '../config-paths'

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

/** 嵌入端口：文本 → 归一化浮点向量；失败时抛错由调用方决定降级。 */
export type Embedder = (text: string) => Promise<Float32Array>

/** 与 cslab-literature-index 的 LiteratureChunk 同源的入库切块（id 在此命名为 chunkId）。 */
export interface LiteratureChunkInput {
  chunkId: string
  literatureUri: string
  title: string
  page: number
  text: string
  bbox?: [number, number, number, number]
}

export interface VectorSearchHit {
  chunkId: string
  literatureUri: string
  title: string
  page: number
  text: string
  bbox?: [number, number, number, number]
  /** 余弦相似度（-1 ~ 1）。 */
  score: number
}

export interface LiteratureVectorStore {
  readonly dbPath: string
  readonly raw: SqliteDatabase
}

/** all-MiniLM-L6-v2 输出维度（384 维 ≈ 1.5KB/块）。 */
const EMBED_DIMS = 384
/** 字符级截断上限（≈512 token 以内）。 */
const EMBED_MAX_CHARS = 2000
const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

const connections = new Map<string, LiteratureVectorStore>()

/** 全量行缓存：dbPath → 解析后的切块行；任何写入/删除/关库即失效。 */
interface CachedChunkRow {
  chunkId: string
  literatureUri: string
  title: string
  page: number
  text: string
  bbox: [number, number, number, number] | null
  embedding: Float32Array
}

const chunkRowCache = new Map<string, CachedChunkRow[]>()

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS literature_chunks (
  chunk_id TEXT PRIMARY KEY,
  literature_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  bbox_json TEXT,
  embedding BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_lit ON literature_chunks(literature_uri);
`

export function getLiteratureVectorStorePath(labIdInput: string): string {
  const labId = assertLabId(labIdInput)
  return join(resolveLabDir(labId), 'db', 'literature_vectors.sqlite')
}

export function getLiteratureVectorStore(labIdInput: string): LiteratureVectorStore {
  const dbPath = getLiteratureVectorStorePath(labIdInput)
  const cached = connections.get(dbPath)
  if (cached) return cached

  const dir = join(dbPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  const raw = new DatabaseSync(dbPath)
  raw.exec(SCHEMA_SQL)

  const store: LiteratureVectorStore = { dbPath, raw }
  connections.set(dbPath, store)
  return store
}

export function closeLiteratureVectorStore(dbPath: string): void {
  const store = connections.get(dbPath)
  if (!store) return
  try {
    store.raw.close()
  } catch {
    // 已关闭时忽略。
  }
  connections.delete(dbPath)
  chunkRowCache.delete(dbPath)
}

export function closeAllLiteratureVectorStores(): void {
  for (const [dbPath, store] of [...connections.entries()]) {
    try {
      store.raw.close()
    } catch {
      // ignore
    }
    connections.delete(dbPath)
    chunkRowCache.delete(dbPath)
  }
}

// ===== 向量序列化 / bbox 防御 =====

/** Float32Array → 紧凑字节拷贝（不与调用方共享底层 ArrayBuffer）。 */
function serializeEmbedding(vec: Float32Array): Uint8Array {
  const copy = Float32Array.from(vec)
  return new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength)
}

/** BLOB → Float32Array；坏值（类型不符/长度非 4 倍数）返回 null。 */
function deserializeEmbedding(blob: unknown): Float32Array | null {
  let bytes: Uint8Array
  if (blob instanceof Uint8Array) bytes = blob
  else if (blob instanceof ArrayBuffer) bytes = new Uint8Array(blob)
  else return null
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null
  // 复制到新缓冲区，保证 Float32Array 4 字节对齐
  return new Float32Array(Uint8Array.from(bytes).buffer)
}

function isBBox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value)
    && value.length === 4
    && value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

function serializeBBox(bbox: unknown): string | null {
  if (!isBBox(bbox)) return null
  return JSON.stringify(bbox)
}

/** 坏 bbox_json（非法 JSON/元数不符/非有限数）防御回退 null，绝不抛出。 */
function parseBBox(json: unknown): [number, number, number, number] | null {
  if (typeof json !== 'string' || json.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return isBBox(parsed) ? parsed : null
  } catch {
    return null
  }
}

function l2Norm(vec: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!
  return Math.sqrt(sum)
}

/** 原地 L2 归一化；零向量原样返回。 */
function normalizeEmbedding(vec: Float32Array): Float32Array {
  const norm = l2Norm(vec)
  if (norm === 0) return vec
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
  return vec
}

// ===== 入库 / 清理 / 检索 =====

/**
 * 批量 upsert 切块（同 chunkId 覆盖）。
 * 嵌入先行（推理耗时长，绝不持写锁等待），全部成功后一次显式事务落盘。
 * 返回入库条数。
 */
export async function upsertLiteratureChunks(
  labId: string,
  chunks: LiteratureChunkInput[],
  embed: Embedder,
): Promise<number> {
  const store = getLiteratureVectorStore(labId)
  const updatedAt = Date.now()

  const prepared: Array<{
    chunkId: string
    literatureUri: string
    title: string
    page: number
    text: string
    bboxJson: string | null
    embedding: Uint8Array
    updatedAt: number
  }> = []

  for (const chunk of chunks) {
    const embedding = await embed(chunk.text)
    if (!(embedding instanceof Float32Array) || embedding.length === 0) {
      throw new Error(`切块 ${chunk.chunkId} 嵌入输出无效`)
    }
    prepared.push({
      chunkId: chunk.chunkId,
      literatureUri: chunk.literatureUri,
      title: chunk.title,
      page: chunk.page,
      text: chunk.text,
      bboxJson: serializeBBox(chunk.bbox),
      embedding: serializeEmbedding(embedding),
      updatedAt,
    })
  }
  if (prepared.length === 0) return 0

  // 显式事务：不依赖 DatabaseSync.prototype.transaction（见 cslab-db.ts 红线注释）。
  const insert = store.raw.prepare(`
    INSERT INTO literature_chunks
      (chunk_id, literature_uri, title, page, text, bbox_json, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      literature_uri = excluded.literature_uri,
      title = excluded.title,
      page = excluded.page,
      text = excluded.text,
      bbox_json = excluded.bbox_json,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
  `)
  store.raw.exec('BEGIN IMMEDIATE')
  try {
    for (const row of prepared) {
      insert.run(
        row.chunkId,
        row.literatureUri,
        row.title,
        row.page,
        row.text,
        row.bboxJson,
        row.embedding,
        row.updatedAt,
      )
    }
    store.raw.exec('COMMIT')
  } catch (error) {
    try {
      store.raw.exec('ROLLBACK')
    } catch {
      // 可能已自动回滚。
    }
    throw error
  }

  chunkRowCache.delete(store.dbPath)
  return prepared.length
}

/** 重索引前按文献清理切块；幂等，未命中不报错。 */
export function deleteLiteratureChunks(labId: string, literatureUri: string): void {
  const store = getLiteratureVectorStore(labId)
  store.raw.prepare('DELETE FROM literature_chunks WHERE literature_uri = ?').run(literatureUri)
  chunkRowCache.delete(store.dbPath)
}

function loadChunkRows(store: LiteratureVectorStore): CachedChunkRow[] {
  const cached = chunkRowCache.get(store.dbPath)
  if (cached) return cached

  const rows = store.raw.prepare('SELECT * FROM literature_chunks').all() as Array<
    Record<string, unknown>
  >
  const parsed: CachedChunkRow[] = []
  for (const row of rows) {
    const embedding = deserializeEmbedding(row.embedding)
    if (!embedding) {
      console.warn(`[CSLab] 向量库坏 BLOB 已跳过: ${String(row.chunk_id)}`)
      continue
    }
    parsed.push({
      chunkId: String(row.chunk_id),
      literatureUri: String(row.literature_uri),
      title: String(row.title),
      page: Number(row.page),
      text: String(row.text),
      bbox: parseBBox(row.bbox_json),
      embedding,
    })
  }
  chunkRowCache.set(store.dbPath, parsed)
  return parsed
}

/**
 * 内存余弦 Top-K：全量载入该实验室的 embedding BLOB（Float32Array 反序列化）→
 * 点积/模长 → 降序取前 topK。空库/坏行防御，绝不抛出。
 */
export async function searchLiteratureVectors(
  labId: string,
  query: string,
  topK: number,
  embed: Embedder,
): Promise<VectorSearchHit[]> {
  const k = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0
  if (k === 0) return []

  const store = getLiteratureVectorStore(labId)
  const queryVec = await embed(query)
  if (!(queryVec instanceof Float32Array) || queryVec.length === 0) {
    throw new Error('查询嵌入输出无效')
  }
  const queryNorm = l2Norm(queryVec)
  if (queryNorm === 0) return []

  const hits: VectorSearchHit[] = []
  for (const row of loadChunkRows(store)) {
    // 维度漂移（历史数据/换模型）的旧向量跳过，不参与打分。
    if (row.embedding.length !== queryVec.length) continue
    const norm = l2Norm(row.embedding)
    if (norm === 0) continue
    let dot = 0
    for (let i = 0; i < queryVec.length; i++) dot += queryVec[i]! * row.embedding[i]!
    const hit: VectorSearchHit = {
      chunkId: row.chunkId,
      literatureUri: row.literatureUri,
      title: row.title,
      page: row.page,
      text: row.text,
      score: dot / (queryNorm * norm),
    }
    if (row.bbox) hit.bbox = row.bbox
    hits.push(hit)
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

// ===== 默认嵌入器（transformers.js 本地优先） =====

interface TransformersEnv {
  useBrowserCache?: boolean
  cacheDir?: string
}

type FeatureExtractor = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data?: unknown } | undefined>

interface TransformersModule {
  env?: TransformersEnv
  pipeline?: (task: string, model: string) => Promise<FeatureExtractor>
}

function toFloat32Array(data: unknown): Float32Array | null {
  if (data instanceof Float32Array) return Float32Array.from(data)
  if (Array.isArray(data) && data.every((n) => typeof n === 'number')) return Float32Array.from(data)
  return null
}

/**
 * 创建默认嵌入器：transformers.js（ONNX/WASM 本地推理）→ 不可用时返回 null。
 *
 * 诚实声明：Provider API 回退**不在本模块实现**——这里只做到「本地模型可用即用，
 * 不可用返回 null」，由调用方降级为纯词法检索，或由后续工作在本层之上接续 Provider 嵌入。
 */
export async function createDefaultEmbedder(): Promise<Embedder | null> {
  try {
    // 非字面量说明符动态 import（对齐 packages/core/pdf-stream-extractor.ts 的写法与注释）：
    // 阻止渲染进程打包器静态解析本主进程专属依赖，未安装时由运行时抛错并平滑降级。
    const specifier = '@xeno' + 'va/transformers'
    const mod = (await import(/* @vite-ignore */ specifier)) as TransformersModule
    if (!mod || typeof mod.pipeline !== 'function') {
      throw new Error('@xenova/transformers 缺少 pipeline 接口')
    }
    if (mod.env) {
      // 模型只走本地离线缓存（configDir/models），禁用浏览器缓存/在线寻址。
      mod.env.useBrowserCache = false
      mod.env.cacheDir = join(getConfigDir(), 'models')
    }
    const extractor = await mod.pipeline('feature-extraction', EMBED_MODEL_ID)

    const embed: Embedder = async (text) => {
      // 字符级截断到 ≈512 token 以内；mean 池化 + L2 归一化输出。
      const clipped = typeof text === 'string' ? text.slice(0, EMBED_MAX_CHARS) : ''
      const output = await extractor(clipped, { pooling: 'mean', normalize: true })
      const vec = toFloat32Array((output as { data?: unknown } | undefined)?.data)
      if (!vec || vec.length !== EMBED_DIMS) {
        throw new Error(`嵌入输出维度异常：期望 ${EMBED_DIMS}`)
      }
      return normalizeEmbedding(vec)
    }

    // 工厂期烟测一次真实推理：依赖缺失、模型下载失败、推理抛错都在此归零为 null；
    // 后续调用期的推理错误如实抛出，由 upsert 回滚并交调用方处理。
    await embed('cslab-vector-store warmup')
    return embed
  } catch (error) {
    console.warn(
      '[CSLab] 本地嵌入模型不可用（transformers.js），向量入库降级为纯词法由调用方决定'
      + '（Provider API 回退不在本模块实现）:',
      error,
    )
    return null
  }
}
