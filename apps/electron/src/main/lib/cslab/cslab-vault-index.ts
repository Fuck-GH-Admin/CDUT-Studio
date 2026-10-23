/**
 * CSLab Vault 笔记索引（Obsidian 双链 / Canvas）
 *
 * 设计：
 * - `vault/notes` 是开放目录，Obsidian 是 Markdown 的唯一事实源；
 * - 索引缓存写入 `db/vault_cache.sqlite`，payload 为紧凑 JSON；
 * - mtime + size 未变则完全复用缓存，避免万篇笔记冷启动阻塞主线程；
 * - 坏缓存自动回退物理文件重解析，绝不阻断索引。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type {
  CsLabVaultIndexResult,
  CsLabVaultIndexStatus,
  CsLabVaultNoteSummary,
  CsLabVaultReadResult,
} from '@profer/shared'
import { parseCanvasDocument } from '@profer/shared'
import {
  deleteEntity,
  getCsLabDatabase,
  getEntityByUri,
  nextLabRevision,
  upsertEntity,
  withTransaction,
} from './cslab-db'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import {
  countVaultBacklinks,
  deleteVaultIndexRow,
  getCsLabVaultCache,
  getVaultIndexRow,
  getVaultMeta,
  listVaultIndexRows,
  replaceVaultLinks,
  setVaultMeta,
  upsertVaultIndexRow,
  withVaultCacheTransaction,
  type CsLabVaultCache,
  type CsLabVaultIndexRow,
} from './cslab-vault-cache'

const RESERVED_DIRS = new Set(['runs', 'protocols'])
const MAX_EXCERPT = 280
const CACHE_YIELD_EVERY = 50
const CONTENT_LRU_LIMIT = 200
/** 双链索引表建表标记，用于给升级前的旧缓存库做一次性回填。 */
const LINKS_BUILT_AT_KEY = 'links_built_at'

export interface VaultNoteRecord {
  relPath: string
  kind: 'md' | 'canvas'
  title: string
  tags: string[]
  outlinks: string[]
  linkTargets: string[]
  blockIds: string[]
  excerpt: string
  contentHash?: string
  size: number
  mtimeMs: number
  updatedAt: number
}

const contentLru = new Map<string, { content: string; at: number }>()

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function noteUri(labId: string, relPath: string): { uri: string; uuid: string } {
  const uuid = `note-${createHash('sha1').update(relPath).digest('hex').slice(0, 8)}`
  return { uri: buildCsLabUri(labId, 'note', uuid), uuid }
}

function normalizeLinkTarget(raw: string): string | null {
  const withoutAlias = raw.split('|')[0] ?? ''
  const withoutAnchor = withoutAlias.split('#')[0] ?? ''
  const trimmed = withoutAnchor.trim().replace(/\.md$/i, '')
  if (!trimmed) return null
  const base = trimmed.split('/').pop() ?? trimmed
  return base.toLowerCase()
}

function parseFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { frontmatter: '', body: content }
  return { frontmatter: match[1] ?? '', body: content.slice(match[0].length) }
}

