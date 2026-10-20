/**
 * CSLab 活体胶囊绑定 / 陈旧检测 / 一键更新 / 血缘测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab
let tableUri = ''
let capsuleId = ''

const CSV_V1 = ['Potential / V,Current / mA', '0.1,1.25', '0.2,1.30'].join('\n')
const CSV_V2 = ['Potential / V,Current / mA', '0.1,8.88', '0.2,8.88'].join('\n')

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-capsule-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  const { ingestFiles } = await import('./cslab-iron-cage')
  lab = createLab({ name: '胶囊测试实验室' })

  const source = join(rootDir, 'cv.csv')
  writeFileSync(source, CSV_V1, 'utf-8')
  const result = await ingestFiles(lab.id, [source])
  tableUri = result[0]?.tableUri ?? ''
  expect(tableUri).toBeTruthy()
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  try {
    const rawDir = join(resolveLabDir(lab.id), 'vault', 'raw')
    for (const entry of readdirSync(rawDir)) await unlockFile(join(rawDir, entry))
  } catch {
    // 忽略清理异常。
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 下 SQLite 句柄可能延迟释放，临时目录交给系统回收。
  }
})

describe('活体胶囊链路', () => {
  test('绑定单元格并读取真实值', async () => {
    const { bindCapsule, checkStaleness, listLabCapsules } = await import('./cslab-capsule')
    const capsule = await bindCapsule(lab.id, 'cdut://lab-test/doc/doc-1', {
      id: 'cap-test-1',
      label: 'Current',
      tableUri,
      column: 'y1',
      rowIndex: 0,
    })

    capsuleId = capsule.id
    expect(capsule.value).toBe('1.25')
    expect(capsule.unit).toBe('mA')
    expect(capsule.revisionAtBind).toBeGreaterThan(0)

    expect(checkStaleness(lab.id)).toEqual([])
    const listed = listLabCapsules(lab.id)
    expect(listed.find((item) => item.id === capsuleId)?.status).toBe('fresh')
  })

  test('同名数据表修订后胶囊进入 stale', async () => {
    const { ingestFiles } = await import('./cslab-iron-cage')
    const { checkStaleness } = await import('./cslab-capsule')

    const source = join(rootDir, 'cv.csv')
    writeFileSync(source, CSV_V2, 'utf-8')
    await ingestFiles(lab.id, [source])

    expect(checkStaleness(lab.id)).toContain(capsuleId)
  })

  test('一键更新读取新值并清除 stale', async () => {
    const { checkStaleness, updateCapsule } = await import('./cslab-capsule')
    const result = await updateCapsule(lab.id, capsuleId)
    expect(result.capsule.value).toBe('8.88')
    expect(result.changed).toBe(true)
    expect(checkStaleness(lab.id)).toEqual([])
  })

  test('血缘链包含 raw -> table -> capsule', async () => {
    const { getCapsuleLineage } = await import('./cslab-capsule')
    const lineage = await getCapsuleLineage(lab.id, capsuleId)
    expect(lineage).not.toBeNull()
    expect(lineage?.chain.map((node) => node.layerType)).toEqual(['raw', 'table', 'capsule'])
    expect(lineage?.currentValue).toBe('8.88')
  })

  test('超出 500 行预览的胶囊从 Parquet 读取真实值', async () => {
    const { ingestFiles } = await import('./cslab-iron-cage')
    const { bindCapsule, updateCapsule } = await import('./cslab-capsule')

    const buildCsv = (target: number): string => {
      const lines = ['Potential / V,Current / mA']
      for (let row = 1; row <= 600; row += 1) {
        lines.push(`${(row / 100).toFixed(2)},${row === 551 ? target : row}`)
      }
      return lines.join('\n')
    }

    const source = join(rootDir, 'big.csv')
    writeFileSync(source, buildCsv(551), 'utf-8')
    const ingested = await ingestFiles(lab.id, [source])
    const bigTableUri = ingested[0]?.tableUri ?? ''
    expect(bigTableUri).toBeTruthy()

    // 第 550 行（0 基）落在首屏 500 行预览之外，必须直读 Parquet。
    const capsule = await bindCapsule(lab.id, 'cdut://lab-test/doc/doc-2', {
      id: 'cap-big-row',
      tableUri: bigTableUri,
      column: 'y1',
      rowIndex: 550,
    })
    expect(capsule.value).toBe('551')

    writeFileSync(source, buildCsv(9999), 'utf-8')
    await ingestFiles(lab.id, [source])
    const updated = await updateCapsule(lab.id, 'cap-big-row')
    expect(updated.capsule.value).toBe('9999')
    expect(updated.changed).toBe(true)
  })
})
