/**
 * bulletin-atoms — 本地系统公告栏（Bulletin Board）状态
 *
 * 公告数据源自应用内置 bulletin.json（经主进程 IPC 读取），
 * 弹窗生命周期：启动自动弹一次 → 用户关闭后本次运行不再弹 → 下次有新公告再提醒一次。
 */
import { atom } from 'jotai'
import type { BulletinItem } from '@profer/shared'

/** 公告列表缓存（由启动触发器或弹窗打开时拉取写入） */
export const bulletinListAtom = atom<BulletinItem[]>([])

/** 当前选中公告条目 ID */
export const selectedBulletinIdAtom = atom<string | null>(null)

/** 公告栏弹窗是否打开 */
export const bulletinDialogOpenAtom = atom(false)

/** 已读基准 ID（启动时从 settings 同步；关闭弹窗时写回 settings） */
export const bulletinLastReadIdAtom = atom<string | null>(null)

/**
 * 本次软件运行会话中是否已被用户关闭
 * 内存态：每次退出并重新启动软件时自动复位为 false
 */
export const bulletinSessionDismissedAtom = atom(false)
