/**
 * CSLab 局域网仪器共享盘监听器
 *
 * 三件事：
 * 1. 发现：事件提示（chokidar）只用于「尽快扫描」，真正依据是增量枚举 + 时间戳水位；
 * 2. 完成判定：静默期（quietSeconds）内指纹不变才允许捕获；
 * 3. 捕获：独占读租约（Windows PowerShell/.NET）或 Node 稳定性校验，单通道流式写暂存
 *    + 渐进 SHA-256 + fsync + 原子重命名，再交给数据铁笼 ingestFiles 入库。
 *
 * 红线：
 * - 只有捕获并复验成功才标记 published，绝不让半截文件入库；
 * - 租约等级必须如实记录（protected-lease / inline-command-lease / node-stream-stability）；
 * - 任何异常都收敛为候选级 retry / quarantined，不抛未捕获异常中断主进程。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type {
  CsLabIngestResult,
  CsLabShareCandidate,
  CsLabShareCandidateState,
  CsLabShareEvidence,
  CsLabShareKind,
  CsLabShareLeaseType,
  CsLabShareScanResult,
  CsLabShareSourceInput,
  CsLabShareSourceSummary,
  CsLabShareStatusEvent,
} from '@profer/shared'
import { ingestFiles } from './cslab-iron-cage'
import {
  countShareCandidates,
  deleteShareSourceRow,
  findPublishedCandidateBySha,
  getShareCandidateRow,
  getShareDatabase,
  getShareSourceRow,
  listShareCandidateRows,
  listShareSourceRows,
  toShareCandidate,
  updateShareSourceStatus,
  upsertShareCandidateRow,
  upsertShareSourceRow,
  type CsLabShareCandidateRow,
  type CsLabShareSourceRow,
} from './cslab-share-db'
import { assertLabId, resolveLabDir, sanitizeFileName } from './cslab-paths'
import { decryptToken, encryptToken } from '../token-crypto'
import { resolveCsLabScript } from './cslab-python-runtime'

const DEFAULT_QUIET_SECONDS = 45
const DEFAULT_POLL_SECONDS = 30
const MIN_QUIET_SECONDS = 1
const MAX_QUIET_SECONDS = 3600
const MIN_POLL_SECONDS = 1
const MAX_POLL_SECONDS = 300
const MAX_SCAN_ENTRIES = 5000
const LEASE_TIMEOUT_MS = 5 * 60 * 1000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 120_000

const TEMP_FILE_RE = /(^~?\$)|(\.(tmp|partial|part|crdownload|lock)$)/i

export interface CsLabShareWatcherSink {
  onStatus?: (event: CsLabShareStatusEvent) => void
  onCaptured?: (labId: string, result: CsLabIngestResult) => void
}

interface WatcherHandle {
  labId: string
  sourceId: string
  timer: NodeJS.Timeout | null
  hintTimer: NodeJS.Timeout | null
  running: boolean
  /** chokidar 句柄（本地/UNC 才存在）。 */
  closer?: () => Promise<void>
}

interface WatcherLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown
  close(): Promise<void>
}

const watchers = new Map<string, WatcherHandle>()
const sinks = new Map<string, CsLabShareWatcherSink>()

/** 测试专用调参（仍受生产 clamp 约束）。 */
let tuningOverride: { quietSeconds?: number; pollSeconds?: number } | null = null

export function __setShareTuningForTest(
  value: { quietSeconds?: number; pollSeconds?: number } | null,
): void {
  tuningOverride = value
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function watcherKey(labId: string, sourceId: string): string {
  return `${labId}::${sourceId}`
}

function emitStatus(labId: string, sourceId: string, status: 'online' | 'offline' | 'error', message?: string): void {
  sinks.get(labId)?.onStatus?.({ labId, sourceId, status, message })
}

// ===== 路径规范化 =====

export interface NormalizedSharePath {
  kind: CsLabShareKind
  normalized: string
  host?: string
  share?: string
}

const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog'])

// 单标签 NetBIOS 名称会被 LLMNR / NBT-NS 广播解析，是凭据中继的经典入口；
// 但校园局域网共享盘普遍就是 lab-pc 这类单标签主机名，故只拦协议保留名。
const BLOCKED_SINGLE_LABEL_HOSTS = new Set(['wpad', 'isatap'])

/**
 * 共享源主机边界（覆盖 WebDAV 与 UNC / SMB 共享）。
 * 仅阻断云元数据、链路本地与回环；10/172.16/192.168 局域网 NAS 保持可用。
 * 注意：这里是同步静态判断，不做 DNS 解析。
 */
function assertSafeShareHost(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    throw new Error('安全拦截：禁止使用云厂商元数据服务作为共享盘源')
  }
  if (
    /^169\.254\./.test(host) ||
    host === '100.100.100.200' ||
    host === 'fd00:ec2::254' ||
    host.startsWith('fe80:')
  ) {
    throw new Error('安全拦截：禁止使用链路本地/云元数据地址作为共享盘源')
  }
  // Windows 会把 IPv6 地址折叠成 <addr>.ipv6-literal.net 的 UNC 别名，需一并拦截。
  if (host.endsWith('.ipv6-literal.net')) {
    throw new Error('安全拦截：禁止使用 IPv6 字面量别名作为共享盘源')
  }
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    /^127\./.test(host) ||
    host.startsWith('::ffff:')
  ) {
    throw new Error('安全拦截：禁止使用本机回环地址作为共享盘源，请直接添加本地路径')
  }
  if (BLOCKED_SINGLE_LABEL_HOSTS.has(host)) {
    throw new Error('安全拦截：禁止使用 WPAD/ISATAP 保留主机名作为共享盘源')
  }
}

