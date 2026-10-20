/**
 * CSLab uv 静默自举
 *
 * 红线：
 * 1. 只下载官方 uv 单文件二进制；校验按「官方指纹 → 内嵌固定哈希 → 镜像自证 + 用户确认」分级，
 *    哈希不符一律拒绝，绝不执行未校验文件；
 * 2. 多源镜像 + 短超时 + 即时熔断；任何失败立即回退系统 Python，不阻断依赖安装；
 * 3. 临时文件全部落在配置目录 tools/uv/.tmp-download，并在 finally 清理。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import type { CsLabUvEnsureResult } from '@profer/shared'
import { writeBufferAtomic } from './cslab-atomic'
import { appendUvInstallAudit } from './cslab-uv-consent'
import { getConfigDir } from '../config-paths'

const execFileAsync = promisify(execFile)

/** 锁定稳定版 tag：升级 uv 时同步更新此 tag、哈希表与日期注释。 */
const UV_RELEASE_TAG = '0.13.3'
const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_RELEASE_TAG}`
const MIRROR_BASES = [
  `https://ghproxy.net/https://github.com/astral-sh/uv/releases/download/${UV_RELEASE_TAG}`,
  `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/${UV_RELEASE_TAG}`,
]

/**
 * 内嵌固定哈希表（离线可信根）。
 * 来源：astral-sh/uv 0.13.3 官方 release 的 asset digest（2026-10-20 核对）。
 */
const UV_PINNED_SHA256: Record<string, string> = {
  'uv-x86_64-pc-windows-msvc.zip': 'bb701bd35b586c45966654ea2703c9bd116a6a4fc0a8ca755bd644c2c41c5ebe',
  'uv-aarch64-pc-windows-msvc.zip': 'aeaca1a1b721c1686c09b4aa23d57f938df049bed1b8e534b5bf79a032b8b87b',
  'uv-x86_64-apple-darwin.tar.gz': '5c35634957db7ebd9c2e4cc6c66b8979fb2c26a6b0dbd1d214d6acbac4033a89',
  'uv-aarch64-apple-darwin.tar.gz': 'bf1e4fb6f5f5079a2902ad3f3a9e2d337575b226a1378f2449d8404353650608',
  'uv-x86_64-unknown-linux-gnu.tar.gz': 'e4f169ec380f1793b898a6f1fcbacd22db25cf7ca0349a6e96ffb85b69998d04',
  'uv-aarch64-unknown-linux-gnu.tar.gz': '611ff684f193a84d2fdad29c5f12505d02ece94984c7c982cdde950eba5c95b9',
}

const ASSET_TIMEOUT_MS = 45_000
const CHECKSUM_TIMEOUT_MS = 12_000
/** 全部下载源的总熔断时限，避免校园网卡住安装流程。 */
const TOTAL_DOWNLOAD_BUDGET_MS = 60_000

/** 非官方指纹但镜像自证一致时的用户确认入口；未注入一律视为拒绝。 */
export type UvUntrustedInstallGuard = (info: {
  asset: string
  sourceUrl: string
  actualSha256: string
}) => Promise<boolean>

export interface UvEnsureOptions {
  labId?: string
  fetchImpl?: typeof fetch
  onProgress?: (progress: UvProgress) => void
  confirmUntrustedInstall?: UvUntrustedInstallGuard
}

export type UvChecksumVerdict = 'official' | 'pinned' | 'mirror-consent' | 'reject'

/**
 * 校验分级判定（纯函数）：
 * - 官方哈希一旦取到即为权威，不符直接拒绝；
 * - 内嵌表可能落后于上游，命中即强信任，未命中继续降级；
 * - 镜像哈希只用于判断传输损坏，相符也必须用户确认。
 */
export function classifyUvChecksum(input: {
  actual: string
  official?: string | null
  pinned?: string | null
  mirror?: string | null
}): UvChecksumVerdict {
  if (input.official) return input.official === input.actual ? 'official' : 'reject'
  if (input.pinned && input.pinned === input.actual) return 'pinned'
  if (input.mirror && input.mirror !== input.actual) return 'reject'
  if (input.mirror === input.actual) return 'mirror-consent'
  return 'reject'
}

