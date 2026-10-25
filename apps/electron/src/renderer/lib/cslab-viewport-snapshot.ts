/**
 * CDUT Science 用户视口快照（Bug：消除「这是什么」视野盲区）。
 *
 * 前端各科研视图把「用户此刻正看着什么」写进本模块；
 * 发送 Agent 消息时统一取出并挂到 `AgentSendInput.cslabViewport`，
 * 主进程注入动态上下文后，模型即可解析「这是什么 / 这里」等指代性提问。
 *
 * 设计为模块级单例而非组件 state：发送动作分散在 AgentView 的多个入口，
 * 只有集中快照才能保证任何一条发送路径都带上最新视口。
 */

import type { CsLabViewportSnapshot } from '@profer/shared'

let current: CsLabViewportSnapshot | undefined

/** 合并式更新；只覆盖传入的字段，未传字段保持原值。 */
export function setCsLabViewportSnapshot(patch: Partial<Omit<CsLabViewportSnapshot, 'capturedAt'>>): void {
  current = {
    ...(current ?? { capturedAt: new Date().toISOString() }),
    ...patch,
    capturedAt: new Date().toISOString(),
  }
}

/** 发送消息时取用；无任何视图活动时返回 undefined，不向模型注入空块。 */
export function getCsLabViewportSnapshot(): CsLabViewportSnapshot | undefined {
  return current
}

/** 供测试重置。 */
export function __resetCsLabViewportSnapshotForTest(): void {
  current = undefined
}