/** 规范化 UNC / SMB / WebDAV / 本地路径；非法输入抛错。 */
export function normalizeSharePath(raw: string): NormalizedSharePath {
  const value = (raw ?? '').trim()
  if (!value) throw new Error('共享路径为空')

  const webdav = /^(webdavs?|https?):\/\//i.exec(value)
  if (webdav) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('WebDAV 地址无效')
    }
    if (!url.hostname) throw new Error('WebDAV 地址缺少主机名')
    assertSafeShareHost(url.hostname)
    return {
      kind: 'webdav',
      normalized: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`,
      host: url.hostname,
    }
  }

  let unc = value
  if (/^smb:\/\//i.test(unc)) {
    unc = `\\\\${unc.replace(/^smb:\/\//i, '').replace(/\//g, '\\')}`
  }
  if (/^\/\//.test(unc)) unc = `\\\\${unc.slice(2).replace(/\//g, '\\')}`
  if (/^\\\\\?\\UNC\\/i.test(unc)) unc = `\\\\${unc.replace(/^\\\\\?\\UNC\\/i, '')}`
  if (/^\\\\\?\\/.test(unc)) unc = unc.replace(/^\\\\\?\\/, '')

  if (/^\\\\/.test(unc)) {
    const parts = unc.replace(/^\\\\/, '').split('\\').filter(Boolean)
    if (parts.length < 2) throw new Error('UNC 路径需要 \\\\服务器\\共享名')
    assertSafeShareHost(parts[0]!)
    return {
      kind: 'unc',
      normalized: `\\\\${parts.join('\\')}`,
      host: parts[0],
      share: parts[1],
    }
  }

  if (!/^[a-zA-Z]:[\\/]/.test(unc) && !/[\\/]/.test(unc)) {
    // 纯相对目录名也解析为绝对路径，但必须存在
    return { kind: 'local', normalized: resolve(unc) }
  }
  return { kind: 'local', normalized: resolve(unc) }
}

// ===== 源管理 =====

function toSourceSummary(labId: string, row: CsLabShareSourceRow): CsLabShareSourceSummary {
  const db = getShareDatabase(labId)
  return {
    id: row.id,
    labId: row.labId,
    label: row.label,
    kind: row.kind,
    rootPath: row.rootPath,
    include: row.include,
    quietSeconds: row.quietSeconds,
    pollSeconds: row.pollSeconds,
    status: row.status,
    watching: watchers.has(watcherKey(labId, row.id)),
    watermarkMs: row.watermarkMs,
    lastScanAt: row.lastScanAt,
    candidateCount: countShareCandidates(db, row.id),
    message: row.message,
  }
}

export function listShareSources(labIdInput: string): CsLabShareSourceSummary[] {
  const labId = assertLabId(labIdInput)
  const db = getShareDatabase(labId)
  return listShareSourceRows(db, labId).map((row) => toSourceSummary(labId, row))
}

export function addShareSource(input: CsLabShareSourceInput): CsLabShareSourceSummary {
  const labId = assertLabId(input.labId)
  const label = (input.label ?? '').trim() || '仪器共享盘'
  const normalized = normalizeSharePath(input.rootPath)
  const include = (input.include ?? [])
    .map((item) => item.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter((item) => item.length > 0)
    .slice(0, 16)
  const quietSeconds = clamp(
    input.quietSeconds ?? tuningOverride?.quietSeconds ?? DEFAULT_QUIET_SECONDS,
    MIN_QUIET_SECONDS,
    MAX_QUIET_SECONDS,
    DEFAULT_QUIET_SECONDS,
  )
  const pollSeconds = clamp(
    input.pollSeconds ?? tuningOverride?.pollSeconds ?? DEFAULT_POLL_SECONDS,
    MIN_POLL_SECONDS,
    MAX_POLL_SECONDS,
    DEFAULT_POLL_SECONDS,
  )

  const row: CsLabShareSourceRow = {
    id: `share-${randomUUID().slice(0, 8)}`,
    labId,
    label,
    kind: normalized.kind,
    rootPath: normalized.normalized,
    include,
    quietSeconds,
    pollSeconds,
    username: input.username?.trim() || undefined,
    secretCipher: input.password ? encryptToken(input.password) : undefined,
    status: 'offline',
  }

  const db = getShareDatabase(labId)
  upsertShareSourceRow(db, row)
  return toSourceSummary(labId, row)
}

export async function removeShareSource(labIdInput: string, sourceId: string): Promise<void> {
  const labId = assertLabId(labIdInput)
  await stopShareWatcher(labId, sourceId)
  deleteShareSourceRow(getShareDatabase(labId), sourceId)
}

export function listShareCandidates(
  labIdInput: string,
  sourceId?: string,
): CsLabShareCandidate[] {
  const labId = assertLabId(labIdInput)
  return listShareCandidateRows(getShareDatabase(labId), labId, sourceId).map(toShareCandidate)
}

// ===== 发现（本地 / UNC） =====

interface DiscoveredEntry {
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
}

async function listLocalEntries(
  root: string,
  include: string[],
): Promise<{ entries: DiscoveredEntry[]; truncated: boolean }> {
  const entries: DiscoveredEntry[] = []
  let truncated = false
  const roots = include.length > 0 ? include.map((item) => join(root, item)) : [root]

  for (const dir of roots) {
    let dirents: Array<import('node:fs').Dirent> = []
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      // include 子目录不存在时跳过，不拖垮整轮扫描。
      if (include.length > 0) continue
      throw error
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_SCAN_ENTRIES) {
        truncated = true
        break
      }
      if (!dirent.isFile()) continue
      if (dirent.name.startsWith('.') || TEMP_FILE_RE.test(dirent.name)) continue
      const absPath = join(dir, dirent.name)
      try {
        const stat = await fs.stat(absPath)
        if (!stat.isFile() || stat.size <= 0) continue
        entries.push({
          relPath: relative(root, absPath).split(sep).join('/'),
          absPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch {
        // 文件在枚举与 stat 之间被删除/锁住：下一轮再说。
      }
    }
    if (truncated) break
  }

  return { entries, truncated }
}

// ===== 发现（WebDAV） =====

function basicAuthHeader(username?: string, cipher?: string): Record<string, string> {
  if (!username || !cipher) return {}
  let password = ''
  try {
    password = decryptToken(cipher)
  } catch {
    throw new Error('共享盘凭据无法解密')
  }
  const token = Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')
  return { Authorization: `Basic ${token}` }
}

async function listWebdavEntries(
  rootUrl: string,
  include: string[],
  auth: Record<string, string>,
): Promise<{ entries: DiscoveredEntry[]; truncated: boolean }> {
  const base = new URL(rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`)
  assertSafeShareHost(base.hostname)
  const response = await fetch(base, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml', ...auth },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    redirect: 'manual',
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error('共享盘地址发生重定向，请直接填写最终地址')
  }
  if (!response.ok) throw new Error(`WebDAV PROPFIND 失败：HTTP ${response.status}`)
  const xml = await response.text()

  const entries: DiscoveredEntry[] = []
  let truncated = false
  const blocks = xml.split(/<d:response[\s>]/i).slice(1)
  for (const block of blocks) {
    if (entries.length >= MAX_SCAN_ENTRIES) {
      truncated = true
      break
    }
    const hrefMatch = /<d:href[^>]*>([^<]+)<\/d:href>/i.exec(block)
    if (!hrefMatch?.[1]) continue
    const href = decodeURIComponent(hrefMatch[1])
    if (/\/$/.test(href)) continue
    let absolute: URL
    try {
      absolute = new URL(href, base)
    } catch {
      continue
    }
    if (absolute.href.replace(/\/+$/, '') === base.href.replace(/\/+$/, '')) continue
    const relPath = absolute.pathname
      .slice(base.pathname.length)
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .join('/')
    if (!relPath || relPath.split('/').length !== 1) continue
    if (TEMP_FILE_RE.test(relPath) || relPath.split('/').some((part) => part.startsWith('.'))) continue
    if (include.length > 0 && !include.some((dir) => relPath.startsWith(`${dir.replace(/^\/+|\/+$/g, '')}/`) || relPath === dir)) {
      continue
    }
    const size = Number(/<d:getcontentlength[^>]*>(\d+)<\/d:getcontentlength>/i.exec(block)?.[1] ?? '0')
    const lastModified = /<d:getlastmodified[^>]*>([^<]+)<\/d:getlastmodified>/i.exec(block)?.[1]
    const mtimeMs = lastModified ? Date.parse(lastModified) : Date.now()
    if (!Number.isFinite(size) || size <= 0) continue
    entries.push({
      relPath,
      absPath: absolute.href,
      size,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
    })
  }

  return { entries, truncated }
}

// ===== 捕获：Windows 独占读租约 =====

interface LeaseCopyResult {
  ok: boolean
  sha256?: string
  bytes?: number
  leaseType: CsLabShareLeaseType
  error?: string
}

function runPowerShell(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('powershell.exe', args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ code: null, stdout, stderr: `${stderr}\nCSLab: 租约拷贝超时` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function parseLeaseStdout(stdout: string): { sha256?: string; bytes?: number; error?: string } {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  const last = lines[lines.length - 1]
  if (!last) return { error: '租约拷贝未返回结果' }
  try {
    const parsed = JSON.parse(last) as { ok?: boolean; sha256?: string; bytes?: number; error?: string }
    if (!parsed.ok) return { error: parsed.error ?? '租约拷贝失败' }
    return {
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : undefined,
      bytes: typeof parsed.bytes === 'number' ? parsed.bytes : undefined,
    }
  } catch {
    return { error: '租约拷贝返回值无法解析' }
  }
}

const POLICY_FAILURE_RE =
  /not digitally signed|ConstrainedLanguage|UnauthorizedAccess|Execution_Policies|CommandNotFoundException|无法加载|禁止运行|未经数字签名/i

/** 内联 PowerShell 只接受不含控制字符的路径；单引号内反引号与 $ 均为字面量。 */
export function assertInlinePowerShellSafe(value: string): void {
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error('路径包含控制字符，已拒绝内联 PowerShell 转义')
  }
}

function psQuote(value: string): string {
  assertInlinePowerShellSafe(value)
  return `'${value.replace(/'/g, "''")}'`
}

async function leaseCopyWindows(sourceAbs: string, destination: string): Promise<LeaseCopyResult> {
  const scriptPath = resolveCsLabScript('cslab-lease-copy.ps1')
  if (scriptPath) {
    const result = await runPowerShell(
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Source', sourceAbs, '-Destination', destination],
      LEASE_TIMEOUT_MS,
    )
    const parsed = parseLeaseStdout(result.stdout)
    if (result.code === 0 && parsed.sha256) {
      return { ok: true, sha256: parsed.sha256, bytes: parsed.bytes, leaseType: 'protected-lease' }
    }
    if (!POLICY_FAILURE_RE.test(result.stderr)) {
      return { ok: false, leaseType: 'protected-lease', error: parsed.error ?? result.stderr.trim() }
    }
  }

  // 阶梯 2：AppLocker / 受限语言模式拦截脚本时，用内联 .NET 完成同样的独占读。
  let inline: string
  try {
    inline = [
      `$s=${psQuote(sourceAbs)}`,
      `$d=${psQuote(destination)}`,
      "$fs=[IO.File]::Open($s,'Open','Read','Read')",
      '$o=[IO.File]::Create($d)',
      '$sha=[Security.Cryptography.SHA256]::Create()',
      "$cs=New-Object Security.Cryptography.CryptoStream($o,$sha,'Write')",
      '$b=New-Object byte[] 1048576',
      '$n=[long]0',
      'while(($r=$fs.Read($b,0,$b.Length)) -gt 0){$cs.Write($b,0,$r);$n+=$r}',
      '$cs.FlushFinalBlock()',
      '$cs.Dispose()',
      '$o.Dispose()',
      '$fs.Dispose()',
      `'{"ok":true,"sha256":"'+(($sha.Hash|%{$_.ToString('x2')})-join '')+'","bytes":'+$n+'}'`,
    ].join(';')
  } catch (error) {
    // 控制字符等无法安全内联的路径交给阶梯 3 的 Node 流复制处理。
    return {
      ok: false,
      leaseType: 'inline-command-lease',
      error: error instanceof Error ? error.message : '内联 PowerShell 参数校验失败',
    }
  }

  const result = await runPowerShell(
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inline],
    LEASE_TIMEOUT_MS,
  )
  const parsed = parseLeaseStdout(result.stdout)
  if (result.code === 0 && parsed.sha256) {
    return { ok: true, sha256: parsed.sha256, bytes: parsed.bytes, leaseType: 'inline-command-lease' }
  }
  return {
    ok: false,
    leaseType: 'inline-command-lease',
    error: parsed.error ?? result.stderr.trim() ?? '内联租约失败',
  }
}

/** Node 流式复制 + 前后指纹复验（非 Windows 或 PowerShell 不可用）。 */
async function copyWithStabilityCheck(sourceAbs: string, destination: string): Promise<LeaseCopyResult> {
  const before = await fs.stat(sourceAbs)
  const hash = createHash('sha256')
  let bytes = 0

  await new Promise<void>((resolvePromise, reject) => {
    const reader = createReadStream(sourceAbs)
    const writer = createWriteStream(destination)
    reader.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buffer)
      bytes += buffer.length
    })
    reader.once('error', reject)
    writer.once('error', reject)
    writer.once('finish', () => resolvePromise())
    reader.pipe(writer)
  })

  const after = await fs.stat(sourceAbs)
  if (before.size !== after.size || Math.floor(before.mtimeMs) !== Math.floor(after.mtimeMs)) {
    return { ok: false, leaseType: 'node-stream-stability', error: '源文件在捕获期间仍在变化' }
  }
  return {
    ok: true,
    sha256: hash.digest('hex'),
    bytes,
    leaseType: 'node-stream-stability',
  }
}

