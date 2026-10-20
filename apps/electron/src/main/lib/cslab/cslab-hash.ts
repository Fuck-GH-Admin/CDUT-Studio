/**
 * CSLab 文件完整性工具
 *
 * 提供流式 SHA-256、渐进复制落盘、跨平台只读锁。
 * Windows 下 fs.chmod 无法可靠阻止覆写/删除，必须叠加 attrib +r。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FileDigest {
  sha256: string
  bytes: number
}

/** 流式计算文件 SHA-256。 */
export async function hashFileStream(filePath: string): Promise<FileDigest> {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    bytes += buffer.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * 边复制边计算 SHA-256，结束后 fsync 落盘。
 * 目标目录必须已存在。
 */
export async function copyFileWithHash(sourcePath: string, targetPath: string): Promise<FileDigest> {
  const hash = createHash('sha256')
  let bytes = 0
  const reader = createReadStream(sourcePath)
  const writer = createWriteStream(targetPath)

  try {
    for await (const chunk of reader) {
      const buffer = chunk as Buffer
      hash.update(buffer)
      bytes += buffer.length
      if (!writer.write(buffer)) await once(writer, 'drain')
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
    // fsync：确保网络瞬断或进程崩溃时不会留下半截文件。
    const handle = await fs.open(targetPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    writer.destroy()
    await fs.rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }

  return { sha256: hash.digest('hex'), bytes }
}

/**
 * 设置文件只读锁。
 * - 非 Windows：chmod 0o444；
 * - Windows：chmod 后追加 attrib +r（NTFS 只读属性）。
 * 返回是否全部成功；失败只告警，不伪造成功。
 */
export async function lockFileReadOnly(filePath: string): Promise<boolean> {
  let ok = true
  try {
    await fs.chmod(filePath, 0o444)
  } catch (error) {
    ok = false
    console.warn(`[CSLab] chmod 只读失败: ${filePath}`, error)
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('attrib', ['+r', filePath])
    } catch (error) {
      ok = false
      console.warn(`[CSLab] attrib +r 失败: ${filePath}`, error)
    }
  }
  return ok
}

/** 解除只读锁（仅用于测试与用户显式删除资产）。 */
export async function unlockFile(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o666).catch(() => undefined)
  if (process.platform === 'win32') {
    await execFileAsync('attrib', ['-r', filePath]).catch(() => undefined)
  }
}

/** 判断文件当前是否带只读位（stat 模式位判断，跨平台近似）。 */
export async function isFileReadOnly(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return (stat.mode & 0o200) === 0
  } catch {
    return false
  }
}