function parseFrontmatterMeta(frontmatter: string): { title?: string; tags: string[] } {
  if (!frontmatter) return { tags: [] }
  let title: string | undefined
  const tags: string[] = []
  let inTags = false

  for (const line of frontmatter.split(/\r?\n/)) {
    const titleMatch = /^title:\s*(.+)$/i.exec(line)
    if (titleMatch) {
      title = titleMatch[1]!.trim().replace(/^["']|["']$/g, '')
      continue
    }
    const tagsMatch = /^tags:\s*(.*)$/i.exec(line)
    if (tagsMatch) {
      const inline = tagsMatch[1]!.trim()
      if (inline) {
        tags.push(
          ...inline
            .replace(/^\[|\]$/g, '')
            .split(/[,\s]+/)
            .map((tag) => tag.replace(/^["']|["']$/g, '').replace(/^#/, '').trim())
            .filter(Boolean),
        )
        inTags = false
      } else {
        inTags = true
      }
      continue
    }
    if (inTags) {
      const item = /^\s*-\s*(.+)$/.exec(line)
      if (item) {
        tags.push(item[1]!.trim().replace(/^#/, ''))
      } else if (line.trim()) {
        inTags = false
      }
    }
  }

  return { title, tags: [...new Set(tags)] }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)]]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解析 Markdown 笔记（纯函数，便于单测）。 */
export function parseMarkdownNote(
  relPath: string,
  content: string,
  stat: { size: number; mtimeMs: number },
): VaultNoteRecord {
  const { frontmatter, body } = parseFrontmatter(content)
  const meta = parseFrontmatterMeta(frontmatter)
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const title = meta.title || h1 || basename(relPath).replace(/\.md$/i, '')

  const outlinks: string[] = []
  const linkTargets: string[] = []
  const wikilinkRe = /\[\[([^\]]+)]]/g
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = wikilinkRe.exec(content)) !== null) {
    const raw = linkMatch[1]!.trim()
    outlinks.push(raw)
    const target = normalizeLinkTarget(raw)
    if (target) linkTargets.push(target)
  }

  const blockIds: string[] = []
  const blockRe = /(?:^|\s)\^([A-Za-z0-9-]+)/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRe.exec(content)) !== null) {
    blockIds.push(blockMatch[1]!)
  }

  // 内联标签（#tag）也纳入检索；标题的 "# " 因带空格不会被误判。
  const tags = new Set(meta.tags)
  const inlineTagRe = /(?:^|\s)#([A-Za-z0-9_\u4e00-\u9fa5/-]+)/g
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = inlineTagRe.exec(body)) !== null) {
    tags.add(tagMatch[1]!)
  }

  const excerpt = stripMarkdown(body).slice(0, MAX_EXCERPT)

  return {
    relPath,
    kind: 'md',
    title,
    tags: [...tags],
    outlinks,
    linkTargets: [...new Set(linkTargets)],
    blockIds: [...new Set(blockIds)],
    excerpt,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

/** 解析 JSON Canvas 笔记（纯函数）。 */
export function parseCanvasNote(
  relPath: string,
  content: string,
  stat: { size: number; mtimeMs: number },
): VaultNoteRecord {
  const document = parseCanvasDocument(content)
  const texts = document.nodes
    .map((node) => (typeof node.text === 'string' ? node.text : ''))
    .filter(Boolean)
  const firstLine = texts[0]?.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim()
  const fileLinks = document.nodes
    .map((node) => (typeof node.file === 'string' ? node.file : ''))
    .filter(Boolean)

  return {
    relPath,
    kind: 'canvas',
    title: firstLine || basename(relPath).replace(/\.canvas$/i, ''),
    tags: [],
    outlinks: fileLinks,
    linkTargets: [
      ...new Set(
        fileLinks
          .map((file) => normalizeLinkTarget(file))
          .filter((target): target is string => !!target),
      ),
    ],
    blockIds: [],
    excerpt: stripMarkdown(texts.join(' ')).slice(0, MAX_EXCERPT),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: stat.mtimeMs,
  }
}

function decodePayload(row: CsLabVaultIndexRow): VaultNoteRecord | null {
  try {
    const parsed = JSON.parse(row.payload) as VaultNoteRecord
    if (!parsed || typeof parsed !== 'object' || parsed.relPath !== row.relPath) return null
    if (parsed.kind !== 'md' && parsed.kind !== 'canvas') return null
    return parsed
  } catch {
    return null
  }
}

async function walkNoteFiles(notesRoot: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (RESERVED_DIRS.has(entry.name)) continue
        await visit(absolute)
      } else if (entry.isFile() && /\.(md|canvas)$/i.test(entry.name)) {
        files.push(absolute)
      }
    }
  }
  await visit(notesRoot)
  return files
}