/** WebDAV 下载：流式写盘 + 渐进 SHA-256。 */
async function webdavDownload(
  url: string,
  destination: string,
  auth: Record<string, string>,
): Promise<LeaseCopyResult> {
  try {
    assertSafeShareHost(new URL(url).hostname)
  } catch (error) {
    return {
      ok: false,
      leaseType: 'node-stream-stability',
      error: error instanceof Error ? error.message : 'WebDAV 地址无效',
    }
  }
  const response = await fetch(url, { headers: auth, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      leaseType: 'node-stream-stability',
      error: '共享盘地址发生重定向，请直接填写最终地址',
    }
  }
  if (!response.ok || !response.body) {
    return { ok: false, leaseType: 'node-stream-stability', error: `WebDAV GET 失败：HTTP ${response.status}` }
  }
  const hash = createHash('sha256')
  let bytes = 0
  const nodeStream = Readable.fromWeb(response.body as never)
  await new Promise<void>((resolvePromise, reject) => {
    const writer = createWriteStream(destination)
    // 任一环节失败都必须释放写入句柄，否则 Windows 上残留锁会让后续重试 EBUSY。
    const cleanup = (error: Error): void => {
      writer.destroy()
      reject(error)
    }
    nodeStream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buffer)
      bytes += buffer.length
    })
    nodeStream.once('error', cleanup)
    writer.once('error', cleanup)
    writer.once('finish', () => resolvePromise())
    nodeStream.pipe(writer)
  })
  return { ok: true, sha256: hash.digest('hex'), bytes, leaseType: 'node-stream-stability' }
}

