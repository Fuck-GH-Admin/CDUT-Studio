/**
 * CSLab 用户 Python 工具注册表测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabCustomToolScan, CsLabLab } from '@profer/shared'
import { writeJsonFileAtomic } from '../safe-file'

let rootDir = ''
let lab: CsLabLab

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-tools-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '科研工具测试实验室' })
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  const { closeAllLabToolWatchers } = await import('./cslab-tool-registry')
  await closeAllLabToolWatchers()
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

describe('Python 签名解析', () => {
  test('解析位置参数、默认值与变长参数', async () => {
    const { parsePythonToolSignature } = await import('./cslab-tool-registry')
    const params = parsePythonToolSignature('a: int, b: str = "x", *args, c: list[int] = None')
    expect(params.map((param) => param.name)).toEqual(['a', 'b', 'args', 'c'])
    expect(params[0]?.required).toBe(true)
    expect(params[1]?.required).toBe(false)
    expect(params[2]?.variadic).toBe(true)
    expect(params[3]?.annotation).toBe('list[int]')

    const keywordOnly = parsePythonToolSignature('a: int, *, b: str')
    expect(keywordOnly.map((param) => param.name)).toEqual(['a', 'b'])
    expect(keywordOnly.some((param) => param.variadic)).toBe(false)
  })

  test('类型注解映射到 JSON 类型', async () => {
    const { annotationToJsonType } = await import('./cslab-tool-registry')
    expect(annotationToJsonType('str').jsonType).toBe('string')
    expect(annotationToJsonType('int').jsonType).toBe('integer')
    expect(annotationToJsonType('float').jsonType).toBe('number')
    expect(annotationToJsonType('bool').jsonType).toBe('boolean')
    expect(annotationToJsonType('list[str]').jsonType).toBe('array')
    expect(annotationToJsonType('dict[str, int]').jsonType).toBe('object')
    expect(annotationToJsonType('Optional[int]')).toEqual({ jsonType: 'integer', optional: true })
    expect(annotationToJsonType('int | None')).toEqual({ jsonType: 'integer', optional: true })
    expect(annotationToJsonType(undefined).jsonType).toBe('any')
  })

  test('启发式解析函数、docstring 与不支持项', async () => {
    const { parseHeuristicModule } = await import('./cslab-tool-registry')
    const source = [
      '"""电池工具集。"""',
      '',
      'def capacity_estimate(current: float, hours: float = 1.0) -> float:',
      '    """按恒流估算容量。"""',
      '    return current * hours',
      '',
      'async def background(x: int):',
      '    """异步任务。"""',
      '    return x',
      '',
      'def variadic(*args):',
      '    return args',
      '',
      'def _private():',
      '    return None',
    ].join('\n')

    const tools = parseHeuristicModule('runtime/tools/battery.py', source)
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('capacity_estimate')
    expect(names).toContain('background')
    expect(names).toContain('variadic')
    expect(names).not.toContain('_private')

    const capacity = tools.find((tool) => tool.name === 'capacity_estimate')!
    expect(capacity.description).toContain('容量')
    expect(capacity.params.map((param) => param.name)).toEqual(['current', 'hours'])
    expect(capacity.params[0]?.required).toBe(true)
    expect(capacity.params[1]?.required).toBe(false)
    expect(capacity.returns).toBe('float')

    expect(tools.find((tool) => tool.name === 'background')?.unsupportedReason).toContain('async')
    expect(tools.find((tool) => tool.name === 'variadic')?.unsupportedReason).toContain('变长')
  })
})

describe('工具清单与执行守卫', () => {
  test('清单可同步读取，未知参数与缺失必填被拒绝', async () => {
    const { resolveLabDir } = await import('./cslab-paths')
    const { readLabToolManifestSync, runLabTool } = await import('./cslab-tool-registry')

    const manifest: CsLabCustomToolScan & { version: number; fingerprint: string } = {
      version: 1,
      labId: lab.id,
      tools: [
        {
          name: 'calculate',
          moduleRelPath: 'runtime/tools/demo.py',
          description: '计算演示',
          params: [{ name: 'value', jsonType: 'number', required: true }],
          source: 'heuristic',
        },
      ],
      scannedAt: Date.now(),
      engine: 'heuristic',
      message: '测试清单',
      fingerprint: 'test',
    }
    writeJsonFileAtomic(
      join(resolveLabDir(lab.id), 'runtime', 'tools', '.cslab-tools.json'),
      manifest,
    )

    expect(readLabToolManifestSync(lab.id)?.tools[0]?.name).toBe('calculate')

    const unknown = await runLabTool({
      labId: lab.id,
      name: 'calculate',
      args: { value: 1, extra: 2 },
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('未知参数')

    const missing = await runLabTool({ labId: lab.id, name: 'calculate', args: {} })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('缺少必填参数')

    // 失败调用同样必须留痕：审计为追加式 JSONL，字段可直接解析。
    const auditPath = join(resolveLabDir(lab.id), 'runtime', 'logs', 'tool-executions.jsonl')
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>
    expect(last).toMatchObject({
      labId: lab.id,
      function: 'calculate',
      source: 'ipc',
      ok: false,
    })
    expect(String(last.error)).toContain('缺少必填参数')
    expect(typeof last.elapsedMs).toBe('number')
  })

  test('未绑定会话不注入任何 CSLab 工具', async () => {
    const { buildPiCsLabTools } = await import('../adapters/pi-cslab-tools')
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const tools = buildPiCsLabTools(
      fakeSdk as unknown as Parameters<typeof buildPiCsLabTools>[0],
      { sessionId: 'session-unbound' },
      { getSessionMeta: () => undefined },
    )
    expect(tools).toEqual([])
  })

  test('绑定会话后按函数装配工具，且不污染其他会话', async () => {
    const { buildPiCsLabTools } = await import('../adapters/pi-cslab-tools')
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const scan: CsLabCustomToolScan = {
      labId: lab.id,
      tools: [
        {
          name: 'calculate',
          moduleRelPath: 'runtime/tools/demo.py',
          description: '计算演示',
          params: [{ name: 'value', jsonType: 'number', required: true }],
          source: 'heuristic',
        },
        {
          name: 'async_only',
          moduleRelPath: 'runtime/tools/demo.py',
          description: '异步函数',
          params: [],
          unsupportedReason: '不支持 async 函数',
          source: 'heuristic',
        },
      ],
      scannedAt: Date.now(),
      engine: 'heuristic',
      message: '',
    }

    const tools = buildPiCsLabTools(
      fakeSdk as unknown as Parameters<typeof buildPiCsLabTools>[0],
      { sessionId: 'session-bound' },
      {
        getSessionMeta: () => ({
          id: 'session-bound',
          title: '测试会话',
          cslabLabId: lab.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        readManifest: () => scan,
      },
    )
    const names = tools.map((tool) => (tool as { name: string }).name)
    expect(names).toContain('cslab_calculate')
    expect(names).toContain('cslab_list_lab_tools')
    expect(names).toContain('cslab_run_lab_tool')
    expect(names).not.toContain('cslab_async_only')
  })
})
