/**
 * CDUT 专区特区账户状态 Atom
 *
 * 仅保存「特区账户」的本地展示状态（学号 / 姓名 / 连接状态）。
 * 真实认证与凭证加密全部在主进程完成，渲染进程只消费
 * window.electronAPI.cdutZone 推送与查询结果，绝不接触明文密码。
 */

import { atom } from 'jotai'
import type { CdutAccountProfile, CdutSubViewId } from '@profer/shared'

/** CDUT 特区账户全局状态（默认未连接） */
export const cdutAccountAtom = atom<CdutAccountProfile>({
  studentId: '',
  studentName: '',
  status: 'disconnected',
})

/**
 * CDUT 专区当前打开的子页面标识；null 表示停留在专区首页。
 * 进入任一板块（AI速课堂 / 智联万站 / 材料审查）时非空，关闭后回到 null。
 */
export const cdutSubViewAtom = atom<CdutSubViewId>(null)

/**
 * 进入板块前的主边栏折叠态暂存（沉浸式折叠与记忆恢复）。
 * null 表示当前未处于子页面；点击关闭恢复该值后重置为 null。
 */
export const cdutSidebarRestoreAtom = atom<boolean | null>(null)

/**
 * 「AI速课堂 访问受限」登录引导弹窗开关。
 * 未登录特区账户时，用户在主侧边栏点击被锁定的「AI速课堂」项目/会话即置为 true。
 */
export const cdutAiClassLockPromptAtom = atom<boolean>(false)
