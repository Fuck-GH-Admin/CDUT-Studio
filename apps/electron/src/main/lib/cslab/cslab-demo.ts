/**
 * CSLab 演示实验室生成器
 *
 * 两间官方演示实验室：
 * - Origin × VESTA：晶体学 / PXRD / 拉曼 / 体数据 / 出版图版；
 * - SKLGP 泥石流：DEM / I-D 曲线 / Voellmy 推演 / 危险性图版。
 *
 * 首次读取实验室列表时由 router 静默 ensure，不再需要顶栏独立入口。
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type {
  CsLabAssetSummary,
  CsLabDemoKind,
  CsLabDemoLabResult,
  CsLabLab,
  CsLabTableSeries,
} from '@profer/shared'
import { createLab, deleteLab, getLab, listLabs } from './cslab-manager'
import { updateLabManifest } from './cslab-paths'
import { ingestFiles, listAssets } from './cslab-iron-cage'
import { getTableSeries } from './cslab-mol'
import { buildDemoPlates } from './cslab-demo-plates'
import { getCsLabDatabase, nextLabRevision, upsertEntity, withTransaction } from './cslab-db'
import { copyFileWithHash, lockFileReadOnly } from './cslab-hash'
import { resolveLabDir, resolveLabRelativePath, sanitizeFileName } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'

export const DEMO_LAB_NAMES: Record<CsLabDemoKind, string> = {
  'origin-vesta': '演示实验室 · Origin × VESTA',
  'sklgp-geohazard': '演示实验室 · 成都理工大学 SKLGP 泥石流动力学推演',
}

const DEMO_DATA_FILES = [
  'rutile-tio2.cif',
  'srtio3-perovskite.cif',
  'silicon-diamond.poscar',
  'gold-fcc-nanoparticle.pdb',
  'rutile-diff-charge.cube',
  'rutile-chgcar-sample.chgcar',
  'rutile-locpot-sample.locpot',
  'rutile-xrd-cu-ka.csv',
  'rutile-xrd-co-ka.csv',
  'rutile-raman-532nm.csv',
  'silicon-srm640-benchmark.csv',
  '1792573114138-6ac8d0-石榴石_Y_Al_O____YAG____Ia-3d_完整立方晶胞.cif',
] as const

/** PNG 不能走仪器格式嗅探流水线，按 fig 图层单独登记。 */
const DEMO_FIGURE_FILES = ['demo-digitizer-spectrum.png'] as const

const DEMO_FILES = [...DEMO_DATA_FILES, ...DEMO_FIGURE_FILES] as const

const DEMO_DATA_SET = new Set<string>(DEMO_DATA_FILES)

function resolveResourcesDemoDir(subdir: string, envValue?: string, override?: string): string {
  if (override) return override
  if (envValue) return envValue
  if (app?.isPackaged) return join(process.resourcesPath, 'cslab', subdir)
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  return join(appPath, 'resources', 'cslab', subdir)
}

function resolveDemoDir(override?: string): string {
  return resolveResourcesDemoDir('demo', process.env.CSLAB_DEMO_DIR, override)
}

export function resolveGeohazardDemoDir(override?: string): string {
  return resolveResourcesDemoDir(
    'demo-geohazard',
    process.env.CSLAB_GEOHAZARD_DEMO_DIR,
    override,
  )
}

async function assertDemoFiles(demoDir: string): Promise<string[]> {
  const missing: string[] = []
  const paths: string[] = []
  for (const fileName of DEMO_FILES) {
    const fullPath = join(demoDir, fileName)
    try {
      await fs.access(fullPath)
      paths.push(fullPath)
    } catch {
      missing.push(fileName)
    }
  }
  if (missing.length > 0) {
    throw new Error(`演示数据缺失：${missing.join('、')}（期望目录 ${demoDir}）`)
  }
  return paths
}

/**
 * 将演示 PNG 登记为 `fig` 资产（按标题幂等）。
 */
