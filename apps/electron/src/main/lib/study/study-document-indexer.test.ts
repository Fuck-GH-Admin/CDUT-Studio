/**
 * 速课堂资料大纲直出全文路径回归测试。
 *
 * 目标：索引未命中关键词时，模型必须能直接从大纲拿到 `document.md` 绝对路径，
 * 不再通过 `ls` / `find` 盲搜 study-materials 目录。
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const isolatedRoot = mkdtempSync(join(tmpdir(), 'study-outline-'))
const previousConfigDir = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = isolatedRoot

const { buildStudyOutlineForPrompt, ingestStudyDocuments } = await import('./study-document-indexer')
const { getStudyDocumentDir } = await import('../config-paths')

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigDir
  rmSync(isolatedRoot, { recursive: true, force: true })
})

describe('buildStudyOutlineForPrompt 全文路径', () => {
  test('为每份资料直出 document.md 绝对路径', async () => {
    const sessionId = 'outline-session'
    const sourcePath = join(isolatedRoot, '团队成员.md')
    writeFileSync(sourcePath, '# 团队成员\n\n王涛，地球物理学院。\n\n## 研究方向\n\n地震波成像。', 'utf-8')

    const outlines = await ingestStudyDocuments(sessionId, [sourcePath])
    expect(outlines).toHaveLength(1)
    const documentId = outlines[0]!.documentId

    const outline = buildStudyOutlineForPrompt(sessionId)
    const documentPath = join(getStudyDocumentDir(sessionId, documentId), 'document.md').replace(/\\/g, '/')

    expect(outline).toContain('Direct Full-Text Path:')
    expect(outline).toContain(documentPath)
    expect(outline).toContain('no find/ls probe')
    expect(existsSync(documentPath)).toBe(true)
  })

  test('无资料时返回空串', () => {
    expect(buildStudyOutlineForPrompt('empty-session')).toBe('')
  })
})
