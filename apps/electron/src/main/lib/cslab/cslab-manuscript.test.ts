/**
 * CSLab 文稿 Word 路径分离与导入结构测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab, CsLabManuscript } from '@profer/shared'
import { blocksToDocJson } from './cslab-manuscript'

let rootDir = ''
let lab: CsLabLab
let manuscript: CsLabManuscript

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-manuscript-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  const { createManuscript } = await import('./cslab-manuscript')
  lab = createLab({ name: '文稿路径测试实验室' })
  manuscript = await createManuscript(lab.id, '路径测试文稿')
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  try {
    const dir = join(resolveLabDir(lab.id), 'vault', 'manuscripts')
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.docx')) await unlockFile(join(dir, entry))
    }
  } catch {
    // 忽略清理异常。
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows SQLite 句柄可能延迟释放。
  }
})

describe('Word 路径分离', () => {
  test('首次导出建立 linked 副本', async () => {
    const { writeExportDocx, getLinkedDocxPath } = await import('./cslab-manuscript')
    const result = await writeExportDocx(lab.id, manuscript.uri, Buffer.from('FIRST-EXPORT'))
    expect(result.createdLink).toBe(true)
    expect(result.linkedPath).toBeTruthy()
    expect(getLinkedDocxPath(lab.id, manuscript.uri)).toBe(result.linkedPath!)
    expect(readFileSync(result.path, 'utf-8')).toBe('FIRST-EXPORT')
  })

  test('已存在 linked 时再次导出写入独立 .export.docx 且不覆盖原件', async () => {
    const { writeExportDocx, getLinkedDocxPath } = await import('./cslab-manuscript')
    const linkedPath = getLinkedDocxPath(lab.id, manuscript.uri)
    expect(linkedPath).toBeTruthy()
    expect(readFileSync(linkedPath!, 'utf-8')).toBe('FIRST-EXPORT')

    const second = await writeExportDocx(lab.id, manuscript.uri, Buffer.from('SECOND-EXPORT'))
    expect(second.createdLink).toBe(false)
    expect(second.path.endsWith('.export.docx')).toBe(true)
    expect(second.path).not.toBe(linkedPath)
    expect(readFileSync(linkedPath!, 'utf-8')).toBe('FIRST-EXPORT')
    expect(readFileSync(second.path, 'utf-8')).toBe('SECOND-EXPORT')
    expect(existsSync(second.path)).toBe(true)
  })

  test('同步写回只作用于 linked 副本', async () => {
    const { writeLinkedDocx, getLinkedDocxPath } = await import('./cslab-manuscript')
    const linkedPath = getLinkedDocxPath(lab.id, manuscript.uri)!
    await writeLinkedDocx(lab.id, manuscript.uri, Buffer.from('SYNCED'))
    expect(readFileSync(linkedPath, 'utf-8')).toBe('SYNCED')
  })
})

describe('结构化导入转 TipTap', () => {
  test('保留标题、加粗、胶囊位置与换行', () => {
    const docJson = blocksToDocJson(
      [
        {
          type: 'heading',
          level: 2,
          inlines: [{ kind: 'text', text: '结果与讨论' }],
        },
        {
          type: 'paragraph',
          inlines: [
            { kind: 'text', text: '转化率 ', marks: { bold: true } },
            { kind: 'capsule', capsuleId: 'cap-1' },
            { kind: 'text', text: ' 达标\n第二行' },
          ],
        },
      ],
      [{ id: 'cap-1', label: 'Yield', unit: '%', value: '80' }],
    ) as { content: Array<Record<string, unknown>> }

    expect(docJson.content[0]?.type).toBe('heading')
    expect((docJson.content[0]?.attrs as { level: number }).level).toBe(2)

    const paragraphContent = docJson.content[1]?.content as Array<Record<string, unknown>>
    expect(paragraphContent[0]).toMatchObject({
      type: 'text',
      text: '转化率 ',
      marks: [{ type: 'bold' }],
    })
    expect(paragraphContent[1]?.type).toBe('scienceCapsule')
    expect(paragraphContent[1]?.attrs).toMatchObject({
      capsuleId: 'cap-1',
      value: '80',
      status: 'orphan',
    })
    expect(paragraphContent.some((node) => node.type === 'hardBreak')).toBe(true)
  })
})

describe('文稿保存与另存为', () => {
  test('保存文稿正文并持久化 JSON 与 Markdown', async () => {
    const { saveManuscript, getManuscript } = await import('./cslab-manuscript')
    const sampleDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '论文总标题' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '这是测试的一整段实验正文内容。' }] },
      ],
    }

    const saved = await saveManuscript({
      labId: lab.id,
      uri: manuscript.uri,
      title: '论文总标题',
      docJson: sampleDoc,
      capsules: [],
    })

    expect(saved.title).toBe('论文总标题')
    expect(saved.docJson).toEqual(sampleDoc)

    const reloaded = await getManuscript(lab.id, manuscript.uri)
    expect(reloaded).not.toBeNull()
    expect(reloaded?.title).toBe('论文总标题')
    expect(reloaded?.docJson).toEqual(sampleDoc)
  })

  test('另存为 Markdown 与 Word (.docx)', async () => {
    const { saveManuscriptAs } = await import('./cslab-manuscript')
    const mdTarget = join(rootDir, 'exported-manuscript.md')
    const docxTarget = join(rootDir, 'exported-manuscript.docx')

    const mdRes = await saveManuscriptAs({
      labId: lab.id,
      uri: manuscript.uri,
      targetPath: mdTarget,
      title: '论文总标题',
      docJson: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '论文总标题' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'MD段落内容' }] },
        ],
      },
      capsules: [],
    })

    expect(mdRes.success).toBe(true)
    expect(mdRes.format).toBe('md')
    expect(existsSync(mdTarget)).toBe(true)
    expect(readFileSync(mdTarget, 'utf-8')).toContain('MD段落内容')

    const docxRes = await saveManuscriptAs({
      labId: lab.id,
      uri: manuscript.uri,
      targetPath: docxTarget,
      title: '论文总标题',
      docJson: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '论文总标题' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Docx段落内容' }] },
        ],
      },
      capsules: [],
    })

    expect(docxRes.success).toBe(true)
    expect(docxRes.format).toBe('docx')
    expect(existsSync(docxTarget)).toBe(true)
  })
})
