/**
 * CSLab 原子写工具（Windows 加固）
 *
 * 背景：Windows 下 Obsidian / Defender 可能持有目标文件或临时文件句柄，
 * 导致 `rename` 抛出 EPERM/EBUSY/EACCES。这里采用三级降级：
 *   1. `.tmp → rename`（50/100/150ms 退避重试 3 次）
 *   2. 原地写入（调用方允许时）
 *   3. 抛出 CsLabFileBusyError，由业务层写冲突副本
 *
 * 红线：任何路径都不得吞掉异常后伪造成“写入成功”。
 */

import { promises as fs } from 'node:fs'

export type CsLabWriteDurability = 'atomic' | 'in-place'

export interface CsLabAtomicWriteResult {
  path: string
  durability: CsLabWriteDurability
}

export class CsLabFileBusyError extends Error {
  readonly code: string

  constructor(message: string, code = 'EBUSY') {
    super(message)
    this.name = 'CsLabFileBusyError'
    this.code = code
  }
}

export interface CsLabAtomicWriteOptions {
  /** 是否允许 rename 失败后原地写入；默认 true（画布场景）。 */
  allowInPlaceFallback?: boolean
  /** 退避重试间隔（毫秒）。 */
  retryDelaysMs?: number[]
}

interface AtomicWriteDeps {
  rename: (oldPath: string, newPath: string) => Promise<void>
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>
  rm: (path: string, options: { force: boolean }) => Promise<void>
  delay: (ms: number) => Promise<void>
}

const defaultDeps: AtomicWriteDeps = {
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (path, data) => fs.writeFile(path, data),
  rm: (path, options) => fs.rm(path, options),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

const DEFAULT_RETRY_DELAYS = [50, 100, 150]

function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function writeWithFallback(
  targetPath: string,
  data: string | Uint8Array,
  options: CsLabAtomicWriteOptions,
  deps: AtomicWriteDeps,
): Promise<CsLabAtomicWriteResult> {
  const tmpPath = `${targetPath}.tmp`
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const allowInPlace = options.allowInPlaceFallback !== false

  try {
    await deps.writeFile(tmpPath, data)
  } catch (error) {
    if (isBusyError(error)) {
      throw new CsLabFileBusyError('无法写入临时文件，目标目录可能被占用')
    }
    throw error
  }

  let lastError: unknown
  // 首次尝试 + 最多 3 次退避重试。
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      await deps.rename(tmpPath, targetPath)
      return { path: targetPath, durability: 'atomic' }
    } catch (error) {
      lastError = error
      if (!isBusyError(error) || attempt === retryDelays.length) break
      await deps.delay(retryDelays[attempt] ?? 150)
    }
  }

  if (allowInPlace && isBusyError(lastError)) {
    try {
      await deps.writeFile(targetPath, data)
      await deps.rm(tmpPath, { force: true }).catch(() => undefined)
      return { path: targetPath, durability: 'in-place' }
    } catch (inPlaceError) {
      await deps.rm(tmpPath, { force: true }).catch(() => undefined)
      const code = (inPlaceError as NodeJS.ErrnoException | undefined)?.code ?? 'EBUSY'
      throw new CsLabFileBusyError('目标文件被其他程序占用，写入失败', code)
    }
  }

  await deps.rm(tmpPath, { force: true }).catch(() => undefined)
  if (isBusyError(lastError)) {
    throw new CsLabFileBusyError('目标文件被其他程序占用，写入失败')
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function writeTextAtomic(
  targetPath: string,
  content: string,
  options: CsLabAtomicWriteOptions = {},
  deps: AtomicWriteDeps = defaultDeps,
): Promise<CsLabAtomicWriteResult> {
  return writeWithFallback(targetPath, content, options, deps)
}

export async function writeBufferAtomic(
  targetPath: string,
  content: Uint8Array,
  options: CsLabAtomicWriteOptions = {},
  deps: AtomicWriteDeps = defaultDeps,
): Promise<CsLabAtomicWriteResult> {
  return writeWithFallback(targetPath, content, options, deps)
}

/** 供单测注入 EPERM 等故障。 */
export function __createAtomicWriteDeps(overrides: Partial<AtomicWriteDeps>): AtomicWriteDeps {
  return { ...defaultDeps, ...overrides }
}
