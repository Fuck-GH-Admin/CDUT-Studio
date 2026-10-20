/**
 * CSLab 论文文稿管理
 *
 * 存储：
 * - vault/manuscripts/{uuid}.md   —— 人类可读 Markdown（胶囊序列化为 {{capsule:id}}）
 * - vault/manuscripts/{uuid}.json —— TipTap doc JSON + 胶囊快照（编辑器单一事实源）
 * - vault/manuscripts/{uuid}.docx —— 关联的 Word 文稿（可选）
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  CsLabCapsule,
  CsLabManuscript,
  CsLabManuscriptSummary,
  CsLabSaveManuscriptInput,
  CsLabSaveManuscriptAsInput,
  CsLabSaveManuscriptAsResult,
} from '@profer/shared'
import {
  deleteCapsulesByManuscript,
  getCsLabDatabase,
  getEntityByUri,
  getManuscriptRecord,
  insertEdge,
  listEdgesTo,
  listManuscriptRecords,
  nextLabRevision,
  upsertCapsule,
  upsertEntity,
  upsertManuscript,
  withTransaction,
  type CsLabDatabase,
} from './cslab-db'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { buildCsLabUri } from './cslab-uri'
import { listLabCapsules } from './cslab-capsule'
import type { OoxmlImportBlock } from './cslab-ooxml'

interface ManuscriptSidecar {
  version: 1
  title: string
  docJson: unknown
  capsules: CsLabCapsule[]
  updatedAt: number
}

function labDb(labId: string): CsLabDatabase {
  return getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
}

function emptyDoc(title: string): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: title }],
      },
      { type: 'paragraph' },
    ],
  }
}

/** 将 TipTap JSON 转成可读 Markdown（用于 .md 互通与 docx 导出）。 */
export function tipTapToMarkdown(docJson: unknown): string {
  const lines: string[] = []

  const renderInline = (node: Record<string, unknown>): string => {
    if (node.type === 'text') return String(node.text ?? '')
    if (node.type === 'scienceCapsule') {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>
      return `{{capsule:${String(attrs.capsuleId ?? '')}}}`
    }
    const content = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : []
    return content.map(renderInline).join('')
  }

  const renderBlock = (node: Record<string, unknown>): void => {
    const content = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : []
    switch (node.type) {
      case 'heading': {
        const level = Number((node.attrs as Record<string, unknown> | undefined)?.level ?? 1)
        lines.push(`${'#'.repeat(Math.max(1, Math.min(6, level)))} ${content.map(renderInline).join('')}`)
        break
      }
      case 'bulletList':
        for (const item of content) {
          const itemContent = Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
            : []
          lines.push(`- ${itemContent.map(renderInline).join('')}`)
        }
        break
      case 'orderedList':
        content.forEach((item, index) => {
          const itemContent = Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
            : []
          lines.push(`${index + 1}. ${itemContent.map(renderInline).join('')}`)
        })
        break
      case 'paragraph':
        lines.push(content.map(renderInline).join(''))
        break
      default:
        if (content.length > 0) content.forEach(renderBlock)
        break
    }
  }

  const root = docJson as Record<string, unknown> | null
  if (root && Array.isArray(root.content)) {
    for (const child of root.content as Array<Record<string, unknown>>) renderBlock(child)
  }
  return `${lines.join('\n').trim()}\n`
}

async function writeTextAtomic(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, targetPath)
}

async function writeBufferAtomic(targetPath: string, content: Uint8Array): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  try {
    await fs.writeFile(tmpPath, content)
    await fs.rename(tmpPath, targetPath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error('Word 正在占用该文件，请关闭 Word 后重试')
    }
    throw error
  }
}

function manuscriptExists(labId: string, uri: string): boolean {
  return getManuscriptRecord(labDb(labId), uri) != null
}

export function listManuscripts(labIdInput: string): CsLabManuscriptSummary[] {
  const labId = assertLabId(labIdInput)
  return listManuscriptRecords(labDb(labId)).map((record) => ({
    uri: record.uri,
    title: record.title,
    updatedAt: record.updatedAt,
    hasDocx: !!record.docxRelPath,
  }))
}

