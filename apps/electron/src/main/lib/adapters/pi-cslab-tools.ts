/**
 * Pi Agent × CSLab 自定义科研工具桥接
 *
 * 隔离红线：
 * 1. 绝不使用进程级 activeLabId；
 * 2. 只读取当前会话 `AgentSessionMeta.cslabLabId`，未绑定则返回空工具集；
 * 3. 工具清单来自实验室 `runtime/tools/.cslab-tools.json`，由用户在工具面板显式绑定。
 */

import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentSessionMeta,
  CsLabCustomTool,
  CsLabCustomToolJsonType,
  CsLabCustomToolScan,
  ProferPermissionMode,
} from '@profer/shared'
import { getAgentSessionMeta } from '../agent-session-manager'
import { assertLabId } from '../cslab/cslab-paths'
import {
  readLabToolManifestSync,
  runLabTool,
  scanLabTools,
} from '../cslab/cslab-tool-registry'

type PiSdkLike = typeof import('@earendil-works/pi-coding-agent')

export interface PiCsLabToolsContext {
  sessionId: string
  /** 执行时动态读取当前会话权限模式，仅用于审计记账。 */
  getPermissionMode?: () => ProferPermissionMode
}

export interface CsLabToolBridgeDeps {
  getSessionMeta?: (sessionId: string) => AgentSessionMeta | undefined
  readManifest?: (labId: string) => CsLabCustomToolScan | null
  runTool?: typeof runLabTool
  scanTools?: typeof scanLabTools
}

function textToolResult<T>(text: string, details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text }],
    details,
  } as AgentToolResult<T>
}

function jsonTypeToSchema(type: CsLabCustomToolJsonType): TSchema {
  switch (type) {
    case 'string':
      return Type.String()
    case 'number':
      return Type.Number()
    case 'integer':
      return Type.Integer()
    case 'boolean':
      return Type.Boolean()
    case 'array':
      return Type.Array(Type.Unknown())
    case 'object':
      return Type.Record(Type.String(), Type.Unknown())
    default:
      return Type.Unknown()
  }
}

function buildParameters(tool: CsLabCustomTool): TSchema {
  const shape: Record<string, TSchema> = {}
  for (const param of tool.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) continue
    const schema = jsonTypeToSchema(param.jsonType)
    shape[param.name] = param.required ? schema : Type.Optional(schema)
  }
  return Type.Object(shape, { additionalProperties: false })
}

function toolNameFor(tool: CsLabCustomTool, used: Set<string>): string {
  const base = `cslab_${tool.name.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60)
  let candidate = base
  let counter = 2
  while (used.has(candidate)) {
    candidate = `${base}_${counter}`.slice(0, 64)
    counter += 1
  }
  used.add(candidate)
  return candidate
}

function formatSignature(tool: CsLabCustomTool): string {
  const params = tool.params
    .map((param) => `${param.name}: ${param.annotation ?? param.jsonType}${param.required ? '' : '?'}`)
    .join(', ')
  return `${tool.name}(${params})${tool.returns ? ` -> ${tool.returns}` : ''}`
}

/**
 * 构建当前会话可用的 CSLab 工具。
 * 未绑定实验室时返回空数组，绝不影响通用 Pi 编程工具。
 */
export function buildPiCsLabTools(
  sdk: PiSdkLike,
  ctx: PiCsLabToolsContext,
  deps: CsLabToolBridgeDeps = {},
): ToolDefinition[] {
  const getSessionMeta = deps.getSessionMeta ?? getAgentSessionMeta
  const readManifest = deps.readManifest ?? readLabToolManifestSync
  const executeTool = deps.runTool ?? runLabTool
  const scanTools = deps.scanTools ?? scanLabTools
  const getPermissionMode = ctx.getPermissionMode
  const auditContext = () => ({
    source: 'agent' as const,
    sessionId: ctx.sessionId,
    permissionMode: getPermissionMode?.(),
  })

  const meta = getSessionMeta(ctx.sessionId)
  const labId = meta?.cslabLabId
  if (!labId) return []

  let normalizedLabId: string
  try {
    normalizedLabId = assertLabId(labId)
  } catch {
    return []
  }

  const manifest = readManifest(normalizedLabId)
  const tools: ToolDefinition[] = []
  // 预留内置工具名，避免用户函数同名导致重复注册。
  const usedNames = new Set<string>(['cslab_list_lab_tools', 'cslab_run_lab_tool'])

  for (const tool of manifest?.tools ?? []) {
    if (tool.unsupportedReason) continue
    const name = toolNameFor(tool, usedNames)
    tools.push(
      sdk.defineTool({
        name,
        label: `CSLab · ${tool.name}`,
        description: `${tool.description}\n\n实验室 Python 工具签名：${formatSignature(tool)}。参数必须符合 Type Hints 约束。`,
        promptSnippet: `调用实验室 ${normalizedLabId} 的 Python 科研工具 ${tool.name}`,
        parameters: buildParameters(tool),
        async execute(_toolCallId: string, params: unknown) {
          const result = await executeTool({
            labId: normalizedLabId,
            name: tool.name,
            args: (params ?? {}) as Record<string, unknown>,
          }, auditContext())
          const text = result.ok
            ? JSON.stringify(result.result ?? null, null, 2)
            : `执行失败：${result.error ?? '未知错误'}`
          return textToolResult(text, result)
        },
      }) as ToolDefinition,
    )
  }

  tools.push(
    sdk.defineTool({
      name: 'cslab_list_lab_tools',
      label: 'CSLab 列出实验室工具',
      description: '重新扫描并列出当前会话所绑定实验室的 Python 科研工具（函数签名与参数类型）。',
      parameters: Type.Object({}),
      async execute() {
        const scan = await scanTools(normalizedLabId)
        return textToolResult(
          JSON.stringify(
            scan.tools.map((tool) => ({
              name: tool.name,
              signature: formatSignature(tool),
              description: tool.description,
              unsupportedReason: tool.unsupportedReason,
            })),
            null,
            2,
          ),
          scan,
        )
      },
    }) as ToolDefinition,
    sdk.defineTool({
      name: 'cslab_run_lab_tool',
      label: 'CSLab 调用实验室工具',
      description:
        '按名称调用当前会话绑定实验室的 Python 工具。argsJson 必须是 JSON 对象字符串，例如 {"voltage": 3.7}。',
      parameters: Type.Object({
        name: Type.String({ description: '函数名，例如 capacity_estimate' }),
        argsJson: Type.Optional(
          Type.String({ description: 'JSON 对象字符串；缺省为空对象' }),
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const record = (params ?? {}) as Record<string, unknown>
        const name = typeof record.name === 'string' ? record.name.trim() : ''
        if (!name) throw new Error('name 必填')
        let args: Record<string, unknown> = {}
        if (typeof record.argsJson === 'string' && record.argsJson.trim()) {
          let parsed: unknown
          try {
            parsed = JSON.parse(record.argsJson)
          } catch {
            throw new Error('argsJson 不是合法 JSON')
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('argsJson 必须是 JSON 对象')
          }
          args = parsed as Record<string, unknown>
        }
        const result = await executeTool({ labId: normalizedLabId, name, args }, auditContext())
        return textToolResult(
          result.ok ? JSON.stringify(result.result ?? null, null, 2) : `执行失败：${result.error}`,
          result,
        )
      },
    }) as ToolDefinition,
  )

  return tools
}
