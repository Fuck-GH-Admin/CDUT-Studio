/**
 * 8 类资产工具链行为测试
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'
import { PNG } from 'pngjs'

let rootDir = ''
let lab: CsLabLab
let sessionId = ''

const fakeSdk = { defineTool: (definition: unknown) => definition } as never

async function toolsForSession() {
  const { buildCsLabAssetTools } = await import('./cslab-asset-tools')
  return buildCsLabAssetTools(fakeSdk, { sessionId })
}

function findTool(tools: Awaited<ReturnType<typeof toolsForSession>>, name: string) {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-asset-tools-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  const { createAgentSession, updateAgentSessionMeta } = await import('../agent-session-manager')
  lab = createLab({ name: '资产工具测试实验室', description: 'asset tools' })
  sessionId = createAgentSession('资产工具会话').id
  updateAgentSessionMeta(sessionId, { cslabLabId: lab.id })
})

afterAll(async () => {
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // 忽略 Windows 句柄
  }
})

describe('CSLab 8 类资产工具', () => {
  test('Given 数值列 When cslab_create_table Then 生成 Parquet 表资产', async () => {
    const tool = findTool(await toolsForSession(), 'cslab_create_table')
    const result = (await tool.execute(
      'call-table',
      {
        title: 'CD 光谱表',
        columns: [
          { label: 'Wavelength', unit: 'nm', values: [190, 200, 210, 220] },
          { label: 'CD', unit: 'mdeg', values: [-1, -3, -5, -4] },
          { label: 'Absorbance', unit: 'a.u.', values: [1.1, 1.3, 1.2, 1.0] },
        ],
      },
      undefined,
      undefined,
      {} as never,
    )) as any
    expect(result.isError).toBeFalsy()
    expect(result.details.rowCount).toBe(4)
    expect(result.details.uri).toContain('/table/')
  })

  test('Given 节点与边 When cslab_write_canvas Then 新建 JSON Canvas', async () => {
    const tool = findTool(await toolsForSession(), 'cslab_write_canvas')
    const result = (await tool.execute(
      'call-canvas',
      {
        title: '工具链推演',
        document: {
          nodes: [
            { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: '假设' },
            { id: 'n2', type: 'text', x: 260, y: 0, width: 200, height: 80, text: '验证' },
          ],
          edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
        },
      },
      undefined,
      undefined,
      {} as never,
    )) as any
    expect(result.isError).toBeFalsy()
    expect(result.details.relPath).toContain('vault/notes/')
    expect(result.details.nodes).toBe(2)
    expect(result.details.edges).toBe(1)
  })

  test('Given 已有 canvasData 的手稿 When 追加段落 Then 不保留旧 canvasData', async () => {
    const { createManuscript, saveManuscript, getManuscript } = await import('./cslab-manuscript')
    const manuscript = await createManuscript(lab.id, '旧手稿')
    await saveManuscript({
      labId: lab.id,
      uri: manuscript.uri,
      title: manuscript.title,
      docJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧段落' }] }] },
      canvasData: { main: [{ value: '旧画布内容' }] },
      comments: [],
      capsules: [],
    })
    const tool = findTool(await toolsForSession(), 'cslab_write_manuscript')
    const result = (await tool.execute(
      'call-manuscript',
      { title: '旧手稿', uri: manuscript.uri, paragraphs: ['新段落'] },
      undefined,
      undefined,
      {} as never,
    )) as any
    expect(result.isError).toBeFalsy()
    expect(result.details.mode).toBe('appended')
    const reloaded = await getManuscript(lab.id, manuscript.uri)
    expect(reloaded?.canvasData).toBeUndefined()
    expect(JSON.stringify(reloaded?.docJson)).toContain('新段落')
    expect(JSON.stringify(reloaded?.docJson)).toContain('旧段落')
  })

  test('Given 已存在资产 When cslab_focus_asset Then 返回 focused 状态', async () => {
    const { listAssets } = await import('./cslab-iron-cage')
    const table = listAssets(lab.id).find((asset) => asset.layerType === 'table')
    expect(table).toBeTruthy()
    const tool = findTool(await toolsForSession(), 'cslab_focus_asset')
    const result = (await tool.execute(
      'call-focus',
      { uri: table!.uri },
      undefined,
      undefined,
      {} as never,
    )) as any
    expect(result.isError).toBeFalsy()
    expect(result.details.status).toBe('focused')
  })

  test('Given 图版资产 When cslab_digitize_figure 无 Python/无刻度 Then 诚实失败', async () => {
    const { registerEntityFile } = await import('./cslab-geohazard-tools')
    const png = new PNG({ width: 32, height: 32 })
    png.data.fill(255)
    const asset = await registerEntityFile({
      labId: lab.id,
      layerType: 'fig',
      title: 'tiny.png',
      format: 'png',
      relDir: 'figures',
      content: PNG.sync.write(png),
    })
    const tool = findTool(await toolsForSession(), 'cslab_digitize_figure')
    const result = (await tool.execute(
      'call-digitize',
      { uri: asset.uri, mode: 'line' },
      undefined,
      undefined,
      {} as never,
    )) as any
    expect(result.isError).toBeTruthy()
    expect(String(result.details.error)).toContain('标定')
  })
})