export async function createManuscript(
  labIdInput: string,
  titleInput: string,
): Promise<CsLabManuscript> {
  const labId = assertLabId(labIdInput)
  const title = (titleInput || '未命名文稿').trim().slice(0, 120)
  const uuid = `doc-${randomUUID().slice(0, 8)}`
  const uri = buildCsLabUri(labId, 'doc', uuid)
  const relPath = `vault/manuscripts/${uuid}.md`
  const sidecarRelPath = `vault/manuscripts/${uuid}.json`
  const now = Date.now()

  const sidecar: ManuscriptSidecar = {
    version: 1,
    title,
    docJson: emptyDoc(title),
    capsules: [],
    updatedAt: now,
  }

  await writeTextAtomic(resolveLabRelativePath(labId, relPath), tipTapToMarkdown(sidecar.docJson))
  await writeTextAtomic(resolveLabRelativePath(labId, sidecarRelPath), `${JSON.stringify(sidecar, null, 2)}\n`)

  const db = labDb(labId)
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertManuscript(db, {
      uri,
      title,
      relPath,
      sidecarRelPath,
      updatedAt: now,
    })
    upsertEntity(db, {
      uri,
      labId,
      layerType: 'doc',
      entityUuid: uuid,
      title,
      format: 'cslab-markdown',
      relPath,
      revision,
      locked: false,
      createdAt: now,
      updatedAt: now,
    })
  })

  return { uri, title, docJson: sidecar.docJson, capsules: [], updatedAt: now }
}

export async function getManuscript(
  labIdInput: string,
  uri: string,
): Promise<CsLabManuscript | null> {
  const labId = assertLabId(labIdInput)
  const record = getManuscriptRecord(labDb(labId), uri)
  if (!record) return null

  try {
    const raw = await fs.readFile(resolveLabRelativePath(labId, record.sidecarRelPath), 'utf-8')
    const sidecar = JSON.parse(raw) as Partial<ManuscriptSidecar>
    const statusMap = new Map(listLabCapsules(labId).map((capsule) => [capsule.id, capsule.status]))
    const capsules = (Array.isArray(sidecar.capsules) ? sidecar.capsules : []).map((capsule) => ({
      ...capsule,
      status: statusMap.get(capsule.id) ?? capsule.status ?? 'fresh',
    }))

    return {
      uri,
      title: sidecar.title ?? record.title,
      docJson: sidecar.docJson ?? emptyDoc(record.title),
      capsules,
      updatedAt: Number(sidecar.updatedAt ?? record.updatedAt),
      docxPath: record.docxRelPath ? resolveLabRelativePath(labId, record.docxRelPath) : undefined,
    }
  } catch {
    return {
      uri,
      title: record.title,
      docJson: emptyDoc(record.title),
      capsules: [],
      updatedAt: record.updatedAt,
      docxPath: record.docxRelPath ? resolveLabRelativePath(labId, record.docxRelPath) : undefined,
    }
  }
}

export async function saveManuscript(input: CsLabSaveManuscriptInput): Promise<CsLabManuscript> {
  const labId = assertLabId(input.labId)
  const record = getManuscriptRecord(labDb(labId), input.uri)
  if (!record) throw new Error('文稿不存在')

  const title = (input.title || record.title).trim().slice(0, 120)
  const capsules = Array.isArray(input.capsules) ? input.capsules : []
  const now = Date.now()
  const sidecar: ManuscriptSidecar = {
    version: 1,
    title,
    docJson: input.docJson,
    capsules,
    updatedAt: now,
  }

  await writeTextAtomic(
    resolveLabRelativePath(labId, record.relPath),
    tipTapToMarkdown(input.docJson),
  )
  await writeTextAtomic(
    resolveLabRelativePath(labId, record.sidecarRelPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  )

  const db = labDb(labId)
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    upsertManuscript(db, {
      uri: record.uri,
      title,
      relPath: record.relPath,
      sidecarRelPath: record.sidecarRelPath,
      docxRelPath: record.docxRelPath,
      updatedAt: now,
    })
    const entity = getEntityByUri(db, record.uri)
    if (entity) {
      upsertEntity(db, { ...entity, title, revision, updatedAt: now })
    }

    deleteCapsulesByManuscript(db, record.uri)
    for (const capsule of capsules) {
      if (!capsule.tableUri) continue
      upsertCapsule(
        db,
        {
          ...capsule,
          labId,
          status: 'fresh',
          updatedAt: now,
        },
        record.uri,
      )
      const capsuleUri = buildCsLabUri(labId, 'capsule', capsule.id)
      const hasEdge = listEdgesTo(db, capsuleUri).some((edge) => edge.fromUri === capsule.tableUri)
      if (!hasEdge) {
        insertEdge(db, labId, capsule.tableUri, capsuleUri, 'binds', {
          column: capsule.column,
          rowIndex: capsule.rowIndex,
        })
      }
    }
  })

  return {
    uri: record.uri,
    title,
    docJson: input.docJson,
    capsules,
    updatedAt: now,
    docxPath: record.docxRelPath ? resolveLabRelativePath(labId, record.docxRelPath) : undefined,
  }
}


