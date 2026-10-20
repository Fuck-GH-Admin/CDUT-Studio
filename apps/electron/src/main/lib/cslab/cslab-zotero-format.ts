/**
 * Zotero 附件路径解析（主进程）
 *
 * 纯坐标函数已下沉到 `@profer/shared`，避免渲染进程间接引入 node:path。
 * 旋转方向与 PDF.js PageViewport 保持一致（见 shared/utils/cslab-zotero.ts）。
 */

import { isAbsolute, join } from 'node:path'

export {
  normalizeRotation,
  parseZoteroAnnotationPosition,
  zoteroRectToViewport,
} from '@profer/shared'
export type {
  ZoteroAnnotationPosition,
  ZoteroRect,
  ZoteroRotation,
  ZoteroViewportRect,
} from '@profer/shared'

export interface ZoteroAttachmentPathInput {
  /** Zotero `itemAttachments.path` 原值。 */
  path: string
  attachmentKey: string
  dataDir: string
  linkedBasePath?: string
}

export interface ZoteroAttachmentPathResult {
  path?: string
  reason?: string
}

/**
 * 将 Zotero 附件路径重建为宿主机绝对路径。
 *
 * - `storage:`   → `<dataDir>/storage/<attachmentKey>/<rest>`
 * - `attachments:` → `<linkedBasePath>/<rest>`
 * - 其他         → 视为绝对路径
 */
export function resolveZoteroAttachmentPath(
  input: ZoteroAttachmentPathInput,
): ZoteroAttachmentPathResult {
  const raw = typeof input.path === 'string' ? input.path.trim() : ''
  if (!raw) return { reason: '附件缺少 path 字段' }

  const normalized = raw.replace(/\\/g, '/')

  if (normalized.startsWith('storage:')) {
    const relative = normalized.slice('storage:'.length).replace(/^\/+/, '')
    if (!relative) return { reason: 'storage 附件缺少文件名' }
    return { path: join(input.dataDir, 'storage', input.attachmentKey, relative) }
  }

  if (normalized.startsWith('attachments:')) {
    const relative = normalized.slice('attachments:'.length).replace(/^\/+/, '')
    if (!relative) return { reason: 'attachments 附件缺少相对路径' }
    if (!input.linkedBasePath) {
      return { reason: '未配置 linkedAttachmentBasePath，无法解析 attachments: 附件' }
    }
    return { path: join(input.linkedBasePath, relative) }
  }

  if (isAbsolute(normalized)) return { path: normalized }
  return { path: join(input.dataDir, normalized) }
}
