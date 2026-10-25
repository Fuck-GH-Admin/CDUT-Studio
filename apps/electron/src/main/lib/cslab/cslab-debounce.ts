/**
 * CSLab 轻量防抖器（已收敛至 @profer/shared）
 *
 * 历史实现迁出至 packages/shared/src/utils/debounce.ts，本文件保留为薄重导出，
 * 避免破坏 cslab-canvas-sync / cslab-tool-registry / cslab-zotero 等既有引用。
 *
 * 与 lodash.debounce 的差异：
 * - 额外支持 maxWait，避免持续 WAL 追加导致同步永远不触发；
 * - 计时器统一 unref，不阻塞 Electron 进程退出。
 */

export { createDebouncer } from '@profer/shared'
export type { CsLabDebounced } from '@profer/shared'
