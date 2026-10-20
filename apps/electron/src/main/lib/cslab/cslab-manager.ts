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
  ensureLabLayout,
  getDefaultLabDir,
  listLabManifests,
  readLabManifest,
  resolveLabDir,
  writeLabManifest,
} from './cslab-paths'
import {
  countEntities,
  getCsLabDatabase,
  setLabState,
} from './cslab-db'
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
