/**
 * CSLab 实验室沙箱路径与清单管理
 *
 * 红线：
 * 1. 所有 labId 必须通过正则校验后才可拼接路径；
 * 2. 所有渲染进程传入的相对路径必须 resolve 后仍位于实验室根目录内；
 * 3. manifest 使用 .tmp + rename 原子写入。
 */

import { join, resolve, sep, basename, normalize, parse } from 'node:path'
import { homedir } from 'node:os'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { CsLabLab } from '@profer/shared'
import { getConfigDir } from '../config-paths'

const LAB_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/
const MANIFEST_NAME = 'lab.manifest.json'
const INDEX_NAME = 'index.json'

export const VAULT_SUBDIRS = ['lit', 'notes', 'raw', 'tables', 'figures', 'manuscripts'] as const
export const RUNTIME_SUBDIRS = ['tools', 'logs'] as const

interface LabIndexEntry {
  rootPath: string
  updatedAt: number
}

interface LabIndex {
  version: 1
  labs: Record<string, LabIndexEntry>
}

/** CSLab 根目录（所有默认实验室沙箱的父目录）。 */
export function getCsLabRootDir(): string {
  const dir = join(getConfigDir(), 'cslab-workspaces')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function assertLabId(value: unknown): string {
  if (typeof value !== 'string' || !LAB_ID_RE.test(value)) {
    throw new Error('实验室标识无效')
  }
  return value
}

function getIndexPath(): string {
  return join(getCsLabRootDir(), INDEX_NAME)
}

function readIndex(): LabIndex {
  const indexPath = getIndexPath()
  if (!existsSync(indexPath)) return { version: 1, labs: {} }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as Partial<LabIndex>
    if (parsed.version !== 1 || !parsed.labs || typeof parsed.labs !== 'object') {
      return { version: 1, labs: {} }
    }
    return { version: 1, labs: parsed.labs }
  } catch {
    console.warn('[CSLab] 实验室索引损坏，已按空索引继续')
    return { version: 1, labs: {} }
  }
}

function writeIndex(index: LabIndex): void {
  const indexPath = getIndexPath()
  const tmpPath = `${indexPath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8')
  renameSync(tmpPath, indexPath)
}

function registerLabRoot(labId: string, rootPath: string): void {
  const index = readIndex()
  index.labs[labId] = { rootPath, updatedAt: Date.now() }
  writeIndex(index)
}

function unregisterLabRoot(labId: string): void {
  const index = readIndex()
  if (!index.labs[labId]) return
  delete index.labs[labId]
  writeIndex(index)
}

/** 生成稳定可读的 labId（仅小写字母/数字/连字符）。 */
export function createLabId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = randomBytes(3).toString('hex')
  const prefix = slug || 'lab'
  return `${prefix}-${suffix}`.slice(0, 63)
}

/** 默认沙箱目录（不创建）。 */
export function getDefaultLabDir(labId: string): string {
  return join(getCsLabRootDir(), assertLabId(labId))
}

/** 解析实验室根目录；自定义路径从索引读取。 */
export function resolveLabDir(labId: string): string {
  const id = assertLabId(labId)
  const index = readIndex()
  const entry = index.labs[id]
  const root = entry?.rootPath ? resolve(entry.rootPath) : getDefaultLabDir(id)
  return root
}

/** 归一化为大小写不敏感的比较基准（Windows 路径不区分大小写）。 */
function normalizeForCompare(target: string): string {
  return normalize(resolve(target)).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 实验室根路径敏感目录拒止。
 *
 * 沿用 pi-file-checkpoint 的红线思想：绝不把用户主目录、盘符/文件系统根、
 * 应用目录或系统目录当作实验室沙箱。默认沙箱位于主目录的子目录，
 * 因此这里只能做「等于」判定，不能按前缀拒绝。
 */
export function assertSafeLabRootPath(targetPath: string): string {
  const resolved = normalize(resolve(targetPath))
  const forbidden = [
    homedir(),
    parse(resolve(homedir())).root,
    // 目标自身的盘符 / 文件系统根：覆盖 Windows 多盘符（D:\、E:\）与 POSIX 根
    parse(resolved).root,
    process.cwd(),
  ]
  for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)'] as const) {
    const value = process.env[key]
    if (value) forbidden.push(value)
  }
  const target = normalizeForCompare(resolved)
  if (forbidden.some((item) => normalizeForCompare(item) === target)) {
    throw new Error('安全拒止：禁止将用户主目录、盘符根目录或系统/应用目录用作实验室根路径')
  }
  return resolved
}

/** 注册实验室根目录并创建完整目录骨架。 */
export function ensureLabLayout(labId: string, rootPath: string): string {
  const id = assertLabId(labId)
  const root = assertSafeLabRootPath(rootPath)
  mkdirSync(join(root, 'db'), { recursive: true })
  for (const dir of VAULT_SUBDIRS) mkdirSync(join(root, 'vault', dir), { recursive: true })
  for (const dir of RUNTIME_SUBDIRS) mkdirSync(join(root, 'runtime', dir), { recursive: true })
  registerLabRoot(id, root)
  return root
}

export function getManifestPath(labDir: string): string {
  return join(labDir, MANIFEST_NAME)
}

export function readLabManifest(labDir: string): CsLabLab | null {
  const manifestPath = getManifestPath(labDir)
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Partial<CsLabLab>
    if (!parsed.id || !parsed.name) return null
    const status: CsLabLab['status'] =
      parsed.status === '调试中' || parsed.status === '筹建中' || parsed.status === '已归档'
        ? parsed.status
        : '运行中'
    const archived = parsed.archived === true || status === '已归档'
    return {
      id: String(parsed.id),
      code: String(parsed.code ?? parsed.id.toUpperCase()),
      name: String(parsed.name),
      description: String(parsed.description ?? ''),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      members: Number(parsed.members ?? 1),
      status,
      rootPath: String(parsed.rootPath ?? labDir),
      createdAt: Number(parsed.createdAt ?? Date.now()),
      updatedAt: Number(parsed.updatedAt ?? Date.now()),
      pinned: parsed.pinned === true,
      pinnedAt: typeof parsed.pinnedAt === 'number' ? parsed.pinnedAt : undefined,
      archived,
      archivedAt: typeof parsed.archivedAt === 'number' ? parsed.archivedAt : undefined,
      statusBeforeArchive:
        parsed.statusBeforeArchive === '运行中' ||
        parsed.statusBeforeArchive === '调试中' ||
        parsed.statusBeforeArchive === '筹建中'
          ? parsed.statusBeforeArchive
          : undefined,
    }
  } catch {
    console.warn(`[CSLab] 实验室清单损坏，已跳过: ${manifestPath}`)
    return null
  }
}

export function writeLabManifest(labDir: string, manifest: CsLabLab): void {
  const manifestPath = getManifestPath(labDir)
  const tmpPath = `${manifestPath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  renameSync(tmpPath, manifestPath)
}

/** 读取清单并原子合并补丁；强制保留原 id，避免补丁篡改沙箱标识。 */
export function updateLabManifest(labId: string, patch: Partial<CsLabLab>): CsLabLab {
  const labDir = resolveLabDir(labId)
  const current = readLabManifest(labDir)
  if (!current) throw new Error('实验室不存在或清单损坏')
  const next: CsLabLab = { ...current, ...patch, id: current.id }
  writeLabManifest(labDir, next)
  return next
}

/** 递归解除只读属性，避免 Windows 下 rmSync 因只读文件/目录返回 EPERM。 */
function clearReadonlyAttributes(dir: string): void {
  try {
    chmodSync(dir, 0o777)
  } catch {
    // 权限不足时继续尝试，最终由 rmSync 的重试兜底。
  }
  const entries = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  for (const entry of entries) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      clearReadonlyAttributes(child)
    } else {
      try {
        chmodSync(child, 0o666)
      } catch {
        // 单个文件失败不阻断整体删除。
      }
    }
  }
}