async function ensureDemoFigure(
  labId: string,
  sourcePath: string,
): Promise<CsLabAssetSummary | null> {
  const fileName = basename(sourcePath)
  const existing = listAssets(labId).find(
    (asset) => asset.layerType === 'fig' && asset.title === fileName,
  )
  if (existing) return existing

  await fs.mkdir(join(resolveLabDir(labId), 'vault', 'figures'), { recursive: true })
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const relPath = `vault/figures/${timestamp}-${randomUUID().slice(0, 6)}-${sanitizeFileName(fileName)}`
  const absPath = resolveLabRelativePath(labId, relPath)
  const digest = await copyFileWithHash(sourcePath, absPath)
  const locked = await lockFileReadOnly(absPath)

  const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
  const entityUuid = `fig-${randomUUID().slice(0, 8)}`
  const uri = buildCsLabUri(labId, 'fig', entityUuid)
  const createdAt = Date.now()
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertEntity(db, {
      uri,
      labId,
      layerType: 'fig',
      entityUuid,
      title: fileName,
      format: 'png',
      relPath,
      sha256: digest.sha256,
      bytes: digest.bytes,
      revision,
      locked,
      createdAt,
      updatedAt: createdAt,
    })
    return revision
  })

  return listAssets(labId).find((asset) => asset.uri === uri) ?? null
}

/** 创建或复用 Origin × VESTA 演示实验室，并预生成 4 套出版图。 */
async function createOriginVestaDemoLab(demoDir: string): Promise<CsLabDemoLabResult> {
  const paths = await assertDemoFiles(demoDir)
  const dataPaths = paths.filter((path) => DEMO_DATA_SET.has(basename(path)))
  const figurePaths = paths.filter((path) => !DEMO_DATA_SET.has(basename(path)))

  const existing = findDemoLab('origin-vesta')
  const lab: CsLabLab = existing
    ? existing
    : createLab({
        name: DEMO_LAB_NAMES['origin-vesta'],
        description:
          '内置演示沙箱：金红石/SrTiO3 晶体学、硅 POSCAR 与 NIST 对标、Au 纳米颗粒、Cube/CHGCAR/LOCPOT 体数据，以及 Cu/Co Kα XRD、Raman 与数字化演示图。',
        tags: ['演示', 'Origin 绘图', 'VESTA 晶体学', 'PXRD', '等值面', '拉曼分峰'],
        demoKind: 'origin-vesta',
      })

  const ingestResults = await ingestFiles(lab.id, dataPaths)
  const failed = ingestResults.filter((result) => result.status !== 'ok')
  if (failed.length > 0) {
    throw new Error(`演示数据摄取失败：${failed.map((result) => result.message).join('；')}`)
  }

  for (const figurePath of figurePaths) {
    await ensureDemoFigure(lab.id, figurePath)
  }

  const tableSeriesFor = async (fileName: string): Promise<CsLabTableSeries | undefined> => {
    const result = ingestResults.find(
      (item) => item.asset.title === fileName && item.tableUri,
    )
    if (!result?.tableUri) return undefined
    return (await getTableSeries(lab.id, result.tableUri, 2000)) ?? undefined
  }

  const [cuXrd, coXrd, raman] = [
    await tableSeriesFor('rutile-xrd-cu-ka.csv'),
    await tableSeriesFor('rutile-xrd-co-ka.csv'),
    await tableSeriesFor('rutile-raman-532nm.csv'),
  ]

  const { plotIds, stats } = await buildDemoPlates({
    labId: lab.id,
    demoDir,
    cuXrd,
    coXrd,
    raman,
  })

  const assets = await listAssets(lab.id)
  return { lab, assets, plotId: plotIds[0], plotIds, stats, kind: 'origin-vesta' }
}

/** 创建/复用任意官方演示实验室。 */
/** 记录自定义演示目录（测试/打包覆盖），重置时沿用同一来源。 */
const rememberedDemoDirs = new Map<CsLabDemoKind, string>()

