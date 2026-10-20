/**
 * CSLab Obsidian / JSON Canvas 双向同步引擎
 *
 * 职责：
 * 1. `.canvas` 读取、创建与写回（保留 Obsidian 全部未知字段）；
 * 2. 外部 mtime 变化时仅合并 `cdut_science`，结构冲突写时间戳分叉副本；
 * 3. Chokidar 150~250ms 防抖监听 `vault/notes`，并在切换实验室/退出时显式 close 句柄；
 * 4. 写入前执行 DAG 引擎，派生 pruned 与待取消任务标记。
 */

import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type {
  CsLabCanvasCreateResult,
  CsLabCanvasDocument,
  CsLabCanvasReadResult,
  CsLabCanvasSummary,
  CsLabCanvasWriteInput,
  CsLabCanvasWriteResult,
  CsLabVaultChangedEvent,
} from '@profer/shared'
import {
  applyDagEvaluation,
  buildConflictRelPath,
  canvasTitleFromRelPath,
  canvasToDagGraph,
  createEmptyCanvasDocument,
  evaluateDag,
  mergeCanvasScienceMeta,
  parseCanvasDocument,
  serializeCanvasDocument,
} from '@profer/shared'
import { CsLabFileBusyError, writeTextAtomic } from './cslab-atomic'
import { assertLabId, resolveLabRelativePath, sanitizeFileName } from './cslab-paths'
import { createDebouncer } from './cslab-debounce'
import { indexSingleNote } from './cslab-vault-index'

interface WatcherLike {
  on(event: 'add' | 'change' | 'unlink', handler: (path: string) => void): unknown
  on(event: 'error', handler: (error: unknown) => void): unknown
  close(): Promise<void> | void
}

interface ActiveWatcher {
  close: () => Promise<void>
}

const watchers = new Map<string, ActiveWatcher>()
const RESERVED_DIRS = new Set(['runs', 'protocols'])

function assertCanvasRelPath(relPath: string): string {
  if (!/^vault\/notes\/.+\.canvas$/i.test(relPath)) {
    throw new Error('仅支持操作 vault/notes 下的 .canvas 文件')
  }
  if (relPath.includes('..')) throw new Error('Canvas 路径越界')
  return relPath
}

function resolveCanvasPath(labId: string, relPath: string): string {
  return resolveLabRelativePath(labId, assertCanvasRelPath(relPath))
}

function isReservedPath(relPath: string): boolean {
  const segments = relPath.split('/')
  return segments.length > 3 && RESERVED_DIRS.has(segments[2] ?? '')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function uniqueConflictPath(labId: string, relPath: string): Promise<string> {
  const base = buildConflictRelPath(relPath)
  let candidate = base
  let counter = 2
  while (await pathExists(resolveLabRelativePath(labId, candidate))) {
    candidate = base.replace(/\.canvas$/i, `-${counter}.canvas`)
    counter += 1
  }
  return candidate
}

async function writeConflictCopy(
  labId: string,
  relPath: string,
  document: CsLabCanvasDocument,
): Promise<string> {
  const conflictRelPath = await uniqueConflictPath(labId, relPath)
  await writeTextAtomic(
    resolveLabRelativePath(labId, conflictRelPath),
    serializeCanvasDocument(document),
    { allowInPlaceFallback: true },
  )
  try {
    await indexSingleNote(labId, conflictRelPath)
  } catch (error) {
    console.warn(`[CSLab] 冲突副本索引失败（文件已落盘）: ${conflictRelPath}`, error)
  }
  return conflictRelPath
}

function evaluateDocument(document: CsLabCanvasDocument): {
  document: CsLabCanvasDocument
  cancelledJobIds: string[]
} {
  const graph = canvasToDagGraph(document)
  if (graph.nodes.length === 0) return { document, cancelledJobIds: [] }
  const evaluation = evaluateDag(graph.nodes, graph.edges)
  // 同一任务只广播一次取消请求，避免每次保存重复通知 Phase 4 网关。
  const alreadyRequested = new Set(
    document.nodes
      .filter((node) => node.cdut_science?.job_cancel_requested === true)
      .map((node) => node.cdut_science?.gpu_task_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const cancelledJobIds = evaluation.cancelledJobIds.filter((id) => !alreadyRequested.has(id))
  return {
    document: applyDagEvaluation(document, evaluation, cancelledJobIds),
    cancelledJobIds,
  }
}

async function walkCanvasFiles(notesRoot: string): Promise<string[]> {
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
      } else if (entry.isFile() && /\.canvas$/i.test(entry.name)) {
        files.push(absolute)
      }
    }
  }
  await visit(notesRoot)
  return files
}