export async function saveManuscriptAs(
  input: CsLabSaveManuscriptAsInput,
): Promise<CsLabSaveManuscriptAsResult> {
  const labId = assertLabId(input.labId)
  if (!input.targetPath || typeof input.targetPath !== 'string') {
    throw new Error('另存为目标路径无效')
  }

  // 1. 同步更新沙箱内部文稿副本
  await saveManuscript({
    labId,
    uri: input.uri,
    title: input.title,
    docJson: input.docJson,
    capsules: input.capsules,
  })

  // 2. 根据目标扩展名判定格式（.md 或 .docx，默认 .docx）
  const targetPath = input.targetPath
  const isMd = targetPath.toLowerCase().endsWith('.md') || input.format === 'md'
  const finalFormat: 'docx' | 'md' = isMd ? 'md' : 'docx'

  if (isMd) {
    const markdown = tipTapToMarkdown(input.docJson)
    await writeTextAtomic(targetPath, markdown)
    return {
      success: true,
      targetPath,
      format: 'md',
      message: '文稿已成功另存为 Markdown 文件',
    }
  }

  // 默认导出为 docx
  const { runOoxmlTask } = await import('./cslab-ooxml')
  const capsules = (Array.isArray(input.capsules) ? input.capsules : []).map((capsule: CsLabCapsule) => ({
    id: capsule.id,
    label: capsule.label,
    unit: capsule.unit,
    value: capsule.value,
  }))

  const exported = await runOoxmlTask({
    type: 'export',
    input: {
      title: input.title,
      docJson: input.docJson,
      capsules,
    },
  })
  if (exported.type !== 'export') throw new Error('OOXML 导出结果类型异常')

  await writeBufferAtomic(targetPath, exported.result.buffer)
  return {
    success: true,
    targetPath,
    format: 'docx',
    message: '文稿已成功另存为 Word (.docx) 文件',
  }
}

export function getLinkedDocxPath(labIdInput: string, uri: string): string | null {
  const labId = assertLabId(labIdInput)
  const record = getManuscriptRecord(labDb(labId), uri)
  if (!record?.docxRelPath) return null
  return resolveLabRelativePath(labId, record.docxRelPath)
}

/** 兼容旧命名。 */
export const getManuscriptDocxPath = getLinkedDocxPath

/** 记录并落盘关联的 Word 文稿（复制进沙箱，成为长期同步目标）。 */
export async function attachDocx(
  labIdInput: string,
  uri: string,
  docxBuffer: Uint8Array,
): Promise<string> {
  const labId = assertLabId(labIdInput)
  const record = getManuscriptRecord(labDb(labId), uri)
  if (!record) throw new Error('文稿不存在')

  const docxRelPath = record.docxRelPath ?? `vault/manuscripts/${record.uri.split('/').pop()}.docx`
  await writeBufferAtomic(resolveLabRelativePath(labId, docxRelPath), docxBuffer)

  const db = labDb(labId)
  upsertManuscript(db, {
    uri: record.uri,
    title: record.title,
    relPath: record.relPath,
    sidecarRelPath: record.sidecarRelPath,
    docxRelPath,
    updatedAt: Date.now(),
  })
  return resolveLabRelativePath(labId, docxRelPath)
}

/** 覆盖写回长期同步副本（导入原件或首次导出文件）。 */
export async function writeLinkedDocx(
  labIdInput: string,
  uri: string,
  docxBuffer: Uint8Array,
): Promise<string> {
  return attachDocx(labIdInput, uri, docxBuffer)
}

/**
 * 导出写盘：
 * - 已有 linked docx → 写独立的 `.export.docx`，绝不覆盖原件；
 * - 尚无 linked docx → 写 `{uuid}.docx` 并建立长期同步链接。
 */
export async function writeExportDocx(
  labIdInput: string,
  uri: string,
  docxBuffer: Uint8Array,
): Promise<{ path: string; linkedPath?: string; createdLink: boolean }> {
  const labId = assertLabId(labIdInput)
  const record = getManuscriptRecord(labDb(labId), uri)
  if (!record) throw new Error('文稿不存在')

  if (!record.docxRelPath) {
    const linkedPath = await attachDocx(labId, uri, docxBuffer)
    return { path: linkedPath, linkedPath, createdLink: true }
  }

  const uuid = record.uri.split('/').pop() ?? 'manuscript'
  const exportRelPath = `vault/manuscripts/${uuid}.export.docx`
  const exportPath = resolveLabRelativePath(labId, exportRelPath)
  await writeBufferAtomic(exportPath, docxBuffer)
  return {
    path: exportPath,
    linkedPath: resolveLabRelativePath(labId, record.docxRelPath),
    createdLink: false,
  }
}