function toNoteRelPath(notesRoot: string, absolutePath: string): string {
  const rel = relative(notesRoot, absolutePath).split(sep).join('/')
  return `vault/notes/${rel}`
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function noteKeys(record: VaultNoteRecord): string[] {
  return [
    basename(record.relPath).replace(/\.(md|canvas)$/i, '').toLowerCase(),
    record.title.toLowerCase(),
  ]
}

/** 预构建反向链接索引：target -> 引用它的笔记 relPath 集合。 */
function buildBacklinkIndex(records: VaultNoteRecord[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const record of records) {
    for (const target of new Set(record.linkTargets)) {
      const set = index.get(target) ?? new Set<string>()
      set.add(record.relPath)
      index.set(target, set)
    }
  }
  return index
}

function summarizeRecord(
  record: VaultNoteRecord,
  backlinkIndex?: Map<string, Set<string>>,
): CsLabVaultNoteSummary {
  let backlinkCount = 0
  if (backlinkIndex) {
    const sources = new Set<string>()
    for (const key of noteKeys(record)) {
      for (const source of backlinkIndex.get(key) ?? []) {
        if (source !== record.relPath) sources.add(source)
      }
    }
    backlinkCount = sources.size
  }

  return {
    relPath: record.relPath,
    kind: record.kind,
    title: record.title,
    tags: record.tags,
    linkCount: record.outlinks.length,
    backlinkCount,
    excerpt: record.excerpt,
    updatedAt: record.updatedAt,
  }
}

function summarizeWithBacklinks(
  records: VaultNoteRecord[],
  relPath: string,
): CsLabVaultNoteSummary | null {
  const target = records.find((record) => record.relPath === relPath)
  if (!target) return null
  return summarizeRecord(target, buildBacklinkIndex(records))
}

async function syncEntities(
  labId: string,
  records: VaultNoteRecord[],
  removedRelPaths: string[],
): Promise<void> {
  const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
  const shaByRelPath = new Map(
    records.map((record) => [
      record.relPath,
      record.contentHash ?? sha256(`${record.relPath}:${record.mtimeMs}:${record.size}`),
    ]),
  )

  withTransaction(db, () => {
    // 批量同步共用一次实验室 revision，避免万篇笔记逐条写 lab_state。
    let batchRevision: number | null = null
    for (const record of records) {
      const { uri, uuid } = noteUri(labId, record.relPath)
      const digest = shaByRelPath.get(record.relPath) ?? ''
      const existing = getEntityByUri(db, uri)
      if (
        existing &&
        existing.sha256 === digest &&
        existing.title === record.title &&
        existing.relPath === record.relPath
      ) {
        continue
      }
      if (batchRevision === null) batchRevision = nextLabRevision(db)
      upsertEntity(db, {
        uri,
        labId,
        layerType: 'note',
        entityUuid: uuid,
        title: record.title,
        format: record.kind,
        relPath: record.relPath,
        sha256: digest,
        bytes: record.size,
        revision: batchRevision,
        locked: false,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      })
    }

    for (const relPath of removedRelPaths) {
      const { uri } = noteUri(labId, relPath)
      deleteEntity(db, uri)
    }
  })
}

const indexInFlight = new Map<string, Promise<CsLabVaultIndexResult>>()

export function rebuildVaultIndex(
  labIdInput: string,
  options: { force?: boolean } = {},
): Promise<CsLabVaultIndexResult> {
  const key = labIdInput
  const existing = indexInFlight.get(key)
  if (existing) return existing
  const task = rebuildVaultIndexInternal(labIdInput, options).finally(() => {
    indexInFlight.delete(key)
  })
  indexInFlight.set(key, task)
  return task
}

async function rebuildVaultIndexInternal(
  labIdInput: string,
  options: { force?: boolean } = {},
): Promise<CsLabVaultIndexResult> {
  const labId = assertLabId(labIdInput)
  const startedAt = Date.now()
  const cache = getCsLabVaultCache(labId)
  const notesRoot = resolveLabRelativePath(labId, 'vault/notes')
  await fs.mkdir(notesRoot, { recursive: true })

  const existing = new Map(listVaultIndexRows(cache).map((row) => [row.relPath, row]))
  const files = await walkNoteFiles(notesRoot)
  const currentRelPaths = new Set<string>()
  const records: VaultNoteRecord[] = []
  const upserts: CsLabVaultIndexRow[] = []
  let parsed = 0
  let reused = 0

  for (let index = 0; index < files.length; index += 1) {
    const absolute = files[index]!
    const relPath = toNoteRelPath(notesRoot, absolute)

    let stat
    try {
      stat = await fs.stat(absolute)
    } catch {
      continue
    }
    currentRelPaths.add(relPath)
    const previous = existing.get(relPath)
    let record: VaultNoteRecord | null = null

    if (
      previous &&
      !options.force &&
      previous.size === stat.size &&
      Math.abs(previous.mtimeMs - stat.mtimeMs) < 1
    ) {
      record = decodePayload(previous)
      if (record) {
        reused += 1
        records.push({ ...record, size: stat.size, mtimeMs: stat.mtimeMs })
        if ((index + 1) % CACHE_YIELD_EVERY === 0) await yieldToEventLoop()
        continue
      }
      // 坏缓存：删除后回退物理文件。
      deleteVaultIndexRow(cache, relPath)
    }

    let content = ''
    try {
      content = await fs.readFile(absolute, 'utf-8')
    } catch {
      continue
    }

    try {
      record =
        /\.canvas$/i.test(absolute)
          ? parseCanvasNote(relPath, content, stat)
          : parseMarkdownNote(relPath, content, stat)
    } catch (error) {
      console.warn(`[CSLab] 笔记解析失败，已跳过: ${relPath}`, error)
      continue
    }

    parsed += 1
    const contentHash = sha256(content)
    record.contentHash = contentHash
    records.push(record)
    upserts.push({
      relPath,
      mtimeMs: record.mtimeMs,
      size: record.size,
      contentHash,
      payload: JSON.stringify(record),
      updatedAt: Date.now(),
    })
    contentLru.delete(`${labId}:${relPath}`)

    if ((index + 1) % CACHE_YIELD_EVERY === 0) await yieldToEventLoop()
  }

  const removed = [...existing.keys()].filter((relPath) => !currentRelPaths.has(relPath))
  const recordMap = new Map(records.map((record) => [record.relPath, record]))
  const fingerprint = createHash('sha256')
    .update(
      [...currentRelPaths]
        .sort()
        .map((relPath) => {
          const record = recordMap.get(relPath)
          return `${relPath}:${Math.round(record?.mtimeMs ?? 0)}:${record?.size ?? 0}`
        })
        .join('|'),
    )
    .digest('hex')

  withVaultCacheTransaction(cache, () => {
    for (const row of upserts) upsertVaultIndexRow(cache, row)
    for (const relPath of removed) deleteVaultIndexRow(cache, relPath)
    // 双链索引与笔记索引同事务重建，保证单篇读取可直接走 SQL。
    replaceVaultLinks(
      cache,
      records.map((record) => ({ relPath: record.relPath, targetKeys: record.linkTargets })),
    )
    setVaultMeta(cache, LINKS_BUILT_AT_KEY, String(Date.now()))
    setVaultMeta(cache, 'built_at', String(Date.now()))
    setVaultMeta(cache, 'fingerprint', fingerprint)
  })

  await syncEntities(labId, records, removed)

  const status: CsLabVaultIndexStatus = {
    noteCount: records.filter((record) => record.kind === 'md').length,
    canvasCount: records.filter((record) => record.kind === 'canvas').length,
    linkCount: records.reduce((total, record) => total + record.outlinks.length, 0),
    builtAt: Date.now(),
    fingerprint,
    cachedRows: currentRelPaths.size,
  }

  return {
    status,
    parsed,
    reused,
    removed: removed.length,
    elapsedMs: Date.now() - startedAt,
  }
}

function loadRecords(labId: string): VaultNoteRecord[] {
  const cache = getCsLabVaultCache(labId)
  const records: VaultNoteRecord[] = []
  for (const row of listVaultIndexRows(cache)) {
    const record = decodePayload(row)
    if (record) records.push(record)
    else deleteVaultIndexRow(cache, row.relPath)
  }
  return records.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function listVaultNotes(labIdInput: string, limit = 500): CsLabVaultNoteSummary[] {
  const labId = assertLabId(labIdInput)
  const records = loadRecords(labId)
  const backlinkIndex = buildBacklinkIndex(records)
  // IPC 层默认只回传最近 500 篇，避免万篇笔记一次性穿过 IPC 冻结渲染层；
  // 其余笔记通过 searchVaultNotes 检索。
  return records
    .slice(0, Math.max(1, Math.min(limit, 2000)))
    .map((record) => summarizeRecord(record, backlinkIndex))
}

export function searchVaultNotes(
  labIdInput: string,
  query: string,
  limit = 50,
): CsLabVaultNoteSummary[] {
  const labId = assertLabId(labIdInput)
  const keyword = query.trim().toLowerCase()
  const records = loadRecords(labId)
  const backlinkIndex = buildBacklinkIndex(records)
  if (!keyword) {
    return records.slice(0, limit).map((record) => summarizeRecord(record, backlinkIndex))
  }
  return records
    .map((record) => ({ record, score: scoreVaultRecord(record, keyword) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.record.mtimeMs - a.record.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 300)))
    .map((item) => summarizeRecord(item.record, backlinkIndex))
}

/** 标题命中 > 标签 > 摘要 > 路径 / 出链；同字段只计一次。 */
function scoreVaultRecord(record: VaultNoteRecord, keyword: string): number {
  let score = 0
  if (record.title.toLowerCase().includes(keyword)) score += 50
  if (record.tags.some((tag) => tag.toLowerCase().includes(keyword))) score += 30
  if (record.excerpt.toLowerCase().includes(keyword)) score += 10
  if (record.relPath.toLowerCase().includes(keyword)) score += 5
  if (record.outlinks.some((link) => link.toLowerCase().includes(keyword))) score += 5
  return score
}

export function getVaultIndexStatus(labIdInput: string): CsLabVaultIndexStatus {
  const labId = assertLabId(labIdInput)
  const cache = getCsLabVaultCache(labId)
  const rows = listVaultIndexRows(cache)
  const records: VaultNoteRecord[] = []
  for (const row of rows) {
    const record = decodePayload(row)
    if (record) records.push(record)
  }
  return {
    noteCount: records.filter((record) => record.kind === 'md').length,
    canvasCount: records.filter((record) => record.kind === 'canvas').length,
    linkCount: records.reduce((total, record) => total + record.outlinks.length, 0),
    builtAt: Number(getVaultMeta(cache, 'built_at') ?? 0) || undefined,
    fingerprint: getVaultMeta(cache, 'fingerprint') ?? undefined,
    cachedRows: rows.length,
  }
}

/**
 * 升级前的缓存库没有 vault_links：首次读取时用现有 payload 一次性回填，
 * 之后单篇读取可完全走 SQL，不再触发全表反序列化。
 */
function ensureVaultLinks(cache: CsLabVaultCache): void {
  if (getVaultMeta(cache, LINKS_BUILT_AT_KEY)) return
  const entries: Array<{ relPath: string; targetKeys: string[] }> = []
  for (const row of listVaultIndexRows(cache)) {
    const record = decodePayload(row)
    if (!record) continue
    entries.push({ relPath: record.relPath, targetKeys: record.linkTargets })
  }
  withVaultCacheTransaction(cache, () => {
    replaceVaultLinks(cache, entries)
    setVaultMeta(cache, LINKS_BUILT_AT_KEY, String(Date.now()))
  })
}

export async function readVaultNote(
  labIdInput: string,
  relPath: string,
): Promise<CsLabVaultReadResult> {
  const labId = assertLabId(labIdInput)
  if (!/^vault\/notes\/.+\.md$/i.test(relPath)) throw new Error('仅支持读取 vault/notes 下的 Markdown 笔记')
  const absolute = resolveLabRelativePath(labId, relPath)

  const cacheKey = `${labId}:${relPath}`
  let content = contentLru.get(cacheKey)?.content
  if (!content) {
    content = await fs.readFile(absolute, 'utf-8')
    contentLru.set(cacheKey, { content, at: Date.now() })
    if (contentLru.size > CONTENT_LRU_LIMIT) {
      const oldest = [...contentLru.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) contentLru.delete(oldest[0])
    }
  }

  // 只取目标行与反链计数，避免每次点开笔记都全表扫描并反序列化整个 Vault。
  const cache = getCsLabVaultCache(labId)
  ensureVaultLinks(cache)
  const row = getVaultIndexRow(cache, relPath)
  const record = row ? decodePayload(row) : null

  let summary: CsLabVaultNoteSummary
  if (record) {
    summary = {
      relPath: record.relPath,
      kind: record.kind,
      title: record.title,
      tags: record.tags,
      linkCount: record.outlinks.length,
      backlinkCount: countVaultBacklinks(cache, noteKeys(record), relPath),
      excerpt: record.excerpt,
      updatedAt: record.updatedAt,
    }
  } else {
    const stat = await fs.stat(absolute)
    const fallback = parseMarkdownNote(relPath, content, stat)
    summary = {
      relPath: fallback.relPath,
      kind: fallback.kind,
      title: fallback.title,
      tags: fallback.tags,
      linkCount: fallback.outlinks.length,
      backlinkCount: 0,
      excerpt: fallback.excerpt,
      updatedAt: fallback.updatedAt,
    }
  }

  return { summary, content, outlinks: record?.outlinks ?? [] }
}

export function getNoteBacklinks(
  labIdInput: string,
  relPath: string,
): CsLabVaultNoteSummary[] {
  const labId = assertLabId(labIdInput)
  const records = loadRecords(labId)
  const target = records.find((record) => record.relPath === relPath)
  if (!target) return []
  const keys = new Set([
    basename(target.relPath).replace(/\.(md|canvas)$/i, '').toLowerCase(),
    target.title.toLowerCase(),
  ])
  return records
    .filter(
      (record) => record.relPath !== relPath && record.linkTargets.some((link) => keys.has(link)),
    )
    .map((record) => summarizeWithBacklinks(records, record.relPath))
    .filter((summary): summary is CsLabVaultNoteSummary => !!summary)
}

/** 单文件增量索引（Canvas 写入后调用）。 */
export async function indexSingleNote(labIdInput: string, relPath: string): Promise<void> {
  const labId = assertLabId(labIdInput)
  const cache = getCsLabVaultCache(labId)
  const absolute = resolveLabRelativePath(labId, relPath)

  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    deleteVaultIndexRow(cache, relPath)
    await syncEntities(labId, [], [relPath])
    return
  }

  const content = await fs.readFile(absolute, 'utf-8')
  const record = /\.canvas$/i.test(absolute)
    ? parseCanvasNote(relPath, content, stat)
    : parseMarkdownNote(relPath, content, stat)
  const contentHash = sha256(content)
  record.contentHash = contentHash

  upsertVaultIndexRow(cache, {
    relPath,
    mtimeMs: record.mtimeMs,
    size: record.size,
    contentHash,
    payload: JSON.stringify(record),
    updatedAt: Date.now(),
  })
  contentLru.delete(`${labId}:${relPath}`)
  await syncEntities(labId, [record], [])
}

/** 供测试清理内存 LRU。 */
export function __clearVaultContentLru(): void {
  contentLru.clear()
}