/** 用户在确认弹窗中选择取消时抛出，用于终止整轮下载而不是逐个镜像重试。 */
class UvConsentDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UvConsentDeniedError'
  }
}

export interface UvTarget {
  /** 例如 x86_64-pc-windows-msvc */
  target: string
  asset: string
  archive: 'zip' | 'tar.gz'
}

export interface UvProgress {
  stage: 'probe' | 'download' | 'verify' | 'extract' | 'done' | 'error'
  message: string
}

export interface UvEnsureOutcome {
  binary: string | null
  source?: 'path' | 'downloaded'
  message: string
}

/** 平台/架构 → 官方 release 资产名。 */
export function resolveUvTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UvTarget | null {
  const key = `${platform}/${arch}`
  const table: Record<string, UvTarget> = {
    'win32/x64': {
      target: 'x86_64-pc-windows-msvc',
      asset: 'uv-x86_64-pc-windows-msvc.zip',
      archive: 'zip',
    },
    'win32/arm64': {
      target: 'aarch64-pc-windows-msvc',
      asset: 'uv-aarch64-pc-windows-msvc.zip',
      archive: 'zip',
    },
    'darwin/arm64': {
      target: 'aarch64-apple-darwin',
      asset: 'uv-aarch64-apple-darwin.tar.gz',
      archive: 'tar.gz',
    },
    'darwin/x64': {
      target: 'x86_64-apple-darwin',
      asset: 'uv-x86_64-apple-darwin.tar.gz',
      archive: 'tar.gz',
    },
    'linux/x64': {
      target: 'x86_64-unknown-linux-gnu',
      asset: 'uv-x86_64-unknown-linux-gnu.tar.gz',
      archive: 'tar.gz',
    },
    'linux/arm64': {
      target: 'aarch64-unknown-linux-gnu',
      asset: 'uv-aarch64-unknown-linux-gnu.tar.gz',
      archive: 'tar.gz',
    },
  }
  return table[key] ?? null
}

/** 解析 `.sha256` 文本（首列为 64 位十六进制）。 */
export function parseUvChecksum(text: string): string | null {
  const match = /([a-fA-F0-9]{64})/.exec(text)
  return match ? match[1]!.toLowerCase() : null
}

export function getUvInstallDir(target: string): string {
  return join(getConfigDir(), 'tools', 'uv', target)
}

export function getUvBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv'
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function buildSourceUrls(asset: string): string[] {
  const sources: string[] = []
  const custom = process.env.CSLAB_UV_MIRROR?.trim()
  if (custom) sources.push(`${custom.replace(/\/+$/, '')}/${asset}`)
  sources.push(`${UV_RELEASE_BASE}/${asset}`)
  for (const base of MIRROR_BASES) sources.push(`${base}/${asset}`)
  return [...new Set(sources)]
}

async function fetchBuffer(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

async function extractZipArchive(archive: Buffer, targetPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(archive)
  const entry = Object.values(zip.files).find(
    (file) => !file.dir && /(^|\/)uv(\.exe)?$/i.test(file.name),
  )
  if (!entry) throw new Error('zip 内未找到 uv 可执行文件')
  const data = await entry.async('nodebuffer')
  await writeBufferAtomic(targetPath, new Uint8Array(data), { allowInPlaceFallback: false })
}

async function findFileRecursive(root: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return absolute
    if (entry.isDirectory()) {
      const found = await findFileRecursive(absolute, name)
      if (found) return found
    }
  }
  return null
}

async function extractTarArchive(
  archive: Buffer,
  archivePath: string,
  tempDir: string,
  binaryName: string,
  targetPath: string,
): Promise<void> {
  await fs.writeFile(archivePath, archive)
  await execFileAsync('tar', ['-xzf', archivePath, '-C', tempDir], {
    timeout: 60_000,
    windowsHide: true,
  })
  const extracted = await findFileRecursive(tempDir, binaryName)
  if (!extracted) throw new Error('tar.gz 内未找到 uv 可执行文件')
  const data = await fs.readFile(extracted)
  await writeBufferAtomic(targetPath, new Uint8Array(data), { allowInPlaceFallback: false })
}

