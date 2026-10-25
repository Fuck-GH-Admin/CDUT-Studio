/**
 * CSLab 文献向量库测试（bun test）
 *
 * 测试红线：
 * 1. 绝不真实 ONNX 推理 / 模型下载 / 联网——全部注入 Mock Embedder（确定性伪向量）；
 * 2. 不依赖真实 node:sqlite（bun test 运行器不可靠加载，见
 *    apps/electron/scripts/memory-search-verify.mjs 注释）——采用方案 (a)：
 *    mock.module('node:sqlite') 注入以 bun:sqlite 为后端的假 DatabaseSync，
 *    SQL 语义（WAL/ON CONFLICT upsert/BLOB）真实执行但零 node:sqlite 依赖；
 * 3. @xenova/transformers 以「抛错 mock」确定性覆盖 createDefaultEmbedder 的
 *    依赖缺失降级分支，杜绝任何模型加载路径。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database as BunDatabase } from 'bun:sqlite'
import type { Embedder } from './cslab-vector-store'

// ===== node:sqlite 假实现（bun:sqlite 后端，仅测试可见） =====

interface BunStatementLike {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

class FakeStatement {
  constructor(private readonly stmt: BunStatementLike) {}
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...params)
  }
  get(...params: unknown[]): unknown {
    return this.stmt.get(...params) ?? undefined
  }
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params)
  }
}

class FakeDatabaseSync {
  private readonly db: BunDatabase
  constructor(path: string) {
    this.db = new BunDatabase(path)
  }
  exec(sql: string): void {
    this.db.exec(sql)
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db.query(sql) as unknown as BunStatementLike)
  }
  close(): void {
    this.db.close()
  }
}

mock.module('node:sqlite', () => ({ DatabaseSync: FakeDatabaseSync }))
mock.module('@xenova/transformers', () => {
  // 抛错 mock：模拟依赖缺失，让 createDefaultEmbedder 的 catch 分支被确定性覆盖。
  throw new Error('mocked: @xenova/transformers 依赖缺失')
})

// ===== Mock Embedder：FNV-1a 扩散伪向量，零推理/零联网 =====

const EMBED_DIMS = 384

function mockEmbedSync(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIMS)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  for (let i = 0; i < vec.length; i++) {
    h = Math.imul(h ^ i, 0x01000193) >>> 0
    vec[i] = ((h % 2001) - 1000) / 1000
  }
  // L2 归一化，对齐真实嵌入器的输出契约
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!
  const norm = Math.sqrt(sum)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
  }
  return vec
}

const mockEmbed: Embedder = (text) => Promise.resolve(mockEmbedSync(text))

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ===== 测试环境 =====

let rootDir = ''
let vs: typeof import('./cslab-vector-store')
const previousConfigDir = process.env.PROFER_CONFIG_DIR

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-vector-store-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  vs = await import('./cslab-vector-store')
})

afterAll(() => {
  vs.closeAllLiteratureVectorStores()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放时交给系统回收。
  }
  if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigDir
})

function openRaw(labId: string): FakeDatabaseSync {
  return new FakeDatabaseSync(vs.getLiteratureVectorStorePath(labId))
}

describe('文献向量库', () => {
  test('upsert + search 往返：命中排序与分数符合余弦相似度预期', async () => {
    const labId = 'vs-roundtrip'
    const chunks = [
      {
        chunkId: 'lit://paper-a#p1c0',
        literatureUri: 'lit://paper-a',
        title: '论文 A',
        page: 1,
        text: '花岗岩风化壳的渗透系数反演',
        bbox: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number],
      },
      {
        chunkId: 'lit://paper-b#p3c1',
        literatureUri: 'lit://paper-b',
        title: '论文 B',
        page: 3,
        text: '滑坡位移监测的时间序列模型',
      },
      {
        chunkId: 'lit://paper-c#p2c0',
        literatureUri: 'lit://paper-c',
        title: '论文 C',
        page: 2,
        text: '花岗岩风化与滑坡稳定性的关联分析',
        bbox: [0.55, 0.65, 0.75, 0.85] as [number, number, number, number],
      },
    ]

    const inserted = await vs.upsertLiteratureChunks(labId, chunks, mockEmbed)
    expect(inserted).toBe(3)

    const query = '花岗岩渗透系数'
    const queryVec = mockEmbedSync(query)
    const expected = chunks
      .map((chunk) => ({ chunkId: chunk.chunkId, score: cosine(queryVec, mockEmbedSync(chunk.text)) }))
      .sort((a, b) => b.score - a.score)

    const hits = await vs.searchLiteratureVectors(labId, query, 3, mockEmbed)
    expect(hits).toHaveLength(3)
    for (let i = 0; i < hits.length; i++) {
      expect(hits[i]!.chunkId).toBe(expected[i]!.chunkId)
      expect(hits[i]!.score).toBeCloseTo(expected[i]!.score, 5)
    }
    // 分数必须降序
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    }

    // bbox 与元数据往返（含无 bbox 切块的缺省）
    const byId = new Map(hits.map((hit) => [hit.chunkId, hit]))
    expect(byId.get('lit://paper-a#p1c0')!.bbox).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(byId.get('lit://paper-b#p3c1')!.bbox).toBeUndefined()
    expect(byId.get('lit://paper-a#p1c0')!.page).toBe(1)
    expect(byId.get('lit://paper-a#p1c0')!.title).toBe('论文 A')
    expect(byId.get('lit://paper-a#p1c0')!.text).toBe('花岗岩风化壳的渗透系数反演')

    // topK 截断
    const top2 = await vs.searchLiteratureVectors(labId, query, 2, mockEmbed)
    expect(top2).toHaveLength(2)
    expect(top2[0]!.chunkId).toBe(expected[0]!.chunkId)
  })

  test('BLOB 序列化保真：384 维逐元素相等', async () => {
    const labId = 'vs-blob'
    const text = '二长花岗岩锆石 U-Pb 年代学'
    const expected = mockEmbedSync(text)

    await vs.upsertLiteratureChunks(
      labId,
      [{ chunkId: 'lit://blob#p1c0', literatureUri: 'lit://blob', title: 'BLOB 保真', page: 1, text }],
      mockEmbed,
    )

    const raw = openRaw(labId)
    try {
      const row = raw.prepare('SELECT embedding FROM literature_chunks WHERE chunk_id = ?').get('lit://blob#p1c0') as
        | { embedding?: unknown }
        | undefined
      expect(row).toBeTruthy()
      const bytes = row!.embedding as Uint8Array
      const restored = new Float32Array(new Uint8Array(bytes).buffer)
      expect(restored.length).toBe(EMBED_DIMS)
      for (let i = 0; i < EMBED_DIMS; i++) {
        expect(restored[i]).toBe(expected[i])
      }
    } finally {
      raw.close()
    }
  })

  test('deleteLiteratureChunks 后不再命中', async () => {
    const labId = 'vs-delete'
    await vs.upsertLiteratureChunks(
      labId,
      [
        { chunkId: 'lit://gone#p1c0', literatureUri: 'lit://gone', title: '待删除', page: 1, text: '待删除文献甲' },
        { chunkId: 'lit://gone#p2c0', literatureUri: 'lit://gone', title: '待删除', page: 2, text: '待删除文献乙' },
        { chunkId: 'lit://keep#p1c0', literatureUri: 'lit://keep', title: '保留', page: 1, text: '保留文献丙' },
      ],
      mockEmbed,
    )

    const before = await vs.searchLiteratureVectors(labId, '文献', 10, mockEmbed)
    expect(before).toHaveLength(3)

    vs.deleteLiteratureChunks(labId, 'lit://gone')
    // 幂等：重复删除不抛出
    vs.deleteLiteratureChunks(labId, 'lit://gone')

    const after = await vs.searchLiteratureVectors(labId, '文献', 10, mockEmbed)
    expect(after).toHaveLength(1)
    expect(after[0]!.chunkId).toBe('lit://keep#p1c0')

    const raw = openRaw(labId)
    try {
      const row = raw.prepare('SELECT COUNT(*) AS count FROM literature_chunks WHERE literature_uri = ?').get('lit://gone') as
        | { count?: number }
        | undefined
      expect(Number(row?.count ?? -1)).toBe(0)
    } finally {
      raw.close()
    }
  })

  test('同 chunkId 重复 upsert 为覆盖（upsert 语义）', async () => {
    const labId = 'vs-upsert'
    const first = await vs.upsertLiteratureChunks(
      labId,
      [{ chunkId: 'dup-chunk', literatureUri: 'lit://dup', title: '第一版', page: 1, text: '第一版正文' }],
      mockEmbed,
    )
    expect(first).toBe(1)

    const second = await vs.upsertLiteratureChunks(
      labId,
      [{ chunkId: 'dup-chunk', literatureUri: 'lit://dup', title: '第二版', page: 5, text: '第二版正文' }],
      mockEmbed,
    )
    expect(second).toBe(1)

    const raw = openRaw(labId)
    try {
      const row = raw.prepare('SELECT COUNT(*) AS count FROM literature_chunks').get() as
        | { count?: number }
        | undefined
      expect(Number(row?.count ?? -1)).toBe(1)
    } finally {
      raw.close()
    }

    const hits = await vs.searchLiteratureVectors(labId, '第二版正文', 10, mockEmbed)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.text).toBe('第二版正文')
    expect(hits[0]!.title).toBe('第二版')
    expect(hits[0]!.page).toBe(5)
    // 覆盖后的向量应与第二版正文一致
    expect(hits[0]!.score).toBeCloseTo(cosine(mockEmbedSync('第二版正文'), mockEmbedSync('第二版正文')), 5)
  })

  test('坏 bbox_json / 空库查询不抛出', async () => {
    const labId = 'vs-defensive'

    // 空库查询 + topK=0
    expect(await vs.searchLiteratureVectors(labId, '任意查询', 5, mockEmbed)).toEqual([])
    expect(await vs.searchLiteratureVectors(labId, '任意查询', 0, mockEmbed)).toEqual([])

    await vs.upsertLiteratureChunks(
      labId,
      [
        {
          chunkId: 'bad-json',
          literatureUri: 'lit://bad',
          title: '坏 JSON',
          page: 1,
          text: '坏 bbox_json 正文',
          bbox: [0.1, 0.2, 0.3, 0.4],
        },
        {
          chunkId: 'bad-arity',
          literatureUri: 'lit://bad',
          title: '坏元数',
          page: 2,
          text: '坏 bbox 元数正文',
          bbox: [0.1, 0.2, 0.3, 0.4],
        },
      ],
      mockEmbed,
    )

    // 直接写坏 bbox_json（非法 JSON / 元数不符），验证读取路径防御
    const raw = openRaw(labId)
    try {
      raw.prepare('UPDATE literature_chunks SET bbox_json = ? WHERE chunk_id = ?').run('not-json{{', 'bad-json')
      raw.prepare('UPDATE literature_chunks SET bbox_json = ? WHERE chunk_id = ?').run('[0.1,0.2]', 'bad-arity')
    } finally {
      raw.close()
    }

    const hits = await vs.searchLiteratureVectors(labId, '正文', 10, mockEmbed)
    expect(hits).toHaveLength(2)
    for (const hit of hits) {
      expect(hit.bbox).toBeUndefined()
    }
  })

  test('createDefaultEmbedder 在依赖缺失环境下返回 null 不抛出', async () => {
    // @xenova/transformers 被抛错 mock 覆盖 → 动态 import 失败 → catch 分支归零。
    await expect(vs.createDefaultEmbedder()).resolves.toBeNull()
  })
})
