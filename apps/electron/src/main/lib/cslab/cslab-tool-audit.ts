/**
 * CSLab 自定义 Python 工具执行审计
 *
 * 每次执行（含失败）都追加一行 JSONL 到实验室沙箱：
 *   runtime/logs/tool-executions.jsonl
 *
 * 写入失败只记录 warn，绝不改变工具执行结果；同进程内通过 Promise 队列串行追加，
 * 保证行序与执行顺序一致。
 */

import { promises as fs } from 'node:fs'
import type { ProferPermissionMode } from '@profer/shared'
import { resolveLabRelativePath } from './cslab-paths'

const AUDIT_REL_DIR = 'runtime/logs'
const AUDIT_REL_PATH = `${AUDIT_REL_DIR}/tool-executions.jsonl`
const MAX_ARGS_CHARS = 8 * 1024
const MAX_RESULT_CHARS = 2 * 1024

export interface CsLabToolExecutionAuditInput {
  labId: string
  sessionId?: string
  source: 'agent' | 'ipc'
  permissionMode?: ProferPermissionMode
  moduleRelPath?: string
  function: string
  args: unknown
  ok: boolean
  exitCode?: number
  elapsedMs: number
  result?: unknown
  error?: string
}

interface CsLabToolExecutionAuditRecord {
  at: string
  labId: string
  sessionId?: string
  source: 'agent' | 'ipc'
  permissionMode?: ProferPermissionMode
  moduleRelPath?: string
  function: string
  args: string
  argsTruncated?: boolean
  ok: boolean
  exitCode?: number
  elapsedMs: number
  resultSummary?: string
  error?: string
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}…`, truncated: true }
}

let auditQueue: Promise<void> = Promise.resolve()

/** 追加一条工具执行审计；内部吞掉写盘异常，调用方无需处理。 */
export function appendCsLabToolAudit(input: CsLabToolExecutionAuditInput): Promise<void> {
  const args = truncate(safeJson(input.args), MAX_ARGS_CHARS)
  const resultSummary = input.result === undefined
    ? undefined
    : truncate(safeJson(input.result), MAX_RESULT_CHARS)
  const error = input.error === undefined
    ? undefined
    : truncate(input.error, MAX_RESULT_CHARS).text

  const record: CsLabToolExecutionAuditRecord = {
    at: new Date().toISOString(),
    labId: input.labId,
    sessionId: input.sessionId,
    source: input.source,
    permissionMode: input.permissionMode,
    moduleRelPath: input.moduleRelPath,
    function: input.function,
    args: args.text,
    argsTruncated: args.truncated || undefined,
    ok: input.ok,
    exitCode: input.exitCode,
    elapsedMs: input.elapsedMs,
    resultSummary: resultSummary?.text,
    error,
  }

  auditQueue = auditQueue
    .then(async () => {
      const dir = resolveLabRelativePath(input.labId, AUDIT_REL_DIR)
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(
        resolveLabRelativePath(input.labId, AUDIT_REL_PATH),
        `${JSON.stringify(record)}\n`,
        'utf-8',
      )
    })
    .catch((writeError: unknown) => {
      console.warn('[CSLab] 工具执行审计写入失败:', writeError)
    })

  return auditQueue
}
