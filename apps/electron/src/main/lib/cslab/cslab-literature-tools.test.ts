import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab
let sessionId = ''

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-lit-tools-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  const { createAgentSession, updateAgentSessionMeta } = await import('../agent-session-manager')
  lab = createLab({ name: '文献工具测试实验室' })
  const meta = createAgentSession('文献工具测试会话')
  sessionId = meta.id
  updateAgentSessionMeta(sessionId, { cslabLabId: lab.id })
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

describe('CSLab 文献工具集', () => {
  test('Given 绑定实验室 When 构建工具 Then 检索/精读/导读三件套齐备', async () => {
    const { buildCsLabLiteratureTools } = await import('./cslab-literature-tools')
    const fakeSdk = { defineTool: (def: unknown) => def } as any
    const tools = buildCsLabLiteratureTools(fakeSdk, { sessionId })
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cslab_paper_guided_reading',
      'cslab_read_paper_section',
      'cslab_search_literature',
    ])
  })

  test('Given 未绑定实验室 When 构建工具 Then 返回空数组', async () => {
    const { buildCsLabLiteratureTools } = await import('./cslab-literature-tools')
    const fakeSdk = { defineTool: (def: unknown) => def } as any
    const tools = buildCsLabLiteratureTools(fakeSdk, { sessionId: 'not-bound-session' })
    expect(tools).toEqual([])
  })
})
