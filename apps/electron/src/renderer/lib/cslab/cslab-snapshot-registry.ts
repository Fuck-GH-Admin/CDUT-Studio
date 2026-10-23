/**
 * CSLab 3D 视窗截图提供者注册表（渲染进程）
 *
 * 舞台的 4 个窗格常驻挂载（仅用 hidden 控制可见性），
 * 因此截图必须按 paneId 精确定位，不能使用全局单例。
 */

import type { CsLabPaneId } from '@/atoms/cslab-atoms'

type CaptureFn = (scale: number) => Promise<string>

const providers = new Map<CsLabPaneId, CaptureFn>()

/** 注册某窗格的截图提供者；返回注销函数。 */
export function registerCsLabSnapshotProvider(
  paneId: CsLabPaneId,
  capture: CaptureFn,
): () => void {
  providers.set(paneId, capture)
  return () => {
    if (providers.get(paneId) === capture) providers.delete(paneId)
  }
}

/** 调用指定窗格的截图提供者。 */
export function captureCsLabSnapshot(paneId: CsLabPaneId, scale: number): Promise<string> {
  const capture = providers.get(paneId)
  if (!capture) throw new Error('目标窗格没有可用的 3D 晶体视窗')
  return capture(scale)
}
