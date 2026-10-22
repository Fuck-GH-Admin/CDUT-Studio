/**
 * 本地系统公告栏（Bulletin Board）相关类型
 *
 * 公告数据由应用打包内置的 bulletin.json 维护，随版本迭代本地更新，
 * 零外部网络请求；渲染端通过 IPC 读取展示。
 */

/** 公告分类 */
export type BulletinCategory = 'notice' | 'feature' | 'tip' | 'maintenance'

/** 单条公告记录 */
export interface BulletinItem {
  /** 稳定唯一 ID（如 notice-2026-10-welcome），已读判定依据 */
  id: string
  /** 公告标题 */
  title: string
  /** 发布日期（YYYY-MM-DD） */
  date: string
  /** 公告分类 */
  category: BulletinCategory
  /** 列表页一句话摘要（可选） */
  summary?: string
  /** Markdown 正文 */
  content: string
  /** 附加标签文案（可选） */
  tag?: string
  /** 置顶标记（仅影响列表展示排序，不影响"最新"判定） */
  pinned?: boolean
}

/** 内置公告数据文件结构 */
export interface BulletinFile {
  /** 数据结构版本 */
  version: string
  /** 公告列表 */
  items: BulletinItem[]
}

/** 公告栏 IPC 通道常量 */
export const BULLETIN_IPC_CHANNELS = {
  /** 获取内置公告列表 */
  GET: 'bulletin:get',
} as const
