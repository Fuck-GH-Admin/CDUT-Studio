/**
 * 智联万站 · 桌宠「砚小龙」渲染层状态原子
 *
 * 桌宠运行在独立的透明子窗口中，主进程为配置 / 记忆 / 流式的唯一数据源，
 * 渲染层只消费广播与本地交互态，遵循项目“状态全量 Jotai”约定。
 */

import { atom } from 'jotai'
import type {
  YanhuPetConfig,
  YanhuPetMessage,
  YanhuPetSpriteState,
  YanhuPetToolInvocation,
} from '@profer/shared'

/**
 * 桌宠默认配置（与主进程 createDefaultYanhuPetConfig 保持一致：默认常驻伴随模式）。
 *
 * `petPosition` 的 (24, 24) 为「待动态居中」占位值：桌宠视口尺寸只有在运行时才可知，
 * 故宿主组件（YanhuPetFloatingHost）会在首帧拿到有效视口后，自动将其迁移至物理正中央。
 */
export const DEFAULT_PET_CONFIG: YanhuPetConfig = {
  dialogPosition: 'right',
  isCollapsed: false,
  memoryLimit: 50,
  petPosition: { x: 24, y: 24 },
}

/** 桌宠配置 */
export const petConfigAtom = atom<YanhuPetConfig>(DEFAULT_PET_CONFIG)

/** 智联万站视口尺寸（DIP）；未知时为 null */
export const petViewportSizeAtom = atom<{ width: number; height: number } | null>(null)

/** 智联万站是否处于呈现态 */
export const petPresentedAtom = atom<boolean>(false)

/** 历史消息列表（主进程为源） */
export const petMessagesAtom = atom<YanhuPetMessage[]>([])

/** 是否正在生成（驱动 Walking 态） */
export const petStreamingAtom = atom<boolean>(false)

/** 当前流式累积的正文 */
export const petStreamTextAtom = atom<string>('')

/** 当前流式累积的思考链 */
export const petReasoningTextAtom = atom<string>('')

/** 本轮正在执行 / 已执行的工具调用（微胶囊标签流） */
export const petActiveToolsAtom = atom<YanhuPetToolInvocation[]>([])

/** 当前对话请求 ID */
export const petRequestIdAtom = atom<string | null>(null)

/** 四态精灵动画状态 */
export const petSpriteStateAtom = atom<YanhuPetSpriteState>('breathing')
