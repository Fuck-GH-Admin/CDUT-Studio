/**
 * PDF 直接导入为文献、路径解析与幂等复用测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-lit-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '文献导入测试实验室' })
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { readdirSync } = await import('node:fs')
  try {
    const litDir = join(resolveLabDir(lab.id), 'vault', 'lit')
    for (const entry of readdirSync(litDir)) await unlockFile(join(litDir, entry))
  } catch {
    // 目录可能不存在。
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

describe('PDF 文献导入', () => {
  test('PDF 复制入 vault/lit、只读锁、不生成数据表', async () => {
    const { ingestFiles, resolveAssetPath } = await import('./cslab-iron-cage')
    const { getLiteratureItem, getLiteratureFilePath } = await import('./cslab-literature')
    const { isFileReadOnly } = await import('./cslab-hash')

    const source = join(rootDir, 'paper.pdf')
    writeFileSync(source, '%PDF-1.4\n% Synthetic literature\n', 'utf-8')

    const results = await ingestFiles(lab.id, [source])
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('ok')
    expect(results[0]?.asset.layerType).toBe('lit')
    expect(results[0]?.asset.format).toBe('pdf')
    expect(results[0]?.tableUri).toBeUndefined()

    const item = getLiteratureItem(lab.id, results[0]!.asset.uri)
    expect(item?.source).toBe('vault')
    expect(item?.hasFile).toBe(true)

    const resolved = getLiteratureFilePath(lab.id, results[0]!.asset.uri)
    expect(resolved.path).toBeTruthy()
    expect(await isFileReadOnly(resolved.path!)).toBe(true)

    const assetPath = resolveAssetPath(lab.id, results[0]!.asset.uri)
    expect(assetPath).toBe(resolved.path ?? null)
  })

  test('相同 PDF 复用既有文献 URI', async () => {
    const { ingestFiles, listAssets } = await import('./cslab-iron-cage')
    const source = join(rootDir, 'paper.pdf')
    const before = listAssets(lab.id).filter((asset) => asset.layerType === 'lit')
    const results = await ingestFiles(lab.id, [source])
    expect(results[0]?.asset.uri).toBe(before[0]?.uri)
    expect(listAssets(lab.id).filter((asset) => asset.layerType === 'lit')).toHaveLength(
      before.length,
    )
  })

  test('未登记文献返回可读原因', async () => {
    const { getLiteratureFilePath } = await import('./cslab-literature')
    const result = getLiteratureFilePath(lab.id, `cdut://${lab.id}/lit/not-exist`)
    expect(result.path).toBeUndefined()
    expect(result.reason).toContain('未登记')
  })
})
