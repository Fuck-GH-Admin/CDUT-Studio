/**
 * CSLab JSON Canvas / DAG / Vault 索引测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabCanvasDocument, CsLabDagNodeInput, CsLabLab } from '@profer/shared'
import {
  applyDagEvaluation,
  canvasToDagGraph,
  evaluateDag,
  mergeCanvasScienceMeta,
  parseCanvasDocument,
  serializeCanvasDocument,
  topologicalOrder,
  wouldCreateCycle,
} from '@profer/shared'
import { __createAtomicWriteDeps, CsLabFileBusyError, writeTextAtomic } from './cslab-atomic'

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-canvas-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: 'Canvas 测试实验室' })
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { closeAllCsLabVaultCaches } = await import('./cslab-vault-cache')
  const { closeAllVaultWatchers } = await import('./cslab-canvas-sync')
  await closeAllVaultWatchers()
  closeAllCsLabDatabases()
  closeAllCsLabVaultCaches()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

function dagNode(
  id: string,
  state: CsLabDagNodeInput['state'],
  operator: CsLabDagNodeInput['operator'] = 'AND',
): CsLabDagNodeInput {
  return { id, state, operator }
}

describe('JSON Canvas 无损读写', () => {
  test('解析与序列化保留未知字段与 cdut_science', () => {
    const source = JSON.stringify({
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 10,
          y: 20,
          width: 300,
          height: 150,
          text: '# 假说',
          customField: { keep: true },
          cdut_science: { node_kind: 'hypothesis', verification_status: 'pending' },
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNode: 'n1',
          toNode: 'n1',
          customEdge: 'keep',
          cdut_science: { dependency_type: 'strict_conjunctive' },
        },
      ],
      extraTopLevel: ['keep'],
    })

    const document = parseCanvasDocument(source)
    expect(document.extraTopLevel).toEqual(['keep'])
    expect((document.nodes[0] as Record<string, unknown>).customField).toEqual({ keep: true })
    expect(document.edges[0]?.customEdge).toBe('keep')

    const roundTrip = parseCanvasDocument(serializeCanvasDocument(document))
    expect(roundTrip.nodes[0]?.cdut_science?.node_kind).toBe('hypothesis')
    expect((roundTrip as Record<string, unknown>).extraTopLevel).toEqual(['keep'])
  })

  test('画布 → DAG 仅包含带推演标记的节点', () => {
    const document: CsLabCanvasDocument = {
      nodes: [
        {
          id: 'a',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          cdut_science: { node_kind: 'hypothesis', logical_operator: 'OR' },
        },
        { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 100 },
        { id: 'c', type: 'group', x: 0, y: 0, width: 10, height: 10, cdut_science: { node_kind: 'note' } },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    }
    const graph = canvasToDagGraph(document)
    expect(graph.nodes.map((node) => node.id)).toEqual(['a'])
    expect(graph.nodes[0]?.operator).toBe('OR')
    expect(graph.edges).toHaveLength(0)
  })
})

describe('DAG 拓扑推演', () => {
  test('AND 门限：任一上游死路即折叠', () => {
    const nodes = [dagNode('root', 'dead_end'), dagNode('a', 'verified', 'AND'), dagNode('b', 'pending', 'AND')]
    const edges = [
      { id: 'e1', fromNode: 'root', toNode: 'a' },
      { id: 'e2', fromNode: 'a', toNode: 'b' },
    ]
    const evaluation = evaluateDag(nodes, edges)
    expect(evaluation.prunedIds.sort()).toEqual(['a', 'b'])
    expect(evaluation.states.a).toBe('pruned')
    expect(evaluation.states.b).toBe('pruned')
  })

  test('OR 门限：仍有存活父节点时不折叠', () => {
    const nodes = [dagNode('dead', 'dead_end'), dagNode('alive', 'verified'), dagNode('or', 'pending', 'OR')]
    const edges = [
      { id: 'e1', fromNode: 'dead', toNode: 'or' },
      { id: 'e2', fromNode: 'alive', toNode: 'or' },
    ]
    const evaluation = evaluateDag(nodes, edges)
    expect(evaluation.states.or).toBe('pending')
    expect(evaluation.prunedIds).toEqual([])
  })

  test('上游恢复后 pruned 自动复活', () => {
    const edges = [{ id: 'e1', fromNode: 'root', toNode: 'child' }]
    const dead = evaluateDag([dagNode('root', 'dead_end'), dagNode('child', 'pending')], edges)
    expect(dead.states.child).toBe('pruned')

    const recovered = evaluateDag([dagNode('root', 'verified'), dagNode('child', 'pending')], edges)
    expect(recovered.states.child).toBe('pending')
  })

  test('环路检测：自环与双节点互指', () => {
    const selfLoop = topologicalOrder([dagNode('a', 'pending')], [{ id: 'e', fromNode: 'a', toNode: 'a' }])
    expect(selfLoop.cycles).toHaveLength(1)

    const mutual = topologicalOrder(
      [dagNode('a', 'pending'), dagNode('b', 'pending')],
      [
        { id: 'e1', fromNode: 'a', toNode: 'b' },
        { id: 'e2', fromNode: 'b', toNode: 'a' },
      ],
    )
    expect(mutual.cycles[0]?.sort()).toEqual(['a', 'b'])
  })

  test('存在环时不执行剪枝', () => {
    const nodes = [dagNode('a', 'dead_end'), dagNode('b', 'pending')]
    const edges = [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'a' },
    ]
    const evaluation = evaluateDag(nodes, edges)
    expect(evaluation.prunedIds).toEqual([])
    expect(evaluation.cycles).toHaveLength(1)
  })

  test('新增边前防环', () => {
    const edges = [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'c' },
    ]
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true)
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false)
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true)
  })

  test('pruned 不污染人工事实，上游恢复后回到 verified', () => {
    const document: CsLabCanvasDocument = {
      nodes: [
        {
          id: 'root',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          cdut_science: { node_kind: 'hypothesis', verification_status: 'dead_end' },
        },
        {
          id: 'child',
          type: 'text',
          x: 200,
          y: 0,
          width: 100,
          height: 100,
          cdut_science: { node_kind: 'inference', verification_status: 'verified' },
        },
      ],
      edges: [{ id: 'e', fromNode: 'root', toNode: 'child' }],
    }

    const firstGraph = canvasToDagGraph(document)
    const firstEval = evaluateDag(firstGraph.nodes, firstGraph.edges)
    expect(firstEval.states.child).toBe('pruned')
    const applied = applyDagEvaluation(document, firstEval)
    expect(applied.nodes[1]?.cdut_science?.verification_status).toBe('pruned')
    expect(applied.nodes[1]?.cdut_science?.manual_status).toBe('verified')

    applied.nodes[0]!.cdut_science = {
      ...(applied.nodes[0]!.cdut_science ?? {}),
      verification_status: 'verified',
      manual_status: 'verified',
    }
    const secondGraph = canvasToDagGraph(applied)
    expect(secondGraph.nodes.find((node) => node.id === 'child')?.state).toBe('verified')
    const secondEval = evaluateDag(secondGraph.nodes, secondGraph.edges)
    expect(secondEval.states.child).toBe('verified')
  })

  test('剪枝节点带 gpu_task_id 时进入待取消列表', () => {
    const nodes: CsLabDagNodeInput[] = [
      { id: 'root', state: 'dead_end', operator: 'AND' },
      { id: 'sim', state: 'pending', operator: 'AND', gpuTaskId: 'job-1' },
    ]
    const evaluation = evaluateDag(nodes, [{ id: 'e', fromNode: 'root', toNode: 'sim' }])
    expect(evaluation.cancelledJobIds).toEqual(['job-1'])

    const document: CsLabCanvasDocument = {
      nodes: [
        { id: 'root', type: 'text', x: 0, y: 0, width: 100, height: 100, cdut_science: { node_kind: 'hypothesis', verification_status: 'dead_end' } },
        { id: 'sim', type: 'text', x: 200, y: 0, width: 100, height: 100, cdut_science: { node_kind: 'experiment', gpu_task_id: 'job-1' } },
      ],
      edges: [{ id: 'e', fromNode: 'root', toNode: 'sim' }],
    }
    const applied = applyDagEvaluation(document, evaluation, evaluation.cancelledJobIds)
    expect(applied.nodes[1]?.cdut_science?.verification_status).toBe('pruned')
    expect(applied.nodes[1]?.cdut_science?.job_cancel_requested).toBe(true)
  })
})

describe('Windows 原子写降级', () => {
  test('rename 连续 EPERM 后重试成功', async () => {
    const target = join(rootDir, 'atomic-ok.txt')
    let failures = 0
    const deps = __createAtomicWriteDeps({
      rename: async (oldPath, newPath) => {
        if (failures < 3) {
          failures += 1
          throw Object.assign(new Error('busy'), { code: 'EPERM' })
        }
        await fs.rename(oldPath, newPath)
      },
      delay: async () => undefined,
    })
    const result = await writeTextAtomic(target, 'hello', {}, deps)
    expect(result.durability).toBe('atomic')
    expect(await fs.readFile(target, 'utf-8')).toBe('hello')
  })

  test('rename 永久失败时原地写入', async () => {
    const target = join(rootDir, 'atomic-inplace.txt')
    const deps = __createAtomicWriteDeps({
      rename: async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      },
      delay: async () => undefined,
    })
    const result = await writeTextAtomic(target, 'fallback', { allowInPlaceFallback: true }, deps)
    expect(result.durability).toBe('in-place')
    expect(await fs.readFile(target, 'utf-8')).toBe('fallback')
  })

  test('rename 与原地写均失败时抛出可识别错误', async () => {
    const target = join(rootDir, 'atomic-busy.txt')
    const deps = __createAtomicWriteDeps({
      rename: async () => {
        throw Object.assign(new Error('busy'), { code: 'EPERM' })
      },
      writeFile: async (path, data) => {
        if (path === target) throw Object.assign(new Error('locked'), { code: 'EPERM' })
        await fs.writeFile(path, data)
      },
      delay: async () => undefined,
    })
    await expect(
      writeTextAtomic(target, 'blocked', { allowInPlaceFallback: true }, deps),
    ).rejects.toBeInstanceOf(CsLabFileBusyError)
  })
})

describe('Canvas 同步引擎', () => {
  test('创建、读取与写回保留 Obsidian 未知字段', async () => {
    const { createCanvas, readCanvas, writeCanvas } = await import('./cslab-canvas-sync')
    const created = await createCanvas(lab.id, '材料推演')
    expect(created.relPath).toEndWith('.canvas')

    const document: CsLabCanvasDocument = {
      ...created.document,
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 20,
          y: 20,
          width: 260,
          height: 150,
          text: '# 基线假说',
          obsidianExtra: 'keep-me',
          cdut_science: { node_kind: 'hypothesis', verification_status: 'pending', logical_operator: 'AND' },
        },
      ],
      edges: [],
    }
    const written = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document,
      expectedMtimeMs: created.mtimeMs,
    })
    expect(written.durability).toBe('atomic')
    expect(written.document.nodes[0]?.cdut_science?.verification_status).toBe('pending')
    expect((written.document.nodes[0] as Record<string, unknown>).obsidianExtra).toBe('keep-me')

    const loaded = await readCanvas(lab.id, created.relPath)
    expect((loaded.document.nodes[0] as Record<string, unknown>).obsidianExtra).toBe('keep-me')
  })

  test('外部新增节点时保留 Obsidian 结构，仅合并元数据', async () => {
    const { createCanvas, writeCanvas } = await import('./cslab-canvas-sync')
    const { resolveLabRelativePath } = await import('./cslab-paths')

    const created = await createCanvas(lab.id, '冲突画布')
    const baseDocument: CsLabCanvasDocument = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          text: '# 原始',
          cdut_science: { node_kind: 'hypothesis', verification_status: 'pending' },
        },
      ],
      edges: [],
    }
    const written = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document: baseDocument,
      expectedMtimeMs: created.mtimeMs,
    })

    await Bun.sleep(15)
    const absolute = resolveLabRelativePath(lab.id, created.relPath)
    const disk = parseCanvasDocument(await fs.readFile(absolute, 'utf-8'))
    disk.nodes[0]!.text = '# 被 Obsidian 改写'
    disk.nodes.push({ id: 'external', type: 'text', x: 300, y: 0, width: 120, height: 80, text: '外部节点' })
    await fs.writeFile(absolute, serializeCanvasDocument(disk), 'utf-8')

    const incoming = JSON.parse(JSON.stringify(baseDocument)) as CsLabCanvasDocument
    incoming.nodes[0]!.cdut_science = { node_kind: 'hypothesis', verification_status: 'verified' }
    const result = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document: incoming,
      expectedMtimeMs: written.mtimeMs,
    })

    expect(result.durability).toBe('atomic')
    expect(result.document.nodes.some((node) => node.id === 'external')).toBe(true)
    expect(result.document.nodes[0]?.text).toBe('# 被 Obsidian 改写')
    expect(result.document.nodes[0]?.cdut_science?.verification_status).toBe('verified')
  })

  test('CDUT 独有节点遇到 Obsidian 重构时写冲突副本', async () => {
    const { createCanvas, writeCanvas } = await import('./cslab-canvas-sync')
    const { resolveLabRelativePath } = await import('./cslab-paths')

    const created = await createCanvas(lab.id, '分叉画布')
    const document: CsLabCanvasDocument = {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 120, text: '# 原始' },
      ],
      edges: [],
    }
    const written = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document,
      expectedMtimeMs: created.mtimeMs,
    })

    await Bun.sleep(15)
    const absolute = resolveLabRelativePath(lab.id, created.relPath)
    // Obsidian 侧删除了 n1，CDUT 侧仍在编辑 n1 -> 无法安全合并，必须分叉。
    await fs.writeFile(
      absolute,
      serializeCanvasDocument({ nodes: [], edges: [] }),
      'utf-8',
    )

    const result = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document,
      expectedMtimeMs: written.mtimeMs,
    })
    expect(result.durability).toBe('conflict-only')
    expect(result.conflictRelPath).toBeTruthy()
    expect(existsSync(resolveLabRelativePath(lab.id, result.conflictRelPath!))).toBe(true)
  })

  test('外部仅改文本时只合并 cdut_science', async () => {
    const { createCanvas, writeCanvas } = await import('./cslab-canvas-sync')
    const { resolveLabRelativePath } = await import('./cslab-paths')

    const created = await createCanvas(lab.id, '合并不冲突')
    const document: CsLabCanvasDocument = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          text: '# 原始',
          cdut_science: { node_kind: 'hypothesis', verification_status: 'pending' },
        },
      ],
      edges: [],
    }
    const written = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document,
      expectedMtimeMs: created.mtimeMs,
    })

    await Bun.sleep(15)
    const absolute = resolveLabRelativePath(lab.id, created.relPath)
    const disk = parseCanvasDocument(await fs.readFile(absolute, 'utf-8'))
    disk.nodes[0]!.text = '# Obsidian 文本'
    await fs.writeFile(absolute, serializeCanvasDocument(disk), 'utf-8')

    const incoming = JSON.parse(JSON.stringify(document)) as CsLabCanvasDocument
    incoming.nodes[0]!.cdut_science = { node_kind: 'hypothesis', verification_status: 'verified' }
    const result = await writeCanvas({
      labId: lab.id,
      relPath: created.relPath,
      document: incoming,
      expectedMtimeMs: written.mtimeMs,
    })

    expect(result.durability).toBe('atomic')
    expect(result.document.nodes[0]?.text).toBe('# Obsidian 文本')
    expect(result.document.nodes[0]?.cdut_science?.verification_status).toBe('verified')
  })

  test('mergeCanvasScienceMeta 标记 orphan 节点', () => {
    const disk: CsLabCanvasDocument = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'disk' }],
      edges: [],
    }
    const incoming: CsLabCanvasDocument = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'incoming', cdut_science: { node_kind: 'note' } },
        { id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'new' },
      ],
      edges: [],
    }
    const merged = mergeCanvasScienceMeta(disk, incoming)
    expect(merged.document.nodes[0]?.text).toBe('disk')
    expect(merged.document.nodes[0]?.cdut_science?.node_kind).toBe('note')
    expect(merged.orphanNodeIds).toEqual(['b'])
  })
})

describe('Vault 索引缓存', () => {
  test('增量复用、双链、坏缓存自愈与删除清理', async () => {
    const { resolveLabDir } = await import('./cslab-paths')
    const { rebuildVaultIndex, listVaultNotes } = await import('./cslab-vault-index')
    const { getCsLabVaultCache } = await import('./cslab-vault-cache')
    const { listAssets } = await import('./cslab-iron-cage')

    const notesDir = join(resolveLabDir(lab.id), 'vault', 'notes')
    writeFileSync(
      join(notesDir, 'alpha.md'),
      ['---', 'title: Alpha', 'tags: [电化学, 界面]', '---', '# Alpha', '参见 [[Beta#方法]]', ''].join('\n'),
      'utf-8',
    )
    writeFileSync(
      join(notesDir, 'beta.md'),
      ['# Beta', '回到 [[Alpha]]', '块引用 ^block-1', ''].join('\n'),
      'utf-8',
    )

    const first = await rebuildVaultIndex(lab.id)
    expect(first.status.noteCount).toBe(2)
    expect(first.parsed).toBeGreaterThanOrEqual(2)

    const notes = listVaultNotes(lab.id)
    const alpha = notes.find((note) => note.title === 'Alpha')
    const beta = notes.find((note) => note.title === 'Beta')
    expect(alpha?.tags).toContain('电化学')
    expect(alpha?.backlinkCount).toBe(1)
    expect(beta?.backlinkCount).toBe(1)

    const second = await rebuildVaultIndex(lab.id)
    expect(second.parsed).toBe(0)
    expect(second.reused).toBeGreaterThanOrEqual(2)

    const cache = getCsLabVaultCache(lab.id)
    cache.raw
      .prepare('UPDATE vault_index SET payload = ? WHERE rel_path = ?')
      .run('{bad-json', 'vault/notes/alpha.md')
    const repaired = await rebuildVaultIndex(lab.id)
    expect(repaired.parsed).toBeGreaterThanOrEqual(1)
    expect(listVaultNotes(lab.id).some((note) => note.title === 'Alpha')).toBe(true)

    await fs.rm(join(notesDir, 'beta.md'))
    const removed = await rebuildVaultIndex(lab.id)
    expect(removed.removed).toBe(1)
    expect(listAssets(lab.id).some((asset) => asset.relPath === 'vault/notes/beta.md')).toBe(false)
  })
})
