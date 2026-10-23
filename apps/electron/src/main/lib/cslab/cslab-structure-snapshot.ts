/**
 * CSLab 3D 晶体视窗快照服务（主进程）
 *
 * 链路：
 * 1. Agent 工具调用 `requestStructureSnapshot` -> 广播 REQUEST_STRUCTURE_SNAPSHOT；
 * 2. 渲染进程用 Mol* 视口截图并 invoke SNAPSHOT_STRUCTURE 回传 PNG DataURL；
 * 3. 本服务校验 PNG 头、写盘到 `vault/figures/` 并结算挂起的请求。
 *
 * 本文件保持 Electron-free（事件出口统一收敛在 cslab-events），便于 bun test 直跑。
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  CsLabStructureSnapshotOptions,
  CsLabStructureSnapshotResult,
  CsLabStructureSnapshotSubmitInput,
} from '@profer/shared'
import { CSLAB_IPC_CHANNELS } from './cslab-types'
import {
  assertLabId,
  resolveLabDir,
  sanitizeFileName,
  toLabRelativePath,
} from './cslab-paths'
import { broadcastCsLabEvent } from './cslab-events'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_HEADER_BYTES = 24
const DEFAULT_TIMEOUT_MS = 20_000

interface PendingSnapshot {
  resolve: (result: CsLabStructureSnapshotResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pendingSnapshots = new Map<string, PendingSnapshot>()

/** 归一化超采样倍率：仅允许 1|2|3，缺省 2。 */
export function normalizeSnapshotScale(scale: number | undefined): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 2
  return Math.max(1, Math.min(3, Math.round(scale)))
}

/** 解码 PNG DataURL，并校验魔数与最小长度。 */
export function decodePngDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('快照数据不是合法的 PNG DataURL')
  const buffer = Buffer.from(match[1]!, 'base64')
  if (buffer.length < PNG_HEADER_BYTES) throw new Error('快照 PNG 数据不完整')
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('快照 PNG 文件头校验失败')
  }
  return buffer
}

/** 读取 PNG IHDR 中的像素宽高。 */
export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < PNG_HEADER_BYTES) throw new Error('快照 PNG 数据不完整')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width <= 0 || height <= 0) throw new Error('快照 PNG 尺寸无效')
  return { width, height }
}

function settlePendingSnapshot(
  requestId: string,
  error: Error | null,
  result?: CsLabStructureSnapshotResult,
): void {
  const pending = pendingSnapshots.get(requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingSnapshots.delete(requestId)
  if (error) pending.reject(error)
  else if (result) pending.resolve(result)
}

/** 写出 PNG 快照到 `vault/figures/`。 */
export async function writeStructureSnapshot(input: {
  labId: string
  dataUrl: string
  filenamePrefix?: string
}): Promise<CsLabStructureSnapshotResult> {
  const labId = assertLabId(input.labId)
  const buffer = decodePngDataUrl(input.dataUrl)
  const { width, height } = pngDimensions(buffer)

  const figuresDir = join(resolveLabDir(labId), 'vault', 'figures')
  await fs.mkdir(figuresDir, { recursive: true })
  const prefix = sanitizeFileName(input.filenamePrefix?.trim() || 'structure')
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 8)
  const fileName = `${prefix}-${Date.now()}-${digest}.png`
  const targetPath = join(figuresDir, fileName)
  await fs.writeFile(targetPath, buffer)

  return {
    path: targetPath,
    relPath: toLabRelativePath(labId, targetPath),
    width,
    height,
    bytes: buffer.length,
  }
}

/**
 * 向渲染进程请求当前 3D 视窗快照，等待其回传并落盘。
 * 渲染进程无可见视窗时必须通过 `error` 字段快速熔断，避免空等超时。
 */
export function requestStructureSnapshot(
  input: CsLabStructureSnapshotOptions & { timeoutMs?: number },
): Promise<CsLabStructureSnapshotResult> {
  const labId = assertLabId(input.labId)
  const scale = normalizeSnapshotScale(input.scale)
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const requestId = `snap-${Date.now()}-${randomUUID().slice(0, 8)}`

  return new Promise<CsLabStructureSnapshotResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSnapshots.delete(requestId)
      reject(new Error(`未能在 ${Math.round(timeoutMs / 1000)} 秒内取得 3D 视窗快照，请确认 CSLab 工作台已打开且晶体视窗可见`))
    }, timeoutMs)
    pendingSnapshots.set(requestId, { resolve, reject, timer })
    broadcastCsLabEvent(CSLAB_IPC_CHANNELS.REQUEST_STRUCTURE_SNAPSHOT, {
      requestId,
      labId,
      scale,
    })
  })
}

/** 渲染进程回传快照（或失败原因）；成功时写盘并结算挂起请求。 */
export async function submitStructureSnapshot(
  input: CsLabStructureSnapshotSubmitInput,
): Promise<CsLabStructureSnapshotResult> {
  const requestId = input.requestId?.trim()
  try {
    if (input.error) throw new Error(input.error)
    if (!input.dataUrl) throw new Error('快照数据为空')
    const result = await writeStructureSnapshot({
      labId: input.labId,
      dataUrl: input.dataUrl,
      filenamePrefix: input.filenamePrefix,
    })
    if (requestId) settlePendingSnapshot(requestId, null, result)
    return result
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error('快照导出失败')
    if (requestId) settlePendingSnapshot(requestId, normalized)
    throw normalized
  }
}