interface UvInstallAttempt {
  target: UvTarget
  sourceUrl: string
  fetchImpl: typeof fetch
  onProgress?: (progress: UvProgress) => void
  /** 官方指纹（整轮最多请求一次）；不可达时为 null。 */
  getOfficialChecksum: () => Promise<string | null>
  confirmUntrustedInstall?: UvUntrustedInstallGuard
}

interface UvInstallResult {
  binary: string
  verdict: UvChecksumVerdict
  actualSha256: string
}

async function fetchChecksum(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const buffer = await fetchBuffer(url, CHECKSUM_TIMEOUT_MS, fetchImpl)
    return parseUvChecksum(buffer.toString('utf-8'))
  } catch {
    return null
  }
}

async function installFromSource(attempt: UvInstallAttempt): Promise<UvInstallResult> {
  const { target, sourceUrl, fetchImpl, onProgress } = attempt
  const tempRoot = join(getConfigDir(), 'tools', 'uv', '.tmp-download')
  await fs.mkdir(tempRoot, { recursive: true })
  const assetPath = join(tempRoot, target.asset)
  const binaryName = getUvBinaryName()

  try {
    onProgress?.({ stage: 'download', message: `下载 ${target.asset}` })
    const archive = await fetchBuffer(sourceUrl, ASSET_TIMEOUT_MS, fetchImpl)
    onProgress?.({ stage: 'verify', message: '校验 SHA-256' })

    const actual = createHash('sha256').update(archive).digest('hex')
    const pinned = UV_PINNED_SHA256[target.asset] ?? null
    const official = await attempt.getOfficialChecksum()

    let verdict = classifyUvChecksum({ actual, official, pinned })
    if (verdict === 'reject' && !official) {
      // 强信任源都不可用：退到镜像自证，仅用于判断传输是否损坏。
      const mirror = await fetchChecksum(`${sourceUrl}.sha256`, fetchImpl)
      verdict = classifyUvChecksum({ actual, official: null, pinned: null, mirror })
    }

    if (verdict === 'reject') {
      throw new Error('SHA-256 校验不匹配，已拒绝安装未授信资产')
    }

    if (verdict === 'mirror-consent') {
      const allowed = attempt.confirmUntrustedInstall
        ? await attempt.confirmUntrustedInstall({
            asset: target.asset,
            sourceUrl,
            actualSha256: actual,
          })
        : false
      if (!allowed) {
        throw new UvConsentDeniedError('用户取消安装未通过官方指纹验证的 uv')
      }
    }

    onProgress?.({ stage: 'extract', message: '解压 uv 二进制' })
    const installDir = getUvInstallDir(target.target)
    await fs.mkdir(installDir, { recursive: true })
    const targetPath = join(installDir, binaryName)
    // 旧二进制可能损坏或被占用，先清理再写入。
    await fs.rm(targetPath, { force: true }).catch(() => undefined)

    if (target.archive === 'zip') {
      await extractZipArchive(archive, targetPath)
    } else {
      const tempExtract = join(tempRoot, `extract-${Date.now()}`)
      await fs.mkdir(tempExtract, { recursive: true })
      await extractTarArchive(archive, assetPath, tempExtract, binaryName, targetPath)
      await fs.rm(tempExtract, { recursive: true, force: true }).catch(() => undefined)
    }

    if (process.platform !== 'win32') await fs.chmod(targetPath, 0o755)

    if (!(await commandWorks(targetPath, ['--version']))) {
      await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('uv 可执行文件无法启动（可能被安全软件拦截）')
    }
    return { binary: targetPath, verdict, actualSha256: actual }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(assetPath, { force: true }).catch(() => undefined)
  }
}

/**
 * 确保 uv 可用：PATH → 已下载 → 多源下载（三级校验 + 用户确认兜底）。
 * 全链路失败时返回 binary=null（熔断），由调用方回退系统 Python。
 */