/** 兼容旧命名：写回 linked docx。 */
export async function writeDocxBuffer(
  labIdInput: string,
  uri: string,
  docxBuffer: Uint8Array,
): Promise<string> {
  return writeLinkedDocx(labIdInput, uri, docxBuffer)
}

/** 读取沙箱内 linked Word 文稿；不存在返回 null。 */
export async function readDocxBuffer(
  labIdInput: string,
  uri: string,
): Promise<{ path: string; buffer: Buffer } | null> {
  const labId = assertLabId(labIdInput)
  const docxPath = getLinkedDocxPath(labId, uri)
  if (!docxPath) return null
  try {
    return { path: docxPath, buffer: await fs.readFile(docxPath) }
  } catch {
    return null
  }
}

/** 从 docx 导入的纯文本段落到 TipTap 文档 JSON（兜底路径）。 */
export function paragraphsToDocJson(paragraphs: string[]): unknown {
  return {
    type: 'doc',
    content:
      paragraphs.length > 0
        ? paragraphs.map((text) => ({
            type: 'paragraph',
            content: text ? [{ type: 'text', text }] : [],
          }))
        : [{ type: 'paragraph' }],
  }
}

/**
 * 结构化导入块 → TipTap 文档 JSON。
 * 保留胶囊在正文中的原始位置，并将其标记为 orphan（待重新绑定数据表）。
 */
export function blocksToDocJson(
  blocks: OoxmlImportBlock[],
  capsules: Array<{ id: string; label?: string; unit?: string; value: string }> = [],
): unknown {
  const capsuleMap = new Map(capsules.map((capsule) => [capsule.id, capsule]))

  const toInlineNodes = (
    inlines: OoxmlImportBlock['inlines'],
  ): Array<Record<string, unknown>> => {
    const nodes: Array<Record<string, unknown>> = []

    for (const inline of inlines) {
      if (inline.kind === 'capsule') {
        const capsule = capsuleMap.get(inline.capsuleId)
        nodes.push({
          type: 'scienceCapsule',
          attrs: {
            capsuleId: inline.capsuleId,
            label: capsule?.label ?? inline.capsuleId,
            value: capsule?.value ?? '',
            unit: capsule?.unit ?? '',
            tableUri: '',
            column: '',
            rowIndex: 0,
            revisionAtBind: 0,
            status: 'orphan',
          },
        })
        continue
      }

      const marks: Array<Record<string, unknown>> = []
      if (inline.marks?.bold) marks.push({ type: 'bold' })
      if (inline.marks?.italic) marks.push({ type: 'italic' })
      if (inline.marks?.code) marks.push({ type: 'code' })
      if (inline.marks?.underline) marks.push({ type: 'underline' })

      // Word 修订 -> TipTap track marks（同类型只保留一个，避免 ProseMirror 非法标记组合）。
      if (inline.track && inline.track.id > 0) {
        marks.push({
          type: inline.track.kind,
          attrs: {
            suggestionId: `word-${inline.track.id}`,
            authorId: inline.track.author ?? 'Word',
            authorName: inline.track.author ?? 'Word',
            personaType: 'human',
            createdAt: inline.track.date ? Date.parse(inline.track.date) || undefined : undefined,
          },
        })
      }
      const comment = inline.comments?.[0]
      if (comment) {
        marks.push({
          type: 'comment',
          attrs: {
            suggestionId: `comment-${comment.id}`,
            commentText: comment.text ?? '',
            authorId: comment.author ?? 'Word',
            authorName: comment.author ?? 'Word',
            personaType: 'human',
          },
        })
      }

      const pieces = inline.text.split('\n')
      pieces.forEach((piece, index) => {
        if (piece) {
          nodes.push({
            type: 'text',
            text: piece,
            ...(marks.length > 0 ? { marks } : {}),
          })
        }
        if (index < pieces.length - 1) nodes.push({ type: 'hardBreak' })
      })
    }

    return nodes
  }

  return {
    type: 'doc',
    content:
      blocks.length > 0
        ? blocks.map((block) => {
            const content = toInlineNodes(block.inlines)
            if (block.type === 'heading') {
              return {
                type: 'heading',
                attrs: { level: Math.max(1, Math.min(6, block.level ?? 1)) },
                content,
              }
            }
            return { type: 'paragraph', content }
          })
        : [{ type: 'paragraph' }],
  }
}

export { manuscriptExists }