// ===== 捕获主流程 =====

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function stagingDir(labId: string): string {
  return join(resolveLabDir(labId), 'db', 'staging')
}

function retryDelay(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

interface CaptureCandidate extends CsLabShareCandidateRow {
  /** 捕获时使用的真实地址：本地/UNC 为绝对路径，WebDAV 为绝对 URL。 */
  absPath: string
}

async function captureCandidate(
  labId: string,
  source: CsLabShareSourceRow,
  candidate: CaptureCandidate,
): Promise<CsLabIngestResult | null> {
  const db = getShareDatabase(labId)
  const dir = stagingDir(labId)
  await fs.mkdir(dir, { recursive: true })
  const partialPath = join(dir, `${candidate.id}.partial`)
  const extension = extname(candidate.relPath).toLowerCase()
  const finalPath = join(dir, `${candidate.id}${extension || '.bin'}`)

  let lease: LeaseCopyResult
  if (source.kind === 'webdav') {
    lease = await webdavDownload(
      candidate.absPath,
      partialPath,
      basicAuthHeader(source.username, source.secretCipher),
    )
  } else if (process.platform === 'win32' && process.env.CSLAB_SHARE_FORCE_NODE_STREAM !== '1') {
    lease = await leaseCopyWindows(candidate.absPath, partialPath)
    if (!lease.ok) {
      // 阶梯 3 兜底：PowerShell 完全不可用时退回 Node 稳定性校验。
      await fs.rm(partialPath, { force: true }).catch(() => undefined)
      lease = await copyWithStabilityCheck(candidate.absPath, partialPath)
    }
  } else {
    lease = await copyWithStabilityCheck(candidate.absPath, partialPath)
  }

  if (!lease.ok || !lease.sha256) {
    const attempts = candidate.attempts + 1
    upsertShareCandidateRow(db, {
      ...candidate,
      state: 'retry',
      attempts,
      leaseType: lease.leaseType,
      nextAttemptAt: Date.now() + retryDelay(attempts),
      message: lease.error ?? '捕获失败',
      updatedAt: Date.now(),
    })
    await fs.rm(partialPath, { force: true }).catch(() => undefined)
    return null
  }

  // 幂等：同源同 SHA 已入库则直接丢弃暂存。
  const published = findPublishedCandidateBySha(db, source.id, lease.sha256)
  if (published && published.id !== candidate.id) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined)
    upsertShareCandidateRow(db, {
      ...candidate,
      state: 'published',
      sha256: lease.sha256,
      leaseType: lease.leaseType,
      evidence: lease.leaseType === 'protected-lease' ? 'protected-lease' : 'quiet-interval',
      assetUri: published.assetUri,
      message: '与既有资产 SHA-256 相同，已复用',
      updatedAt: Date.now(),
    })
    return null
  }

  await fsyncFile(partialPath)
  await fs.rename(partialPath, finalPath)

  try {
    const results = await ingestFiles(labId, [finalPath])
    const result = results[0]
    if (!result || result.status === 'error') {
      throw new Error(result?.message ?? '数据铁笼拒绝摄取')
    }
    upsertShareCandidateRow(db, {
      ...candidate,
      state: 'published',
      sha256: lease.sha256,
      leaseType: lease.leaseType,
      evidence: lease.leaseType === 'protected-lease' ? 'protected-lease' : 'quiet-interval',
      assetUri: result.tableUri ?? result.asset.uri,
      attempts: candidate.attempts,
      nextAttemptAt: undefined,
      message: result.message,
      updatedAt: Date.now(),
    })
    return result
  } catch (error) {
    const attempts = candidate.attempts + 1
    upsertShareCandidateRow(db, {
      ...candidate,
      state: 'retry',
      attempts,
      leaseType: lease.leaseType,
      nextAttemptAt: Date.now() + retryDelay(attempts),
      message: error instanceof Error ? error.message : '入库失败',
      updatedAt: Date.now(),
    })
    return null
  } finally {
    await fs.rm(finalPath, { force: true }).catch(() => undefined)
  }
}

