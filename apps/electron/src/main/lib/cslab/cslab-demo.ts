/**
 * CSLab 演示实验室入口
 *
 * 唯一官方演示实验室：演示实验室——生物、化学主题。
 * 旧的 Origin × VESTA 与 SKLGP 泥石流演示实验室在 ensureDemoLabs() 中静默清理。
 */

import type { CsLabDemoKind, CsLabDemoLabResult, CsLabLab } from '@profer/shared'
import { deleteLab, getLab, listLabs } from './cslab-manager'
import {
  FLAGSHIP_DEMO_FILES,
  FLAGSHIP_DEMO_LAB_NAME,
  createFlagshipDemoLab,
  resolveFlagshipDemoDir,
} from './cslab-demo-flagship'

export const DEMO_LAB_NAMES: Record<CsLabDemoKind, string> = {
  flagship: FLAGSHIP_DEMO_LAB_NAME,
}

const OLD_DEMO_KINDS = new Set(['origin-vesta', 'sklgp-geohazard'])
const OLD_DEMO_NAMES = new Set([
  '演示实验室 · Origin × VESTA',
  '演示实验室 · 成都理工大学 SKLGP 泥石流动力学推演',
])

let rememberedDemoDir: string | undefined
let ensurePromise: Promise<{ created: CsLabDemoKind[] }> | null = null

export function resolveDemoDir(override?: string): string {
  return resolveFlagshipDemoDir(override)
}

/** 按类型查找演示实验室。 */
export function findDemoLab(kind: CsLabDemoKind = 'flagship'): CsLabLab | undefined {
  return listLabs().find((lab) => lab.demoKind === kind)
}

/** 列出全部官方演示实验室（供列表徽标与测试）。 */
export function listAllDemoLabs(): CsLabLab[] {
  return listLabs().filter((lab) => Boolean(lab.demoKind))
}

export async function createDemoLab(
  options: { demoDir?: string } = {},
): Promise<CsLabDemoLabResult> {
  if (options.demoDir) rememberedDemoDir = options.demoDir
  return createFlagshipDemoLab({ demoDir: options.demoDir ?? rememberedDemoDir })
}

/** 静默注册唯一的旗舰演示实验室，并清理旧演示沙箱。 */
export function ensureDemoLabs(options: { demoDir?: string } = {}): Promise<{ created: CsLabDemoKind[] }> {
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    // 旧 manifest 里仍可能保存旧 demoKind 字符串；必须用宽泛字符串读取，
    // 否则 CsLabDemoKind 收窄后会触发 TS2367。删除必须串行 await，
    // 等待目录解锁、Watcher 停止与会话解绑完成，避免 Windows 文件锁残留。
    for (const lab of listLabs()) {
      const rawKind = (lab as { demoKind?: string }).demoKind
      if ((rawKind && OLD_DEMO_KINDS.has(rawKind)) || OLD_DEMO_NAMES.has(lab.name)) {
        try {
          await deleteLab(lab.id)
        } catch (error) {
          console.warn(`[CSLab] 清理旧演示实验室失败 (${lab.id}):`, error)
        }
      }
    }

    const created: CsLabDemoKind[] = []
    if (!findDemoLab('flagship')) {
      try {
        await createDemoLab({ demoDir: options.demoDir })
        created.push('flagship')
      } catch (error) {
        console.warn('[CSLab] 旗舰演示实验室注册失败:', error)
      }
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
  if (lab.demoKind !== 'flagship') throw new Error('只有官方演示实验室支持恢复初始数据')
  // 先等待后台文献富化释放文件句柄，避免 Windows 上 rm EBUSY 留下孤儿目录。
  try {
    const { waitForLiteratureEnrichments } = await import('./cslab-literature-structure')
    await waitForLiteratureEnrichments(8_000)
    const { flushLiteratureIndexRebuilds } = await import('./cslab-graphrag-router')
    await flushLiteratureIndexRebuilds(8_000)
  } catch {
    // 忽略等待失败。
  }
  await deleteLab(labId)
  return createDemoLab()
}

/** 供测试与 UI 展示演示数据清单。 */
export const CSLAB_DEMO_FILES: readonly string[] = FLAGSHIP_DEMO_FILES