/** 物理删除实验室沙箱目录并注销索引（调用方必须先释放数据库与文件监听）。 */
export function deleteLabFiles(labId: string): void {
  const root = assertSafeLabRootPath(resolveLabDir(labId))
  try {
    if (!existsSync(root)) return
    // Windows 下主进程自身 CWD 位于待删目录时会锁死目录，先切回 CSLab 根目录。
    const cwd = normalizeForCompare(process.cwd())
    const target = normalizeForCompare(root)
    if (cwd === target || cwd.startsWith(`${target}${sep}`)) {
      try {
        process.chdir(getCsLabRootDir())
      } catch (error) {
        console.warn('[CSLab] 删除前切换工作目录失败:', error)
      }
    }
    clearReadonlyAttributes(root)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  } catch (error) {
    // 物理删除失败仍注销索引，保证已删除实验室不会永远卡在 UI 中。
    console.warn(`[CSLab] 物理删除实验室目录失败，已注销索引: ${root}`, error)
  } finally {
    unregisterLabRoot(labId)
  }
}

/** 列出索引中所有可读实验室（跳过损坏清单）。 */
export function listLabManifests(): CsLabLab[] {
  const index = readIndex()
  const labs: CsLabLab[] = []
  const seen = new Set<string>()

  for (const [labId, entry] of Object.entries(index.labs)) {
    if (!LAB_ID_RE.test(labId)) continue
    const manifest = readLabManifest(resolve(entry.rootPath))
    if (manifest && manifest.id === labId) {
      labs.push(manifest)
      seen.add(labId)
    }
  }

  // 兼容手工放入默认根目录但尚未写入索引的实验室。
  const root = getCsLabRootDir()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LAB_ID_RE.test(entry.name) || seen.has(entry.name)) continue
    const manifest = readLabManifest(join(root, entry.name))
    if (manifest) {
      labs.push(manifest)
      registerLabRoot(manifest.id, join(root, entry.name))
    }
  }

  // 置顶优先（最近置顶在前），其余按最近更新时间倒序。
  return labs.sort((a, b) => {
    const pinnedDelta = Number(!!b.pinned) - Number(!!a.pinned)
    if (pinnedDelta !== 0) return pinnedDelta
    if (a.pinned && b.pinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    return b.updatedAt - a.updatedAt
  })
}

export function removeLabRegistration(labId: string): void {
  unregisterLabRoot(labId)
}

/**
 * 将实验室内的相对路径解析为绝对路径，并阻断路径穿越。
 */
export function resolveLabRelativePath(labId: string, relPath: string): string {
  const root = resolve(resolveLabDir(labId))
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('路径越界：目标不在实验室沙箱内')
  }
  return target
}

/** 将绝对路径转为实验室内的 POSIX 相对路径。 */
export function toLabRelativePath(labId: string, absolutePath: string): string {
  const root = resolve(resolveLabDir(labId))
  const target = resolve(absolutePath)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('路径越界：目标不在实验室沙箱内')
  return target.slice(root.length + 1).split(sep).join('/')
}

/** 安全的文件名（去除目录与控制字符）。 */
export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  return base || 'unnamed'
}

/** 供测试清理使用。 */
export function __removeLabDirForTest(rootPath: string): void {
  rmSync(resolve(rootPath), { recursive: true, force: true })
}
