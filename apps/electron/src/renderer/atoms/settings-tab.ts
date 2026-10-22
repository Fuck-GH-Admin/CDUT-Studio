/**
 * Settings Tab Atom — 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页：
 * - general: 通用
 * - usage: 使用偏好（通知与声音 / 对话浏览 / 输入体验）
 * - account: 账户与资料
 * - channels: 模型配置
 * - agent: Agent 配置
 * - tools: Chat 工具
 * - bots: 远程连接
 * - shortcuts: 快捷键管理
 * - appearance: 外观设置
 * - proxy: 代理设置
 * - devices: 登录设备
 * - openapi: 开放 API
 * - data-management: 数据管理（备份+磁盘）
 * - developer: 开发者模式（版本号连击解锁后显示）
 * - team: 团队管理
 * - about: 关于（含意见反馈）
 */

import { atom } from 'jotai'

export type SettingsTab = 'general' | 'usage' | 'account' | 'channels' | 'appearance' | 'about' | 'agent' | 'tools' | 'bots' | 'tutorial' | 'shortcuts' | 'team' | 'openapi' | 'data-management' | 'developer' | 'proxy' | 'devices'

/** 当前设置标签页（不持久化，每次打开设置默认显示通用偏好） */
export const settingsTabAtom = atom<SettingsTab>('general')

/** 设置浮窗是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道创建表单是否有未保存内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置面板（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)
