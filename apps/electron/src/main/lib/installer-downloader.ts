/**
 * 第三方安装包下载器
 *
 * 从 OSS / 官方源下载 Git、Node.js 安装程序到本地临时目录，
 * 下载过程中通过 BrowserWindow 事件推送进度，完成后校验 sha256。
 */

import { createHash } from 'crypto'
import { createWriteStream, existsSync, promises as fsp, type WriteStream } from 'fs'
import { get as httpsGet } from 'https'
import { get as httpGet, IncomingMessage } from 'http'
import path from 'path'
import { URL } from 'url'

import { app, BrowserWindow, shell } from 'electron'

import {
  INSTALLER_IPC_CHANNELS,
  assertSafeUrlNoNul,
  type InstallerDownloadResult,
  type InstallerProgressPayload,
  type InstallerSource,
} from '@profer/shared'

/** 已注册的可取消下载：key -> cancel() */
const activeDownloads = new Map<string, () => void>()

/** 临时文件后缀：下载未完成时保留 `<filePath>.part`，供下次续传 */
const PART_SUFFIX = '.part'

/**
 * 构造 Range 请求头
 *
 * 无已下载数据（size <= 0 / 非法值）时不带 Range，走完整下载。
 * @param existingBytes 本地 .part 已有字节数
 * @returns Range 头值，如 `bytes=1024-`；无需 Range 时返回 undefined
 */
export function buildRangeHeader(existingBytes: number): string | undefined {
  if (!Number.isFinite(existingBytes) || existingBytes <= 0) return undefined
  return `bytes=${Math.floor(existingBytes)}-`
}

/** Content-Range 解析结果 */
export interface ContentRange {
  /** 本次响应体在完整文件中的起始偏移 */
  start: number
  /** 本次响应体在完整文件中的结束偏移（含） */
  end: number
  /** 完整文件总长度；服务端返回 `*` 时为 null */
  total: number | null
}

/**
 * 解析 206 响应的 `Content-Range: bytes <start>-<end>/<total|*>`
 * @param header 原始头值
 * @returns 解析结果；缺失或格式非法时返回 null
 */
export function parseContentRange(
  header: string | null | undefined,
): ContentRange | null {
  if (!header) return null
  const matched = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim())
  if (!matched) return null
  const start = Number(matched[1])
  const end = Number(matched[2])
  const total = matched[3] === '*' ? null : Number(matched[3])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  if (total !== null && !Number.isFinite(total)) return null
  return { start, end, total }
}

/**
 * 是否为 416 Range Not Satisfiable
 *
 * 典型场景：本地 .part 比服务端文件还长（远端文件被替换），此时 Range 不可满足，
 * 必须丢弃 .part 从头下载。
 */
export function isRangeNotSatisfiable(statusCode: number | null | undefined): boolean {
  return statusCode === 416
}

/**
 * 构造安装包的本地缓存目录
 */
function getInstallerDir(): string {
  return path.join(app.getPath('temp'), 'profer-installers')
}

/**
 * 下载单个安装包：优先 downloadUrl，失败自动 fallback 到 fallbackUrl
 *
 * @param source 安装包元数据
 * @param key 去重键（前端可据此关联进度事件与取消）
 * @param sender 用于推进度事件的窗口（通常是发起下载的 BrowserWindow）
 */
export async function downloadInstaller(
  source: InstallerSource,
  key: string,
  sender?: BrowserWindow,
): Promise<InstallerDownloadResult> {
  const dir = getInstallerDir()
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, source.filename)

  // 尝试主 URL，失败再尝试 fallback
  const urls = [source.downloadUrl, source.fallbackUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  if (urls.length === 0) {
    throw new Error('安装包清单缺少有效 URL')
  }

  let lastError: unknown = null
  for (const [index, url] of urls.entries()) {
    try {
      await downloadToFile(url, filePath, source, key, sender)
      const sha256 = await computeSha256(filePath)
      if (source.sha256 && sha256.toLowerCase() !== source.sha256.toLowerCase()) {
        await fsp.unlink(filePath).catch(() => {})
        await fsp.unlink(`${filePath}${PART_SUFFIX}`).catch(() => {})
        throw new Error(
          `sha256 校验失败：期望 ${source.sha256}，实际 ${sha256}`,
        )
      }
      if (!source.sha256) {
        console.warn(
          `[Installer] ${source.filename} 清单未提供 sha256，跳过校验`,
        )
      }
      return { filePath, sha256 }
    } catch (error) {
      lastError = error
      const isCancelled =
        error instanceof Error && error.message === 'cancelled'
      if (isCancelled) {
        // 用户取消不降级到 fallback
        throw error
      }
      console.warn(
        `[Installer] 从 ${url} 下载失败，尝试下一个源：`,
        error,
      )
      await fsp.unlink(filePath).catch(() => {})
      // .part 里是当前源的字节，换成另一个源之前必须丢弃，否则续传会拼出损坏文件。
      // 最后一个源失败时保留 .part：同一源再次下载可续传，最终仍有 sha256 校验兜底。
      if (index < urls.length - 1) {
        await fsp.unlink(`${filePath}${PART_SUFFIX}`).catch(() => {})
      }
    }
  }

  throw (lastError as Error) ?? new Error('所有下载源均失败')
}