let uvEnsureInFlight: Promise<UvEnsureOutcome> | null = null

export function ensureUv(options: UvEnsureOptions = {}): Promise<UvEnsureOutcome> {
  // 并发调用（安装依赖 + 手动确保 uv）共享同一次下载，避免临时目录互相覆盖。
  if (!uvEnsureInFlight) {
    uvEnsureInFlight = ensureUvInternal(options).finally(() => {
      uvEnsureInFlight = null
    })
  }
  return uvEnsureInFlight
}

async function ensureUvInternal(options: UvEnsureOptions = {}): Promise<UvEnsureOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const onProgress = options.onProgress

  onProgress?.({ stage: 'probe', message: '探测 uv' })
  if (await commandWorks('uv', ['--version'])) {
    return { binary: 'uv', source: 'path', message: '已检测到系统 uv' }
  }

  const target = resolveUvTarget()
  if (!target) {
    return { binary: null, message: '当前平台暂不支持自动下载 uv' }
  }

  const binaryName = getUvBinaryName()
  const installed = join(getUvInstallDir(target.target), binaryName)
  if (await commandWorks(installed, ['--version'])) {
    return { binary: installed, source: 'downloaded', message: '已使用本地 uv 缓存' }
  }

  // 官方指纹整轮最多请求一次，避免每个镜像源都等待 12s 超时。
  let officialChecksumRequest: Promise<string | null> | null = null
  const getOfficialChecksum = (): Promise<string | null> => {
    officialChecksumRequest ??= fetchChecksum(`${UV_RELEASE_BASE}/${target.asset}.sha256`, fetchImpl)
    return officialChecksumRequest
  }

  const sources = buildSourceUrls(target.asset)
  const startedAt = Date.now()
  for (const source of sources) {
    if (Date.now() - startedAt > TOTAL_DOWNLOAD_BUDGET_MS) {
      console.warn('[CSLab] uv 下载总时限已耗尽，立即回退系统 Python')
      break
    }
    try {
      const result = await installFromSource({
        target,
        sourceUrl: source,
        fetchImpl,
        onProgress,
        getOfficialChecksum,
        confirmUntrustedInstall: options.confirmUntrustedInstall,
      })
      // mirror-consent 的审计已由确认弹窗侧写入，避免重复记录。
      if (result.verdict !== 'mirror-consent') {
        void appendUvInstallAudit({
          asset: target.asset,
          source,
          sha256: result.actualSha256,
          verdict: result.verdict,
          decision: 'auto',
        })
      }
      onProgress?.({ stage: 'done', message: 'uv 就绪' })
      return {
        binary: result.binary,
        source: 'downloaded',
        message:
          result.verdict === 'mirror-consent'
            ? '已按用户确认使用非官方镜像版本 uv'
            : 'uv 自动下载并校验成功',
      }
    } catch (error) {
      if (error instanceof UvConsentDeniedError) {
        onProgress?.({ stage: 'error', message: '已取消安装未授信 uv，回退系统 Python' })
        return { binary: null, message: '已取消安装未通过官方指纹验证的 uv，已回退系统 Python' }
      }
      console.warn(`[CSLab] uv 下载源失败（${source}）:`, error)
    }
  }

  onProgress?.({ stage: 'error', message: 'uv 不可用，回退系统 Python' })
  return { binary: null, message: 'uv 下载/校验失败，已回退系统 Python' }
}

export async function ensureUvBinary(options: UvEnsureOptions = {}): Promise<string | null> {
  return (await ensureUv(options)).binary
}

/** 面向 IPC 的结果。 */
export async function ensureUvForLab(
  labId: string,
  options: Omit<UvEnsureOptions, 'labId'> = {},
): Promise<CsLabUvEnsureResult> {
  const outcome = await ensureUv({ ...options, labId })
  if (!outcome.binary) return { ok: false, message: outcome.message }
  return {
    ok: true,
    uvPath: outcome.binary,
    source: outcome.source === 'downloaded' ? 'downloaded' : 'path',
    message: outcome.message,
  }
}