export async function listCanvases(labIdInput: string): Promise<CsLabCanvasSummary[]> {
  const labId = assertLabId(labIdInput)
  const notesRoot = resolveLabRelativePath(labId, 'vault/notes')
  await fs.mkdir(notesRoot, { recursive: true })
  const files = await walkCanvasFiles(notesRoot)
  const summaries: CsLabCanvasSummary[] = []

  for (const absolute of files) {
    const rel = relative(notesRoot, absolute).split(sep).join('/')
    const relPath = `vault/notes/${rel}`
    try {
      const [stat, text] = await Promise.all([fs.stat(absolute), fs.readFile(absolute, 'utf-8')])
      const document = parseCanvasDocument(text)
      summaries.push({
        relPath,
        title: canvasTitleFromRelPath(relPath),
        nodeCount: document.nodes.length,
        edgeCount: document.edges.length,
        updatedAt: stat.mtimeMs,
      })
    } catch (error) {
      console.warn(`[CSLab] Canvas 解析失败，已跳过: ${relPath}`, error)
    }
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readCanvas(
  labIdInput: string,
  relPath: string,
): Promise<CsLabCanvasReadResult> {
  const labId = assertLabId(labIdInput)
  const absolute = resolveCanvasPath(labId, relPath)
  const [text, stat] = await Promise.all([fs.readFile(absolute, 'utf-8'), fs.stat(absolute)])
  return { relPath, document: parseCanvasDocument(text), mtimeMs: stat.mtimeMs }
}

export async function createCanvas(
  labIdInput: string,
  titleInput: string,
): Promise<CsLabCanvasCreateResult> {
  const labId = assertLabId(labIdInput)
  const notesRoot = resolveLabRelativePath(labId, 'vault/notes')
  await fs.mkdir(notesRoot, { recursive: true })

  const baseRaw = sanitizeFileName(titleInput || '未命名画布')
    .replace(/\.canvas$/i, '')
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]/g, '_')
  const base = (baseRaw || 'untitled-canvas').slice(0, 80)

  let candidate = `vault/notes/${base}.canvas`
  let counter = 2
  while (await pathExists(resolveLabRelativePath(labId, candidate))) {
    candidate = `vault/notes/${base}-${counter}.canvas`
    counter += 1
  }

  const document = createEmptyCanvasDocument()
  await writeTextAtomic(resolveLabRelativePath(labId, candidate), serializeCanvasDocument(document), {
    allowInPlaceFallback: true,
  })
  try {
    await indexSingleNote(labId, candidate)
  } catch (error) {
    console.warn(`[CSLab] 新画布索引失败（文件已创建）: ${candidate}`, error)
  }
  const stat = await fs.stat(resolveLabRelativePath(labId, candidate))

  return { relPath: candidate, document, mtimeMs: stat.mtimeMs }
}

export async function writeCanvas(input: CsLabCanvasWriteInput): Promise<CsLabCanvasWriteResult> {
  const labId = assertLabId(input.labId)
  const relPath = assertCanvasRelPath(input.relPath)
  const absolute = resolveLabRelativePath(labId, relPath)

  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    throw new Error('Canvas 文件不存在，可能已被移动或删除')
  }

  const evaluatedIncoming = evaluateDocument(input.document)
  let baseDocument = input.document

  if (
    typeof input.expectedMtimeMs === 'number' &&
    input.expectedMtimeMs > 0 &&
    Math.abs(stat.mtimeMs - input.expectedMtimeMs) > 2
  ) {
    let diskDocument: CsLabCanvasDocument
    try {
      diskDocument = parseCanvasDocument(await fs.readFile(absolute, 'utf-8'))
    } catch {
      diskDocument = createEmptyCanvasDocument()
    }

    const merged = mergeCanvasScienceMeta(diskDocument, input.document)
    if (merged.orphanNodeIds.length > 0 || merged.orphanEdgeIds.length > 0) {
      // Obsidian 已重构结构：CDUT 的独立节点/边写入分叉副本，绝不覆盖原文件。
      const conflictRelPath = await writeConflictCopy(
        labId,
        relPath,
        evaluatedIncoming.document,
      )
      return {
        relPath,
        document: evaluatedIncoming.document,
        mtimeMs: stat.mtimeMs,
        durability: 'conflict-only',
        conflictRelPath,
        cancelledJobIds: evaluatedIncoming.cancelledJobIds,
      }
    }
    baseDocument = merged.document
  }

  const evaluated = evaluateDocument(baseDocument)

  try {
    const result = await writeTextAtomic(absolute, serializeCanvasDocument(evaluated.document), {
      allowInPlaceFallback: true,
    })
    const nextStat = await fs.stat(absolute)
    try {
      await indexSingleNote(labId, relPath)
    } catch (error) {
      console.warn(`[CSLab] Canvas 索引更新失败（文件已写入）: ${relPath}`, error)
    }
    return {
      relPath,
      document: evaluated.document,
      mtimeMs: nextStat.mtimeMs,
      durability: result.durability,
      cancelledJobIds: evaluated.cancelledJobIds,
    }
  } catch (error) {
    if (!(error instanceof CsLabFileBusyError)) throw error
    const conflictRelPath = await writeConflictCopy(labId, relPath, evaluatedIncoming.document)
    return {
      relPath,
      document: evaluatedIncoming.document,
      mtimeMs: stat.mtimeMs,
      durability: 'conflict-only',
      conflictRelPath,
      cancelledJobIds: evaluatedIncoming.cancelledJobIds,
    }
  }
}

