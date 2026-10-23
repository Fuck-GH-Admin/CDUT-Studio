/**
 * CSLab 实验室管理器
 *
 * 负责课题级沙箱的创建、列举、打开与快照。每个实验室完全自包含：
 * lab.manifest.json + db/central_meta.sqlite + vault + runtime。
 */

import { join } from 'node:path'
import type {
  CsLabCreateLabInput,
  CsLabLab,
  CsLabLabSnapshot,
  CsLabLayerType,
} from '@profer/shared'
import {
  createLabId,
  deleteLabFiles,
  ensureLabLayout,
  getDefaultLabDir,
  listLabManifests,
  readLabManifest,
  resolveLabDir,
  updateLabManifest,
  writeLabManifest,
} from './cslab-paths'
import {
  closeCsLabDatabase,
  countEntities,
  getCsLabDatabase,
  setLabState,
} from './cslab-db'
import { closeHpcDatabase } from './cslab-hpc-db'
import { closeShareDatabase } from './cslab-share-db'
import { closeCsLabVaultCache } from './cslab-vault-cache'
import { stopVaultWatcher } from './cslab-canvas-sync'
import { stopLabToolWatcher } from './cslab-tool-registry'
import { stopShareWatcher } from './cslab-share-watcher'
import { stopZoteroWatcher } from './cslab-zotero'
import { listAgentSessions, updateAgentSessionMeta } from '../agent-session-manager'
import { listAssets } from './cslab-iron-cage'
import { getPythonCapability } from './cslab-python'

const ALL_LAYER_TYPES: CsLabLayerType[] = [
  'lit',
  'fact',
  'note',
  'node',
  'proto',
  'run',
  'raw',
  'table',
  'fig',
  'mol',
  'doc',
  'capsule',
]

export function listLabs(): CsLabLab[] {
  return listLabManifests()
}

export function getLab(labId: string): CsLabLab | null {
  return readLabManifest(resolveLabDir(labId))
}

export function createLab(input: CsLabCreateLabInput): CsLabLab {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Error('实验室名称不能为空')
  if (name.length > 60) throw new Error('实验室名称不能超过 60 个字符')

  const labId = createLabId(name)
  const rootPath = input.rootPath?.trim() ? input.rootPath.trim() : getDefaultLabDir(labId)
  const labDir = ensureLabLayout(labId, rootPath)
  const now = Date.now()

  const manifest: CsLabLab = {
    id: labId,
    code: `CSLab-${labId.slice(-6).toUpperCase()}`,
    name,
    description: input.description?.trim() || '尚未填写研究方向',
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => tag.trim()).filter(Boolean) : [],
    members: 1,
    status: '运行中',
    rootPath: labDir,
    createdAt: now,
    updatedAt: now,
  }

  writeLabManifest(labDir, manifest)
  // 立即初始化 SQLite，保证首屏快照与后续摄取无需再做懒建表。
  getCsLabDatabase(join(labDir, 'db', 'central_meta.sqlite'))
  return manifest
}

export function openLab(labId: string): CsLabLab {
  const labDir = resolveLabDir(labId)
  const manifest = readLabManifest(labDir)
  if (!manifest) throw new Error('实验室不存在或清单损坏')

  const db = getCsLabDatabase(join(labDir, 'db', 'central_meta.sqlite'))
  setLabState(db, 'last_opened_at', String(Date.now()))
  return manifest
}

/** 重命名实验室（不改变 sandbox 目录与 labId）。 */
export function renameLab(labId: string, newName: string): CsLabLab {
  const name = typeof newName === 'string' ? newName.trim() : ''
  if (!name) throw new Error('实验室名称不能为空')
  if (name.length > 60) throw new Error('实验室名称不能超过 60 个字符')
  return updateLabManifest(labId, { name })
}

/** 切换置顶状态；不修改 updatedAt，避免「置顶」被误判为内容更新。 */
export function togglePinLab(labId: string): CsLabLab {
  const current = getLab(labId)
  if (!current) throw new Error('实验室不存在或清单损坏')
  const pinned = !current.pinned
  return updateLabManifest(labId, {
    pinned,
    pinnedAt: pinned ? Date.now() : undefined,
  })
}