export async function createDemoLab(
  options: { demoDir?: string; kind?: CsLabDemoKind } = {},
): Promise<CsLabDemoLabResult> {
  const kind = options.kind ?? 'origin-vesta'
  if (options.demoDir) rememberedDemoDirs.set(kind, options.demoDir)
  const demoDir = options.demoDir
    ?? rememberedDemoDirs.get(kind)
    ?? (kind === 'sklgp-geohazard' ? resolveGeohazardDemoDir() : resolveDemoDir())
  if (kind === 'sklgp-geohazard') {
    const { createSkLgpGeohazardDemoLab } = await import('./cslab-demo-geohazard')
    return createSkLgpGeohazardDemoLab(demoDir)
  }
  return createOriginVestaDemoLab(demoDir)
}

/** 按类型查找演示实验室；旧 Origin 实验室按名称回填 demoKind。 */
export function findDemoLab(kind?: CsLabDemoKind): CsLabLab | undefined {
  const labs = listLabs()
  if (kind) {
    const direct = labs.find((lab) => lab.demoKind === kind)
    if (direct) return direct
    const legacy = labs.find((lab) => lab.name === DEMO_LAB_NAMES[kind])
    if (legacy) {
      try {
        return updateLabManifest(legacy.id, { demoKind: kind })
      } catch {
        return legacy
      }
    }
    return undefined
  }
  return labs.find((lab) => lab.demoKind === 'origin-vesta')
}

/** 列出全部官方演示实验室（供列表徽标与测试）。 */
export function listAllDemoLabs(): CsLabLab[] {
  return listLabs().filter((lab) => Boolean(lab.demoKind))
}

let ensurePromise: Promise<{ created: CsLabDemoKind[] }> | null = null

/** 静默注册两间演示实验室；单间失败只告警，不阻断列表。 */
export function ensureDemoLabs(options: {
  originDemoDir?: string
  geohazardDemoDir?: string
} = {}): Promise<{ created: CsLabDemoKind[] }> {
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    const created: CsLabDemoKind[] = []
    try {
      if (!findDemoLab('origin-vesta')) {
        await createDemoLab({ kind: 'origin-vesta', demoDir: options.originDemoDir })
        created.push('origin-vesta')
      }
    } catch (error) {
      console.warn('[CSLab] Origin × VESTA 演示实验室注册失败:', error)
    }
    try {
      if (!findDemoLab('sklgp-geohazard')) {
        await createDemoLab({
          kind: 'sklgp-geohazard',
          demoDir: options.geohazardDemoDir,
        })
        created.push('sklgp-geohazard')
      }
    } catch (error) {
      console.warn('[CSLab] SKLGP 泥石流演示实验室注册失败:', error)
    }
    return { created }
  })().finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

/** 重置演示实验室：删除沙箱并用官方样本重建（labId 会变化）。 */
export async function resetDemoLab(labId: string): Promise<CsLabDemoLabResult> {
  const lab = getLab(labId)
  if (!lab) throw new Error('实验室不存在或清单损坏')
  if (!lab.demoKind) throw new Error('只有官方演示实验室支持恢复初始数据')
  // 先等待后台 PDF 富化释放文件句柄，避免 Windows 上 rm EBUSY 留下孤儿目录。
  try {
    const { waitForLiteratureEnrichments } = await import('./cslab-literature-structure')
    await waitForLiteratureEnrichments(8_000)
    const { flushLiteratureIndexRebuilds } = await import('./cslab-graphrag-router')
    await flushLiteratureIndexRebuilds(8_000)
  } catch {
    // 忽略等待失败。
  }
  await deleteLab(labId)
  return createDemoLab({ kind: lab.demoKind })
}

/** 供测试与 UI 展示演示数据清单。 */
export const CSLAB_DEMO_FILES: readonly string[] = DEMO_FILES
