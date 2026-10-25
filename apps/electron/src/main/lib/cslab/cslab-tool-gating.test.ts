/**
 * CSLab 研讨会话门禁测试
 *
 * 核心验收：8 类资产工具链只出现在 cslabLabId 已绑定的会话；
 * 常规会话与速课堂会话必须 0 工具、0 提示词泄漏。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab
let boundSessionId = ''
let unboundSessionId = ''

const fakeSdk = { defineTool: (definition: unknown) => definition } as never

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-gating-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  const { createAgentSession, updateAgentSessionMeta } = await import('../agent-session-manager')
  lab = createLab({ name: '门禁测试实验室', description: 'tool gating' })
  const bound = createAgentSession('绑定会话')
  boundSessionId = bound.id
  updateAgentSessionMeta(boundSessionId, { cslabLabId: lab.id })
  unboundSessionId = createAgentSession('普通会话').id
})

afterAll(() => {
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows SQLite 句柄可能延迟释放
  }
})

describe('CSLab 8 类资产工具链门禁', () => {
  test('Given 未绑定会话 When 构建所有 CSLab 工具 Then 全部为空', async () => {
    const { buildPiCsLabTools } = await import('../adapters/pi-cslab-tools')
    const { buildCsLabScienceTools } = await import('./cslab-scientific-tools')
    const { buildCsLabLiteratureTools } = await import('./cslab-literature-tools')
    const { buildCsLabGeohazardTools } = await import('./cslab-geohazard-tools')
    const { buildCsLabAssetTools } = await import('./cslab-asset-tools')

    expect(buildPiCsLabTools(fakeSdk, { sessionId: unboundSessionId })).toEqual([])
    expect(buildCsLabScienceTools(fakeSdk, { sessionId: unboundSessionId })).toEqual([])
    expect(buildCsLabLiteratureTools(fakeSdk, { sessionId: unboundSessionId })).toEqual([])
    expect(buildCsLabGeohazardTools(fakeSdk, { sessionId: unboundSessionId })).toEqual([])
    expect(buildCsLabAssetTools(fakeSdk, { sessionId: unboundSessionId })).toEqual([])
  })

  test('Given 绑定会话 When 构建资产工具 Then 5 个专属工具全部挂载', async () => {
    const { buildCsLabAssetTools } = await import('./cslab-asset-tools')
    const tools = buildCsLabAssetTools(fakeSdk, { sessionId: boundSessionId })
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cslab_create_table',
      'cslab_digitize_figure',
      'cslab_focus_asset',
      'cslab_write_canvas',
      'cslab_write_manuscript',
    ])
  })

  test('Given 普通会话 When 构建系统提示词 Then 无任何 CSLab 泄漏', async () => {
    const { buildSystemPrompt } = await import('../agent-prompt-builder')
    const prompt = buildSystemPrompt({
      sessionId: unboundSessionId,
      permissionMode: 'auto',
    })
    expect(prompt).not.toContain('<cslab_science>')
    expect(prompt).not.toContain('<native_rendering_matrix>')
    expect(prompt).not.toContain('cslab_')
  })

  test('Given 速课堂会话 When 构建系统提示词 Then 无任何 CSLab 泄漏', async () => {
    const { buildSystemPrompt } = await import('../agent-prompt-builder')
    const prompt = buildSystemPrompt({
      sessionId: unboundSessionId,
      permissionMode: 'auto',
      isStudyClass: true,
      studyOutline: '',
      studyCognition: '',
    })
    expect(prompt).not.toContain('<cslab_science>')
    expect(prompt).not.toContain('cslab_')
  })

  test('Given 绑定会话 When 构建系统提示词 Then 8 类矩阵与 5 个工具齐全', async () => {
    const { buildSystemPrompt } = await import('../agent-prompt-builder')
    const { getCsLabPromptLabInfo } = await import('./cslab-science')
    const info = await getCsLabPromptLabInfo(lab.id)
    const prompt = buildSystemPrompt({
      sessionId: boundSessionId,
      permissionMode: 'auto',
      cslabLabBound: true,
      cslabLabInfo: info,
    })
    expect(prompt).toContain('<native_rendering_matrix>')
    expect(prompt).toContain('cslab_focus_asset')
    expect(prompt).toContain('cslab_digitize_figure')
    expect(prompt).toContain('cslab_create_table')
    expect(prompt).toContain('cslab_write_canvas')
    expect(prompt).toContain('cslab_write_manuscript')
    expect(prompt).toContain('<contingency_protocols>')
  })
})
