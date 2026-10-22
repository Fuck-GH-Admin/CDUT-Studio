/**
 * CSLab 3D 晶体视窗快照服务测试（PNG 校验、落盘与尺寸元数据）
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

// 1×1 透明 PNG
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-snapshot-test-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '快照服务测试实验室' })
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  try {
    const figures = join(resolveLabDir(lab.id), 'vault', 'figures')
    for (const entry of readdirSync(figures)) await unlockFile(join(figures, entry))
  } catch {
    // 忽略
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

describe('CSLab 3D 晶体视窗快照服务', () => {
  test('Given 合法 PNG DataURL When 提交快照 Then 写出文件并返回尺寸', async () => {
    const { submitStructureSnapshot } = await import('./cslab-structure-snapshot')
    const result = await submitStructureSnapshot({
      labId: lab.id,
      dataUrl: PNG_1X1,
      filenamePrefix: 'YAG 晶体',
    })

    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.relPath.startsWith('vault/figures/')).toBe(true)
    expect(result.path.endsWith('.png')).toBe(true)
  })

  test('Given 非 PNG DataURL When 提交快照 Then 拒绝写入', async () => {
    const { submitStructureSnapshot } = await import('./cslab-structure-snapshot')
    await expect(
      submitStructureSnapshot({
        labId: lab.id,
        dataUrl: 'data:image/jpeg;base64,AAAA',
      }),
    ).rejects.toThrow('PNG')
  })

  test('Given 渲染层失败原因 When 提交快照 Then 快速熔断且不写文件', async () => {
    const { submitStructureSnapshot } = await import('./cslab-structure-snapshot')
    const { resolveLabDir } = await import('./cslab-paths')
    const figures = join(resolveLabDir(lab.id), 'vault', 'figures')
    const before = readdirSync(figures).length

    await expect(
      submitStructureSnapshot({
        labId: lab.id,
        requestId: 'snap-test-error',
        error: '当前没有可见的 3D 晶体视窗',
      }),
    ).rejects.toThrow('当前没有可见的 3D 晶体视窗')

    expect(readdirSync(figures).length).toBe(before)
  })
})