// ===== 扫描 =====

function emptyResult(message: string): CsLabShareScanResult {
  return { ok: false, scanned: 0, discovered: 0, captured: 0, skipped: 0, failed: 0, message }
}

export async function scanShareSource(
  labIdInput: string,
  sourceId: string,
): Promise<CsLabShareScanResult> {
  const labId = assertLabId(labIdInput)
  const db = getShareDatabase(labId)
  const source = getShareSourceRow(db, sourceId)
  if (!source) return emptyResult('共享源不存在')

  let listed: { entries: DiscoveredEntry[]; truncated: boolean }
  try {
    if (source.kind === 'webdav') {
      listed = await listWebdavEntries(
        source.rootPath,
        source.include,
        basicAuthHeader(source.username, source.secretCipher),
      )
    } else {
      listed = await listLocalEntries(source.rootPath, source.include)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '共享盘不可达'
    updateShareSourceStatus(db, source.id, { status: 'offline', message, lastScanAt: Date.now() })
    emitStatus(labId, source.id, 'offline', message)
    return { ...emptyResult(message), failed: 1 }
  }

  const now = Date.now()
  let discovered = 0
  let skipped = 0
  let watermark = source.watermarkMs ?? 0

  for (const entry of listed.entries) {
    const fingerprint = `${entry.size}:${Math.floor(entry.mtimeMs)}`
    const existing = getShareCandidateRow(db, source.id, entry.relPath)
    if (existing?.state === 'published' && existing.fingerprint === fingerprint) {
      skipped += 1
      continue
    }
    if (existing?.state === 'capturing' && existing.fingerprint === fingerprint) {
      // 上一次捕获中断：重置为 debouncing，允许本轮重新尝试。
      upsertShareCandidateRow(db, {
        ...existing,
        state: 'debouncing',
        leaseType: 'pending',
        updatedAt: now,
      })
      continue
    }

    const sameFingerprint = existing?.fingerprint === fingerprint
    const row: CsLabShareCandidateRow = {
      id: existing?.id ?? `cand-${randomUUID().slice(0, 8)}`,
      labId,
      sourceId: source.id,
      relPath: entry.relPath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      fingerprint,
      state: sameFingerprint ? existing.state : 'debouncing',
      leaseType: sameFingerprint ? existing.leaseType : 'pending',
      evidence: sameFingerprint ? existing.evidence : undefined,
      attempts: sameFingerprint ? existing.attempts : 0,
      nextAttemptAt: sameFingerprint ? existing.nextAttemptAt : undefined,
      // 内容变化后旧 SHA 失效，必须清空，避免误判幂等。
      sha256: sameFingerprint ? existing.sha256 : undefined,
      assetUri: sameFingerprint ? existing.assetUri : undefined,
      message: sameFingerprint ? existing.message : undefined,
      // updatedAt 记录「本指纹首次观测时间」，用于静默期判定。
      updatedAt: sameFingerprint ? existing.updatedAt : now,
    }

    upsertShareCandidateRow(db, row)
    discovered += 1
    watermark = Math.max(watermark, entry.mtimeMs)
  }

  updateShareSourceStatus(db, source.id, {
    status: 'online',
    message: listed.truncated ? `单轮枚举达到 ${MAX_SCAN_ENTRIES} 条上限` : null,
    watermarkMs: watermark || undefined,
    lastScanAt: now,
  })
  emitStatus(labId, source.id, 'online')

  // 处理到期的候选（静默期已满且退避到期）。
  const quietMs = source.quietSeconds * 1000
  const captureNow = Date.now()
  const pending = listShareCandidateRows(db, labId, source.id).filter((row) => {
    if (row.state === 'published' || row.state === 'quarantined' || row.state === 'capturing') {
      return false
    }
    if (row.nextAttemptAt && row.nextAttemptAt > captureNow) return false
    return captureNow - row.updatedAt >= quietMs
  })

  const absoluteOf = (row: CsLabShareCandidateRow): string =>
    source.kind === 'webdav'
      ? `${source.rootPath.replace(/\/+$/, '')}/${row.relPath.replace(/^\/+/, '')}`
      : resolve(source.rootPath, row.relPath.split('/').join(sep))

  let captured = 0
  let failed = 0
  for (const row of pending) {
    // 捕获前重新读取一次源状态，确保静默期内没有再变化。
    if (source.kind === 'webdav') {
      const refreshed = await listWebdavEntries(
        source.rootPath,
        source.include,
        basicAuthHeader(source.username, source.secretCipher),
      ).catch(() => null)
      const current = refreshed?.entries.find((entry) => entry.relPath === row.relPath)
      if (refreshed && !current) continue
      if (current && `${current.size}:${Math.floor(current.mtimeMs)}` !== row.fingerprint) {
        upsertShareCandidateRow(db, {
          ...row,
          state: 'debouncing',
          size: current.size,
          mtimeMs: current.mtimeMs,
          fingerprint: `${current.size}:${Math.floor(current.mtimeMs)}`,
          sha256: undefined,
          assetUri: undefined,
          updatedAt: Date.now(),
        })
        continue
      }
    } else {
      try {
        const stat = await fs.stat(absoluteOf(row))
        if (`${stat.size}:${Math.floor(stat.mtimeMs)}` !== row.fingerprint) {
          upsertShareCandidateRow(db, {
            ...row,
            state: 'debouncing',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            fingerprint: `${stat.size}:${Math.floor(stat.mtimeMs)}`,
            sha256: undefined,
            assetUri: undefined,
            updatedAt: Date.now(),
          })
          continue
        }
      } catch {
        // 文件已消失或暂时不可读：保留候选，等待下一轮巡检。
        continue
      }
    }

    const withPath: CaptureCandidate = { ...row, absPath: absoluteOf(row) }
    upsertShareCandidateRow(db, { ...row, state: 'capturing', updatedAt: Date.now() })

    try {
      const result = await captureCandidate(labId, source, withPath)
      if (result) {
        captured += 1
        sinks.get(labId)?.onCaptured?.(labId, result)
      } else {
        failed += 1
      }
    } catch (error) {
      failed += 1
      const attempts = row.attempts + 1
      upsertShareCandidateRow(db, {
        ...row,
        state: 'retry',
        attempts,
        nextAttemptAt: Date.now() + retryDelay(attempts),
        message: error instanceof Error ? error.message : '捕获异常',
        updatedAt: Date.now(),
      })
    }
  }

  return {
    ok: true,
    scanned: listed.entries.length,
    discovered,
    captured,
    skipped,
    failed,
    message: `扫描 ${listed.entries.length} 个文件，新观测 ${discovered}，捕获 ${captured}`,
  }
}

export async function scanShareNow(
  labIdInput: string,
  sourceId?: string,
): Promise<CsLabShareScanResult> {
  const labId = assertLabId(labIdInput)
  const db = getShareDatabase(labId)
  const sources = sourceId
    ? [getShareSourceRow(db, sourceId)].filter((row): row is CsLabShareSourceRow => !!row)
    : listShareSourceRows(db, labId)
  if (sources.length === 0) return emptyResult('尚未添加共享盘')

  const aggregate: CsLabShareScanResult = {
    ok: true,
    scanned: 0,
    discovered: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    message: '',
  }
  const messages: string[] = []
  for (const source of sources) {
    const result = await scanShareSource(labId, source.id)
    aggregate.ok = aggregate.ok && result.ok
    aggregate.scanned += result.scanned
    aggregate.discovered += result.discovered
    aggregate.captured += result.captured
    aggregate.skipped += result.skipped
    aggregate.failed += result.failed
    messages.push(`${source.label}: ${result.message}`)
  }
  aggregate.message = messages.join('；')
  return aggregate
}

export async function testShareSource(
  labIdInput: string,
  sourceId: string,
): Promise<CsLabShareScanResult> {
  const labId = assertLabId(labIdInput)
  const source = getShareSourceRow(getShareDatabase(labId), sourceId)
  if (!source) return emptyResult('共享源不存在')
  try {
    const listed =
      source.kind === 'webdav'
        ? await listWebdavEntries(source.rootPath, source.include, basicAuthHeader(source.username, source.secretCipher))
        : await listLocalEntries(source.rootPath, source.include)
    return {
      ok: true,
      scanned: listed.entries.length,
      discovered: 0,
      captured: 0,
      skipped: 0,
      failed: 0,
      message: `连接成功，可见 ${listed.entries.length} 个文件`,
    }
  } catch (error) {
    return { ...emptyResult(error instanceof Error ? error.message : '连接失败'), failed: 1 }
  }
}

// ===== 监听生命周期 =====

export async function startShareWatcher(
  labIdInput: string,
  sourceId?: string,
  sink?: CsLabShareWatcherSink,
): Promise<{ watching: boolean; message: string }> {
  const labId = assertLabId(labIdInput)
  if (sink) sinks.set(labId, sink)

  const db = getShareDatabase(labId)
  const sources = sourceId
    ? [getShareSourceRow(db, sourceId)].filter((row): row is CsLabShareSourceRow => !!row)
    : listShareSourceRows(db, labId)
  if (sources.length === 0) return { watching: false, message: '尚未添加共享盘' }

  for (const source of sources) {
    const key = watcherKey(labId, source.id)
    if (watchers.has(key)) continue

    const handle: WatcherHandle = {
      labId,
      sourceId: source.id,
      timer: null,
      hintTimer: null,
      running: false,
    }

    // 崩溃恢复：残留 capturing 一律回到 debouncing。
    for (const row of listShareCandidateRows(db, labId, source.id)) {
      if (row.state === 'capturing') {
        upsertShareCandidateRow(db, {
          ...row,
          state: 'debouncing',
          leaseType: 'pending',
          updatedAt: Date.now(),
        })
      }
    }

    const tick = (): void => {
      if (handle.running) return
      handle.running = true
      void scanShareSource(labId, source.id)
        .catch((error: unknown) => {
          console.warn('[CSLab] 共享盘扫描失败:', error)
        })
        .finally(() => {
          handle.running = false
        })
    }

    handle.timer = setInterval(tick, Math.max(1, source.pollSeconds) * 1000)
    handle.timer.unref()

    if (source.kind !== 'webdav') {
      try {
        const module = (await import('chokidar')) as unknown as {
          watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike
          default?: { watch?: (paths: string[], options: Record<string, unknown>) => WatcherLike }
        }
        const watch = module.watch ?? module.default?.watch
        if (!watch) throw new Error('chokidar 不可用')
        const watcher = watch([source.rootPath], {
          ignoreInitial: true,
          depth: 1,
          awaitWriteFinish: false,
          ignorePermissionErrors: true,
        })
        watcher.on('all', () => {
          if (handle.hintTimer) return
          // 事件只作为「尽快扫描」提示，不直接触发捕获。
          handle.hintTimer = setTimeout(() => {
            handle.hintTimer = null
            tick()
          }, 1500)
          handle.hintTimer.unref()
        })
        handle.closer = async () => {
          await watcher.close().catch(() => undefined)
        }
      } catch (error) {
        console.warn('[CSLab] 共享盘事件监听不可用，仅使用轮询:', error)
      }
    }

    watchers.set(key, handle)
    tick()
  }

  const watching = sources.some((source) => watchers.has(watcherKey(labId, source.id)))
  return { watching, message: watching ? '共享盘监听已启动' : '共享盘监听未启动' }
}

export async function stopShareWatcher(
  labIdInput: string,
  sourceId?: string,
): Promise<{ watching: boolean; message: string }> {
  const labId = assertLabId(labIdInput)
  const keys = sourceId
    ? [watcherKey(labId, sourceId)]
    : [...watchers.keys()].filter((key) => key.startsWith(`${labId}::`))

  for (const key of keys) {
    const handle = watchers.get(key)
    if (!handle) continue
    watchers.delete(key)
    if (handle.timer) clearInterval(handle.timer)
    if (handle.hintTimer) clearTimeout(handle.hintTimer)
    await handle.closer?.()
  }

  return { watching: watchers.size > 0, message: '共享盘监听已停止' }
}

export async function stopAllShareWatchers(): Promise<void> {
  for (const [key, handle] of [...watchers.entries()]) {
    watchers.delete(key)
    if (handle.timer) clearInterval(handle.timer)
    if (handle.hintTimer) clearTimeout(handle.hintTimer)
    await handle.closer?.()
  }
  sinks.clear()
}

export function isShareWatching(labIdInput: string, sourceId?: string): boolean {
  const labId = assertLabId(labIdInput)
  if (sourceId) return watchers.has(watcherKey(labId, sourceId))
  return [...watchers.keys()].some((key) => key.startsWith(`${labId}::`))
}

/** 测试辅助：直接推入一条候选，跳过发现阶段。 */
export function __upsertCandidateForTest(row: CsLabShareCandidateRow): CsLabShareCandidate | null {
  const db = getShareDatabase(row.labId)
  upsertShareCandidateRow(db, row)
  const saved = getShareCandidateRow(db, row.sourceId, row.relPath)
  return saved ? toShareCandidate(saved) : null
}

export function __getCandidateStateForTest(
  labId: string,
  sourceId: string,
  relPath: string,
): CsLabShareCandidateState | null {
  return getShareCandidateRow(getShareDatabase(labId), sourceId, relPath)?.state ?? null
}

export function __sanitizeShareFileName(name: string): string {
  return sanitizeFileName(basename(name))
}
