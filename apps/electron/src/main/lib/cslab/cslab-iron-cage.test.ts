/**
 * CSLab 数据铁笼摄取测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab

const CSV_V1 = ['# Instrument: CHI760E', 'Potential / V,Current / mA', '0.1,1.25', '0.2,1.30', '0.3,1.35'].join('\n')
const CSV_V2 = ['# Instrument: CHI760E', 'Potential / V,Current / mA', '0.1,9.99', '0.2,9.99', '0.3,9.99'].join('\n')

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-cage-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '数据铁笼测试实验室', description: '自动化测试' })
})

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  try {
    const rawDir = join(resolveLabDir(lab.id), 'vault', 'raw')
    for (const entry of readdirSync(rawDir)) await unlockFile(join(rawDir, entry))
  } catch {
    // 目录可能不存在。
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 下 SQLite 句柄可能延迟释放，临时目录交给系统回收。
  }
})

describe('数据铁笼摄取', () => {
  test('CSV 摄取：SHA-256、只读锁、Parquet 预览与实体落库', async () => {
    const { ingestFiles, getAssetTable, getTableCell, listAssets } = await import('./cslab-iron-cage')
    const { isFileReadOnly } = await import('./cslab-hash')
    const { resolveAssetPath } = await import('./cslab-iron-cage')

    const source = join(rootDir, 'CV_scan.csv')
    writeFileSync(source, CSV_V1, 'utf-8')

    const results = await ingestFiles(lab.id, [source])
    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result?.status).toBe('ok')
    expect(result?.asset.sha256).toHaveLength(64)
    expect(result?.tableUri).toBeTruthy()

    const rawPath = resolveAssetPath(lab.id, result!.asset.uri)
    expect(rawPath).toBeTruthy()
    expect(await isFileReadOnly(rawPath!)).toBe(true)

    const payload = await getAssetTable(lab.id, result!.tableUri!)
    expect(payload?.rows).toHaveLength(3)
    expect(payload?.totalRows).toBe(3)
    expect(payload?.locked).toBe(true)
    expect(payload?.revision).toBe(1)
    expect(payload?.columns[0]?.label).toBe('Potential')

    const cell = await getTableCell(lab.id, result!.tableUri!, 'y1', 2)
    expect(cell).toBe(1.35)

    const assets = listAssets(lab.id)
    expect(assets.some((asset) => asset.layerType === 'raw')).toBe(true)
    expect(assets.some((asset) => asset.layerType === 'table')).toBe(true)
  })

  test('相同 SHA-256 幂等复用，不产生重复资产', async () => {
    const { ingestFiles, listAssets } = await import('./cslab-iron-cage')
    const source = join(rootDir, 'CV_scan.csv')
    const before = listAssets(lab.id).length
    const results = await ingestFiles(lab.id, [source])
    expect(results[0]?.status).toBe('ok')
    expect(listAssets(lab.id).length).toBe(before)
  })

  test('同名数据表修正后复用 URI 并推进 revision', async () => {
    const { ingestFiles, getAssetTable } = await import('./cslab-iron-cage')
    const source = join(rootDir, 'CV_scan.csv')
    writeFileSync(source, CSV_V2, 'utf-8')

    const first = await ingestFiles(lab.id, [source])
    const second = await ingestFiles(lab.id, [source])
    const tableUri = first[0]?.tableUri
    expect(tableUri).toBeTruthy()
    expect(second[0]?.tableUri).toBe(tableUri)

    const payload = await getAssetTable(lab.id, tableUri!)
    expect(payload?.revision).toBeGreaterThan(1)
    expect(payload?.rows[0]?.[1]).toBe(9.99)
  })

  test('不支持格式只登记原始资产并明确降级', async () => {
    const { ingestFiles } = await import('./cslab-iron-cage')
    const source = join(rootDir, 'battery.mpr')
    writeFileSync(source, Buffer.from('EC-Lab ASCII placeholder'))

    const results = await ingestFiles(lab.id, [source])
    expect(results[0]?.status).toBe('unsupported')
    expect(results[0]?.tableUri).toBeUndefined()
    expect(results[0]?.asset.unsupported).toContain('mpr')
  })
})