/**
 * 读取 `.part` 已有字节数，用于断点续传
 *
 * 文件不存在、不是普通文件或长度为 0 时返回 0（视为从头下载）。
 */
async function readResumableBytes(partPath: string): Promise<number> {
  try {
    const stat = await fsp.stat(partPath)
    return stat.isFile() && stat.size > 0 ? stat.size : 0
  } catch {
    return 0
  }
}

/**
 * 流式下载单个 URL 到指定文件，支持自动跟随 3xx 重定向与断点续传
 *
 * 断点续传协议：
 * - 数据先写 `<filePath>.part`；下次启动时若 .part 有内容，请求带 `Range: bytes=<size>-`
 * - 206 → 以 append 模式继续写 .part，进度从已有 size 起算
 * - 200 → 服务端不支持 Range，truncate 后从头写
 * - 416 → Range 不可满足（.part 比远端文件更长），删除 .part 后重下一次
 * - 完成后 rename .part → filePath，由调用方做 sha256 校验
 */
async function downloadToFile(
  url: string,
  filePath: string,
  source: InstallerSource,
  key: string,
  sender: BrowserWindow | undefined,
): Promise<void> {
  const partPath = `${filePath}${PART_SUFFIX}`
  const resumableBytes = await readResumableBytes(partPath)

  return new Promise<void>((resolve, reject) => {
    let cancelled = false
    let settled = false
    let requestToAbort: { destroy: (err?: Error) => void } | null = null
    let activeStream: WriteStream | null = null

    const cancel = () => {
      cancelled = true
      if (requestToAbort) {
        requestToAbort.destroy(new Error('cancelled'))
      }
    }
    activeDownloads.set(key, cancel)

    const cleanup = () => {
      activeDownloads.delete(key)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      // 失败/取消不删除 .part：已写入的字节保留给下次续传。
      if (activeStream) {
        const stream = activeStream
        activeStream = null
        stream.destroy()
      }
      reject(error)
    }

    const getModule = (u: URL) => (u.protocol === 'http:' ? httpGet : httpsGet)

    /**
     * @param targetUrl 本次请求地址（可能来自重定向）
     * @param redirectsLeft 剩余可跟随重定向次数
     * @param rangeStart 本次请求的续传起点（0 表示从头下载）
     * @param restartedFromScratch 是否已因 416 丢弃 .part 重试过，避免死循环
     */
    const doGet = (
      targetUrl: string,
      redirectsLeft: number,
      rangeStart: number,
      restartedFromScratch: boolean,
    ) => {
      let parsed: URL
      try {
        // NUL/控制字符前置校验（CVE-2026-105482 纵深防御）：初始源与重定向 Location 一并覆盖。
        assertSafeUrlNoNul(targetUrl)
        parsed = new URL(targetUrl)
      } catch (e) {
        fail(e)
        return
      }

      const rangeHeader = buildRangeHeader(rangeStart)
      const request = getModule(parsed)(
        targetUrl,
        rangeHeader ? { headers: { Range: rangeHeader } } : {},
        (res: IncomingMessage) => {
          // 处理重定向
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume()
            if (redirectsLeft <= 0) {
              fail(new Error('重定向次数过多'))
              return
            }
            const next = new URL(res.headers.location, parsed).toString()
            doGet(next, redirectsLeft - 1, rangeStart, restartedFromScratch)
            return
          }

          // 416：本地 .part 已超出远端文件长度，丢弃后从头重下一次
          if (isRangeNotSatisfiable(res.statusCode)) {
            res.resume()
            if (!restartedFromScratch && rangeStart > 0) {
              void fsp
                .unlink(partPath)
                .catch(() => {})
                .then(() => doGet(targetUrl, redirectsLeft, 0, true))
              return
            }
            fail(new Error('HTTP 416'))
            return
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume()
            fail(new Error(`HTTP ${res.statusCode ?? '?'}`))
            return
          }

          const contentLengthHeader = Number(res.headers['content-length'] ?? 0)
          const contentLength = contentLengthHeader > 0 ? contentLengthHeader : 0
          const rawContentRange = res.headers['content-range']
          const contentRange =
            res.statusCode === 206
              ? parseContentRange(
                  Array.isArray(rawContentRange) ? rawContentRange[0] : rawContentRange,
                )
              : null

          // 206 的起始偏移必须与本地 .part 长度一致，否则拼接会得到损坏文件
          const startAt = res.statusCode === 206 ? (contentRange?.start ?? rangeStart) : 0
          if (rangeStart > 0 && res.statusCode === 206 && startAt !== rangeStart) {
            res.resume()
            void fsp
              .unlink(partPath)
              .catch(() => {})
              .then(() =>
                fail(
                  new Error(
                    `Content-Range 起点不一致：本地 ${rangeStart} 字节，服务端从 ${startAt} 开始`,
                  ),
                ),
              )
            return
          }

          // 206 的 Content-Length 只是剩余字节，总长 = 起点 + 剩余；否则整文件长度
          const total =
            res.statusCode === 206
              ? (contentRange?.total ??
                (contentLength > 0 ? startAt + contentLength : source.sizeBytes))
              : contentLength > 0
                ? contentLength
                : source.sizeBytes
          const append = res.statusCode === 206 && rangeStart > 0 && startAt === rangeStart

          const stream = createWriteStream(partPath, { flags: append ? 'a' : 'w' })
          activeStream = stream

          let downloaded = startAt
          let lastEmit = Date.now()
          let lastEmitBytes = startAt

          res.on('data', (chunk: Buffer) => {
            if (cancelled) return
            downloaded += chunk.length
            const now = Date.now()
            if (now - lastEmit >= 250 || (total > 0 && downloaded >= total)) {
              const elapsed = (now - lastEmit) / 1000 || 1
              const speed = Math.round((downloaded - lastEmitBytes) / elapsed)
              lastEmit = now
              lastEmitBytes = downloaded
              emitProgress(sender, { key, downloaded, total, speed })
            }
          })

          res.on('error', (err) => fail(err))
          stream.on('error', (err) => fail(err))

          stream.on('finish', () => {
            activeStream = null
            if (cancelled) {
              fail(new Error('cancelled'))
              return
            }
            // 落盘完成后再原子替换，避免半成品覆盖既有文件
            fsp
              .rename(partPath, filePath)
              .then(() => {
                if (settled) return
                // 最终再发一次 100% 进度
                emitProgress(sender, {
                  key,
                  downloaded: total,
                  total,
                  speed: 0,
                })
                succeed()
              })
              .catch((err) => fail(err))
          })

          res.pipe(stream)
        },
      )

      requestToAbort = request

      request.on('error', (err: Error) => {
        fail(err)
      })
    }

    doGet(url, 5, resumableBytes, false)
  })
}

function emitProgress(sender: BrowserWindow | undefined, payload: InstallerProgressPayload) {
  if (!sender || sender.isDestroyed()) return
  sender.webContents.send(INSTALLER_IPC_CHANNELS.PROGRESS, payload)
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const buf = await fsp.readFile(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

/**
 * 取消正在进行的下载
 */
export function cancelInstallerDownload(key: string): boolean {
  const cancel = activeDownloads.get(key)
  if (cancel) {
    cancel()
    return true
  }
  return false
}

/**
 * 拉起已下载的安装程序
 *
 * Windows 下 shell.openPath 会用系统默认方式打开 .exe / .msi，
 * 等同于用户双击，由操作系统决定是否弹 UAC。
 */
export async function launchInstaller(filePath: string): Promise<void> {
  const errorMsg = await shell.openPath(filePath)
  if (errorMsg) {
    throw new Error(`无法拉起安装程序：${errorMsg}`)
  }
}

/** 清理已下载的安装包缓存目录 */
export async function cleanInstallerDir(): Promise<number> {
  const dir = getInstallerDir()
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    const files = await fsp.readdir(dir)
    for (const f of files) {
      try { await fsp.unlink(path.join(dir, f)); count++ } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count
}
