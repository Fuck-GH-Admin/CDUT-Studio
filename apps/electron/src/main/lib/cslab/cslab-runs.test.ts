/**
 * CSLab 实验规程与批次测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-runs-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '实验批次测试实验室' })
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { closeAllCsLabVaultCaches } = await import('./cslab-vault-cache')
  try {
    const rawDir = join(resolveLabDir(lab.id), 'vault', 'raw')
    for (const entry of readdirSync(rawDir)) await unlockFile(join(rawDir, entry))
  } catch {
    // 无原始文件时忽略。
  }
  closeAllCsLabDatabases()
  closeAllCsLabVaultCaches()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放，交给系统回收。
  }
})

describe('实验规程', () => {
  test('创建规程会生成 proto 实体与 Markdown 镜像', async () => {
    const { createProtocol, listProtocols } = await import('./cslab-runs')
    const { resolveLabDir } = await import('./cslab-paths')

    const protocol = await createProtocol({
      labId: lab.id,
      title: '恒流充放电 0.5C',
      method: 'LAND 测试柜',
      steps: [{ id: 'step-1', title: '装配电池', detail: '手套箱内完成' }],
      parameters: [{ key: 'current', label: '电流', unit: 'mA', defaultValue: '0.5' }],
    })

    expect(protocol.uri).toContain('/proto/')
    expect(listProtocols(lab.id).some((item) => item.uri === protocol.uri)).toBe(true)

    const uuid = protocol.uri.split('/').pop()!
    const mirror = join(resolveLabDir(lab.id), 'vault', 'notes', 'protocols', `${uuid}.md`)
    expect(existsSync(mirror)).toBe(true)
    const text = readFileSync(mirror, 'utf-8')
    expect(text).toContain('kind: protocol')
    expect(text).toContain('装配电池')
  })

  test('更新规程递增版本且不影响历史批次快照', async () => {
    const { createProtocol, createRun, listRuns, updateProtocol } = await import('./cslab-runs')
    const protocol = await createProtocol({ labId: lab.id, title: '循环寿命测试' })
    const run = await createRun({
      labId: lab.id,
      protocolUri: protocol.uri,
      title: '首圈',
    })

    const updated = await updateProtocol({
      labId: lab.id,
      uri: protocol.uri,
      title: '循环寿命测试 v2',
      method: '新方法',
    })
    expect(updated.version).toBe(2)

    const stored = listRuns(lab.id).find((item) => item.uri === run.uri)
    expect(stored?.protocolVersion).toBe(1)
    expect(stored?.protocolTitle).toBe('循环寿命测试')
  })
})

describe('实验批次', () => {
  test('批次号单调递增且事务内不重复', async () => {
    const { createRun, listRuns } = await import('./cslab-runs')

    const [first, second] = await Promise.all([
      createRun({ labId: lab.id, title: '批次 A' }),
      createRun({ labId: lab.id, title: '批次 B' }),
    ])

    expect(first.batchNo).toMatch(/^r-\d{8}-\d{2}$/)
    expect(second.batchNo).toMatch(/^r-\d{8}-\d{2}$/)
    expect(first.batchNo).not.toBe(second.batchNo)
    expect(listRuns(lab.id).filter((run) => run.batchNo === first.batchNo)).toHaveLength(1)
  })

  test('结束批次记录成败现象并写入 Markdown 镜像', async () => {
    const { createRun, updateRun } = await import('./cslab-runs')
    const { resolveLabDir } = await import('./cslab-paths')

    const run = await createRun({ labId: lab.id, title: '结束批次测试' })
    const updated = await updateRun({
      labId: lab.id,
      uri: run.uri,
      status: 'succeeded',
      outcome: '首圈库伦效率 91.2%',
      observations: '第 3 圈出现轻微极化增大',
    })

    expect(updated.status).toBe('succeeded')
    expect(updated.endedAt).toBeGreaterThan(0)
    expect(updated.outcome).toContain('91.2')

    const mirror = join(resolveLabDir(lab.id), 'vault', 'notes', 'runs', `${run.batchNo}.md`)
    expect(existsSync(mirror)).toBe(true)
    const text = readFileSync(mirror, 'utf-8')
    expect(text).toContain('status: succeeded')
    expect(text).toContain('第 3 圈')
  })

  test('关联数据表写入 links 与血缘，并支持解除', async () => {
    const { createRun, linkRunAsset, unlinkRunAsset } = await import('./cslab-runs')
    const { ingestFiles } = await import('./cslab-iron-cage')

    const source = join(rootDir, 'run-link.csv')
    writeFileSync(source, 'Potential / V,Current / mA\n0.1,1.2\n0.2,1.3\n', 'utf-8')
    const ingested = await ingestFiles(lab.id, [source])
    const tableUri = ingested[0]?.tableUri
    expect(tableUri).toBeTruthy()

    const run = await createRun({ labId: lab.id, title: '关联测试' })
    const linked = await linkRunAsset({
      labId: lab.id,
      runUri: run.uri,
      assetUri: tableUri!,
      relation: 'consumes',
    })
    expect(linked.linkedAssets.some((link) => link.uri === tableUri)).toBe(true)

    const unlinked = await unlinkRunAsset({
      labId: lab.id,
      runUri: run.uri,
      assetUri: tableUri!,
      relation: 'consumes',
    })
    expect(unlinked.linkedAssets.some((link) => link.uri === tableUri)).toBe(false)
  })
})
