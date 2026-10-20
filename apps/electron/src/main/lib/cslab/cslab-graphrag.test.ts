/**
 * 跨文献索引与检索测试（不依赖真实 PDF）
 *
 * 通过预写 db/lit-text/*.json 缓存，验证切块、社群与检索排序。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-graphrag-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '文献智脑测试实验室' })

  const { getCsLabDatabase, upsertEntity } = await import('./cslab-db')
  const { resolveLabDir } = await import('./cslab-paths')
  const labDir = resolveLabDir(lab.id)
  const db = getCsLabDatabase(join(labDir, 'db', 'central_meta.sqlite'))
  const now = Date.now()

  const papers = [
    {
      uuid: 'lit-a',
      title: 'Interfacial Impedance in Solid-State Batteries',
      pages: [
        { page: 1, text: 'Solid-state batteries suffer from interfacial impedance. The SEI layer grows at the lithium metal interface and raises charge transfer resistance.' },
        { page: 2, text: 'Impedance spectroscopy reveals a semicircle at high frequency, attributed to the interfacial resistance.' },
      ],
    },
    {
      uuid: 'lit-b',
      title: 'Raman Spectroscopy of Cathode Materials',
      pages: [
        { page: 1, text: 'Raman spectroscopy identifies the symmetric stretching mode of the metal-oxygen octahedron in layered cathodes.' },
      ],
    },
  ]

  mkdirSync(join(labDir, 'db', 'lit-text'), { recursive: true })
  for (const paper of papers) {
    const uri = `cdut://${lab.id}/lit/${paper.uuid}`
    upsertEntity(db, {
      uri,
      labId: lab.id,
      layerType: 'lit',
      entityUuid: paper.uuid,
      title: paper.title,
      format: 'pdf',
      revision: 1,
      locked: true,
      createdAt: now,
      updatedAt: now,
    })
    writeFileSync(
      join(labDir, 'db', 'lit-text', `${paper.uuid}.json`),
      JSON.stringify({
        uri,
        updatedAt: now + 1000,
        pages: paper.pages,
        extractedAt: now,
      }),
      'utf-8',
    )
  }
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

describe('跨文献 GraphRAG', () => {
  test('构建索引：切块、社群与幂等复用', async () => {
    const { buildLabLiteratureIndex } = await import('./cslab-literature-index')
    const first = await buildLabLiteratureIndex(lab.id)
    expect(first.built).toBe(true)
    expect(first.index?.chunks.length).toBeGreaterThanOrEqual(3)
    expect(first.index?.communities.length).toBeGreaterThan(0)
    expect(first.index?.literatureCount).toBe(2)

    const second = await buildLabLiteratureIndex(lab.id)
    expect(second.built).toBe(false)
    expect(second.message).toBe('索引已是最新')
  })

  test('检索命中界面阻抗相关切块', async () => {
    const { searchLabLiterature } = await import('./cslab-graphrag-router')
    const result = await searchLabLiterature({
      labId: lab.id,
      query: 'interfacial impedance',
      topK: 3,
    })
    expect(result.ok).toBe(true)
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.title).toContain('Interfacial Impedance')
    expect(result.hits[0]?.excerpt.length).toBeGreaterThan(0)
    expect(result.hits[0]?.communityId.length).toBeGreaterThan(0)
  })

  test('文献范围限定生效', async () => {
    const { searchLabLiterature } = await import('./cslab-graphrag-router')
    const { listAssets } = await import('./cslab-iron-cage')
    const literature = listAssets(lab.id).filter((asset) => asset.layerType === 'lit')
    const target = literature.find((asset) => asset.title.includes('Raman'))
    expect(target).toBeTruthy()

    const result = await searchLabLiterature({
      labId: lab.id,
      query: 'impedance',
      literatureUri: target!.uri,
    })
    expect(result.ok).toBe(true)
    expect(result.hits.every((hit) => hit.literatureUri === target!.uri)).toBe(true)
  })

  test('空查询返回可读错误', async () => {
    const { searchLabLiterature } = await import('./cslab-graphrag-router')
    const result = await searchLabLiterature({ labId: lab.id, query: '   ' })
    expect(result.ok).toBe(false)
  })
})