/** 切换归档状态；解除归档时恢复归档前的业务状态。 */
export function toggleArchiveLab(labId: string): CsLabLab {
  const current = getLab(labId)
  if (!current) throw new Error('实验室不存在或清单损坏')

  if (!current.archived) {
    const previousStatus = current.status === '已归档' ? '运行中' : current.status
    return updateLabManifest(labId, {
      archived: true,
      archivedAt: Date.now(),
      status: '已归档',
      statusBeforeArchive: previousStatus,
    })
  }

  return updateLabManifest(labId, {
    archived: false,
    archivedAt: undefined,
    status: current.statusBeforeArchive ?? '运行中',
    statusBeforeArchive: undefined,
  })
}

/** 关闭该实验室关联的全部文件监听；单项失败只记录警告，不阻断删除。 */
async function stopLabWatchers(labId: string): Promise<void> {
  const tasks: Array<{ label: string; run: () => Promise<unknown> }> = [
    { label: 'Vault', run: () => stopVaultWatcher(labId) },
    { label: '自定义工具', run: () => stopLabToolWatcher(labId) },
    { label: '共享盘', run: () => stopShareWatcher(labId) },
    { label: 'Zotero', run: () => stopZoteroWatcher(labId) },
  ]
  for (const task of tasks) {
    try {
      await task.run()
    } catch (error) {
      console.warn(`[CSLab] 删除实验室前停止 ${task.label} 监听失败:`, error)
    }
  }
}

/**
 * 彻底删除实验室：
 * 1. 停止文件监听并解绑历史会话；
 * 2. 关闭 SQLite 连接（含 vault_cache），避免 Windows 文件句柄占用导致 EBUSY/EPERM；
 * 3. 物理删除沙箱目录并注销索引。
 *
 * 幂等：清单缺失或目录已被部分删除时仍继续清理，返回被解绑的会话 ID 供调用方广播。
 */
export async function deleteLab(labId: string): Promise<string[]> {
  const labDir = resolveLabDir(labId)
  const manifest = readLabManifest(labDir)
  if (!manifest) {
    console.warn(`[CSLab] 清单缺失或已损坏，继续执行幂等清理: ${labDir}`)
  }

  await stopLabWatchers(labId)

  // 历史会话脱敏解绑；显式传 archived 防止 updateAgentSessionMeta 触发自动解归档。
  const unboundSessionIds: string[] = []
  for (const session of listAgentSessions(true)) {
    if (session.cslabLabId !== labId) continue
    try {
      updateAgentSessionMeta(session.id, {
        cslabLabId: undefined,
        archived: session.archived,
      })
      unboundSessionIds.push(session.id)
    } catch (error) {
      console.warn(`[CSLab] 解绑实验室会话失败 (${session.id}):`, error)
    }
  }

  // 仅关闭目标实验室的 SQLite 连接，避免误伤其它实验室的后台作业轮询与查询
  closeCsLabDatabase(join(labDir, 'db', 'central_meta.sqlite'))
  closeHpcDatabase(labId)
  closeShareDatabase(labId)
  closeCsLabVaultCache(labId)

  deleteLabFiles(labId)
  return unboundSessionIds
}

export async function getLabSnapshot(labId: string): Promise<CsLabLabSnapshot> {
  const labDir = resolveLabDir(labId)
  const manifest = readLabManifest(labDir)
  if (!manifest) throw new Error('实验室不存在或清单损坏')

  const db = getCsLabDatabase(join(labDir, 'db', 'central_meta.sqlite'))
  const rawCounts = countEntities(db, labId)
  const counts = {} as Record<CsLabLayerType, number>
  for (const layerType of ALL_LAYER_TYPES) {
    counts[layerType] = rawCounts[layerType] ?? 0
  }

  const assets = listAssets(labId, { noteLimit: 20 })
  const python = await getPythonCapability()

  return {
    lab: manifest,
    counts,
    recentAssets: assets.slice(0, 20),
    python,
  }
}
