/**
 * SKLGP 地质演示实验室集成测试
 *
 * 覆盖：基础 geo/图版资产、半成品 DOCX 论文、批注/胶囊、多文献、
 * 过程线图、推演画布、研究日志、幂等内容升级。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import type { CsLabDemoLabResult } from '@profer/shared'

const DEMO_DIR = fileURLToPath(
  new URL('../../../../resources/cslab/demo-geohazard', import.meta.url),
)

let rootDir = ''
let labId = ''
let demo: CsLabDemoLabResult

function walkNodes(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visit)
    return
  }
  const node = value as Record<string, unknown>
  visit(node)
  if (Array.isArray(node.content)) walkNodes(node.content, visit)
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-geo-demo-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createDemoLab } = await import('./cslab-demo')
  demo = await createDemoLab({ kind: 'sklgp-geohazard', demoDir: DEMO_DIR })
  labId = demo.lab.id
}, 180_000)

afterAll(async () => {
  const { resolveLabDir } = await import('./cslab-paths')
  const { unlockFile } = await import('./cslab-hash')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  if (labId) {
    const base = join(resolveLabDir(labId), 'vault')
    for (const directory of ['raw', 'figures', 'tables', 'lit', 'geo', 'manuscripts']) {
      try {
        for (const entry of readdirSync(join(base, directory))) {
          await unlockFile(join(base, directory, entry)).catch(() => undefined)
        }
      } catch {
        // 目录可能不存在
      }
    }
  }
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 下 SQLite 句柄可能延迟释放
  }
})

describe('SKLGP 地质演示实验室', () => {
  test('Given 内置演示数据 When 创建实验室 Then geo/表格/文献/图版齐备', () => {
    expect(demo.lab.demoKind).toBe('sklgp-geohazard')
    expect(demo.lab.name).toContain('SKLGP')
    expect(demo.plotIds).toHaveLength(3)

    const geo = demo.assets.filter((asset) => asset.layerType === 'geo')
    expect(geo.some((asset) => asset.title === 'wenjia_gully_dem.asc')).toBe(true)
    expect(demo.assets.some((asset) => asset.layerType === 'table')).toBe(true)
    expect(demo.assets.filter((asset) => asset.layerType === 'lit').length).toBeGreaterThanOrEqual(3)
    expect(
      demo.assets.some(
        (asset) => asset.layerType === 'fig' && asset.title === 'wenjia_gully_hydrographs.png',
      ),
    ).toBe(true)
  })

  test('Given 演示实验室 When 打开论文初稿 Then 正文非空、胶囊 2 个、批注 4 条', async () => {
    const { listManuscripts, getManuscript } = await import('./cslab-manuscript')
    const { SKLGP_THESIS_TITLE } = await import('./cslab-demo-geohazard-content')

    const summaries = listManuscripts(labId)
    const thesis = summaries.find((item) => item.title === SKLGP_THESIS_TITLE)
    expect(thesis).toBeDefined()
    expect(thesis!.hasDocx).toBe(true)

    const manuscript = await getManuscript(labId, thesis!.uri)
    expect(manuscript).not.toBeNull()
    // Sidecar 必须省略空 Canvas，渲染层才会走 legacy docJson 转换。
    expect(manuscript!.canvasData).toBeUndefined()
    expect(manuscript!.capsules).toHaveLength(2)
    expect(
      manuscript!.capsules.find((capsule) => capsule.id === 'cap-demo-peak-discharge')?.value,
    ).toBe('112.43')
    expect(
      manuscript!.capsules.find((capsule) => capsule.id === 'cap-demo-max-depth')?.value,
    ).toBe('2.95')

    let commentCount = 0
    walkNodes(manuscript!.docJson, (node) => {
      if (!Array.isArray(node.marks)) return
      for (const mark of node.marks as Array<Record<string, unknown>>) {
        if (mark.type === 'comment') commentCount += 1
      }
    })
    expect(commentCount).toBe(4)
  })

  test('Given 论文初稿 When 读取 linked docx Then 批注与胶囊部件存在', async () => {
    const { listManuscripts, readDocxBuffer } = await import('./cslab-manuscript')
    const { inspectDocx } = await import('./cslab-ooxml')
    const { SKLGP_THESIS_TITLE } = await import('./cslab-demo-geohazard-content')

    const thesis = listManuscripts(labId).find((item) => item.title === SKLGP_THESIS_TITLE)
    expect(thesis).toBeDefined()
    const docx = await readDocxBuffer(labId, thesis!.uri)
    expect(docx).not.toBeNull()
    expect(docx!.buffer.subarray(0, 2).toString('latin1')).toBe('PK')

    const inspect = await inspectDocx(new Uint8Array(docx!.buffer))
    expect(inspect.capsuleIds.sort()).toEqual([
      'cap-demo-max-depth',
      'cap-demo-peak-discharge',
    ])

    const zip = await JSZip.loadAsync(docx!.buffer)
    const comments = await zip.file('word/comments.xml')?.async('string')
    expect(comments).toBeTruthy()
    expect(comments!).toContain('<w:comments')
    expect((comments!.match(/<w:comment /g) ?? []).length).toBe(4)
  })

  test('Given 演示实验室 When 检查画布与日志 Then 7 节点画布与笔记资产存在', async () => {
    const { listCanvases, readCanvas } = await import('./cslab-canvas-sync')
    const { listVaultNotes } = await import('./cslab-vault-index')
    const { SKLGP_CANVAS_TITLE, SKLGP_NOTE_TITLE } = await import('./cslab-demo-geohazard-content')

    const canvases = await listCanvases(labId)
    const canvas = canvases.find((item) => item.title === SKLGP_CANVAS_TITLE)
    expect(canvas).toBeDefined()
    const document = await readCanvas(labId, canvas!.relPath)
    expect(document.document.nodes).toHaveLength(7)
    expect(document.document.edges).toHaveLength(6)

    const notes = listVaultNotes(labId)
    expect(notes.some((note) => note.title === SKLGP_NOTE_TITLE)).toBe(true)
  })

  test('Given 3 篇演示文献 When 解析与建索引 Then 结构与文献数达标', async () => {
    const { listAssets } = await import('./cslab-iron-cage')
    const { getLiteratureStructure } = await import('./cslab-literature-structure')
    const { buildLabLiteratureIndex } = await import('./cslab-literature-index')

    const literature = listAssets(labId).filter((asset) => asset.layerType === 'lit')
    expect(literature.length).toBeGreaterThanOrEqual(3)
    for (const asset of literature) {
      const structure = await getLiteratureStructure(labId, asset.uri, { ensure: true })
      expect(structure).not.toBeNull()
      expect(structure!.sections.length).toBeGreaterThan(0)
    }

    const built = await buildLabLiteratureIndex(labId, { force: true })
    expect(built.index).not.toBeNull()
    expect(built.index!.literatureCount).toBeGreaterThanOrEqual(3)
  })

  test('Given 已存在演示实验室 When 再次创建 Then 文稿/画布/笔记不重复', async () => {
    const { listManuscripts } = await import('./cslab-manuscript')
    const { listCanvases } = await import('./cslab-canvas-sync')
    const { listVaultNotes } = await import('./cslab-vault-index')
    const { createDemoLab } = await import('./cslab-demo')

    const before = {
      manuscripts: listManuscripts(labId).length,
      canvases: (await listCanvases(labId)).length,
      notes: listVaultNotes(labId).length,
    }
    await createDemoLab({ kind: 'sklgp-geohazard', demoDir: DEMO_DIR })
    expect(listManuscripts(labId).length).toBe(before.manuscripts)
    expect((await listCanvases(labId)).length).toBe(before.canvases)
    expect(listVaultNotes(labId).length).toBe(before.notes)
  })

  test('Given 用户改过文稿标题 When 清版本后补齐内容 Then 不覆盖也不新建副本', async () => {
    const { getManuscript, listManuscripts, saveManuscript } = await import('./cslab-manuscript')
    const { getCsLabDatabase } = await import('./cslab-db')
    const { resolveLabDir } = await import('./cslab-paths')
    const { ensureSkLgpDemoContent } = await import('./cslab-demo-geohazard')
    const { SKLGP_THESIS_TITLE } = await import('./cslab-demo-geohazard-content')

    const thesis = listManuscripts(labId).find((item) => item.title === SKLGP_THESIS_TITLE)!
    const manuscript = (await getManuscript(labId, thesis.uri))!
    const renamed = '用户改过的演示论文标题'
    await saveManuscript({
      labId,
      uri: thesis.uri,
      title: renamed,
      docJson: manuscript.docJson,
      capsules: manuscript.capsules,
    })

    const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
    db.raw.prepare('DELETE FROM lab_state WHERE key = ?').run('sklgp_demo_content_version')

    const beforeCount = listManuscripts(labId).length
    await ensureSkLgpDemoContent(demo.lab, { demoDir: DEMO_DIR })
    const after = listManuscripts(labId)
    expect(after.length).toBe(beforeCount)
    expect(after.find((item) => item.uri === thesis.uri)?.title).toBe(renamed)
  })
})
