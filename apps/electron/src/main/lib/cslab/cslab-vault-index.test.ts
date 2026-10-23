/**
 * CSLab Vault 笔记检索相关度排序测试
 *
 * 标题命中必须优先于正文命中，避免高价值笔记因创建时间早而被截断。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab
const previousConfigDir = process.env.PROFER_CONFIG_DIR

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-vault-index-'))
  process.env.PROFER_CONFIG_DIR = rootDir

  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: 'Vault 检索排序测试实验室' })

  const notesDir = join(lab.rootPath, 'vault', 'notes')
  const titleHit = join(notesDir, '界面阻抗.md')
  writeFileSync(titleHit, '# 界面阻抗\n\n这是标题精确命中的笔记。\n', 'utf-8')
  // 标题命中的笔记创建更早，旧实现会因此被排在后面甚至截断。
  const older = new Date(Date.now() - 120_000)
  utimesSync(titleHit, older, older)

  const bodyHit = join(notesDir, '循环稳定性.md')
  writeFileSync(bodyHit, '# 循环稳定性\n\n正文提到了界面阻抗，但标题没有。\n', 'utf-8')
})

afterAll(async () => {
  const { closeCsLabVaultCache } = await import('./cslab-vault-cache')
  const { __clearVaultContentLru } = await import('./cslab-vault-index')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  __clearVaultContentLru()
  closeCsLabVaultCache(lab.id)
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放时交给系统回收。
  }
  if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigDir
})

describe('Vault 笔记检索', () => {
  test('标题命中优先于正文命中并参与截断', async () => {
    const { rebuildVaultIndex, searchVaultNotes } = await import('./cslab-vault-index')
    await rebuildVaultIndex(lab.id, { force: true })

    const top = searchVaultNotes(lab.id, '界面阻抗', 1)
    expect(top).toHaveLength(1)
    expect(top[0]?.title).toBe('界面阻抗')

    const all = searchVaultNotes(lab.id, '界面阻抗', 10)
    expect(all.map((note) => note.title)).toEqual(['界面阻抗', '循环稳定性'])
  })
})