// ===== Vault 文件监听 =====

export interface VaultWatcherStatus {
  watching: boolean
  message: string
}

export async function startVaultWatcher(
  labIdInput: string,
  onChange: (event: CsLabVaultChangedEvent) => void,
): Promise<VaultWatcherStatus> {
  const labId = assertLabId(labIdInput)
  const existing = watchers.get(labId)
  if (existing) return { watching: true, message: '监听已开启' }

  const notesRoot = resolveLabRelativePath(labId, 'vault/notes')
  await fs.mkdir(notesRoot, { recursive: true })

  try {
    const module = (await import('chokidar')) as unknown as {
      watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike
      default?: { watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike }
    }
    const watch = module.watch ?? module.default?.watch
    if (!watch) return { watching: false, message: 'Chokidar 不可用，无法监听 Vault' }

    const watcher = watch([notesRoot], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 220, pollInterval: 80 },
      ignorePermissionErrors: true,
    })

    const added = new Set<string>()
    const changed = new Set<string>()
    const removed = new Set<string>()
    // 串行化增量索引，避免多个防抖批次并发读写同一份缓存。
    let pendingChain: Promise<void> = Promise.resolve()

    const toRel = (absolute: string): string | null => {
      const rel = relative(notesRoot, absolute).split(sep).join('/')
      const relPath = `vault/notes/${rel}`
      if (isReservedPath(relPath)) return null
      return relPath
    }

    const flush = createDebouncer(
      () => {
        const relPaths = [...new Set([...added, ...changed, ...removed])]
        const kind = removed.size > 0 && added.size === 0 && changed.size === 0 ? 'removed' : 'updated'
        added.clear()
        changed.clear()
        removed.clear()
        pendingChain = pendingChain
          .then(() => rebuildAndNotify(labId, relPaths, kind, onChange))
          .catch((error: unknown) => {
            console.warn('[CSLab] Vault 增量索引队列失败:', error)
          })
      },
      200,
      1200,
    )

    watcher.on('add', (absolute) => {
      const relPath = toRel(absolute)
      if (!relPath) return
      added.add(relPath)
      flush()
    })
    watcher.on('change', (absolute) => {
      const relPath = toRel(absolute)
      if (!relPath) return
      changed.add(relPath)
      flush()
    })
    watcher.on('unlink', (absolute) => {
      const relPath = toRel(absolute)
      if (!relPath) return
      removed.add(relPath)
      flush()
    })
    watcher.on('error', (error) => {
      console.warn('[CSLab] Vault watcher 错误:', error)
    })

    watchers.set(labId, {
      close: async () => {
        flush.cancel()
        await watcher.close()
      },
    })
    return { watching: true, message: '已监听 vault/notes' }
  } catch (error) {
    console.warn('[CSLab] 启动 Vault watcher 失败:', error)
    return { watching: false, message: '无法启动 Vault 监听' }
  }
}

async function rebuildAndNotify(
  labId: string,
  relPaths: string[],
  kind: CsLabVaultChangedEvent['kind'],
  onChange: (event: CsLabVaultChangedEvent) => void,
): Promise<void> {
  // 单文件增量索引：避免每次 Obsidian 保存都全量扫描万篇笔记。
  for (const relPath of relPaths) {
    try {
      await indexSingleNote(labId, relPath)
    } catch (error) {
      console.warn(`[CSLab] 笔记增量索引失败: ${relPath}`, error)
    }
  }
  onChange({ labId, relPaths, kind })
}

export async function stopVaultWatcher(labIdInput: string): Promise<VaultWatcherStatus> {
  const labId = assertLabId(labIdInput)
  const active = watchers.get(labId)
  if (!active) return { watching: false, message: '监听未开启' }
  watchers.delete(labId)
  try {
    await active.close()
    return { watching: false, message: '监听已停止' }
  } catch (error) {
    console.warn('[CSLab] 关闭 Vault watcher 失败:', error)
    return { watching: false, message: '监听已停止（关闭句柄时出现异常）' }
  }
}

export async function closeAllVaultWatchers(): Promise<void> {
  for (const [labId, active] of [...watchers.entries()]) {
    watchers.delete(labId)
    try {
      await active.close()
    } catch {
      // 进程退出路径，忽略。
    }
  }
}

export function isVaultWatcherActive(labIdInput: string): boolean {
  try {
    return watchers.has(assertLabId(labIdInput))
  } catch {
    return false
  }
}

/** 供测试读取实验室 Canvas 根目录。 */
export function getCanvasNotesDir(labIdInput: string): string {
  return resolveLabRelativePath(assertLabId(labIdInput), 'vault/notes')
}
