/**
 * CSLab 用户自定义 Python 工具注册表
 *
 * 能力：
 * - 扫描 `runtime/tools/*.py`，优先用实验室 Python `ast` 提取签名与 docstring；
 * - 无 Python 时降级为启发式解析，并如实标记 source=heuristic；
 * - 清单落盘 `.cslab-tools.json`（safe-file 原子写 + .bak 回退）；
 * - 通过 runner 脚本在实验室 venv 中执行函数，超时 120s，绝不伪造结果。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  CsLabCustomTool,
  CsLabCustomToolJsonType,
  CsLabCustomToolParam,
  CsLabCustomToolRunInput,
  CsLabCustomToolRunResult,
  CsLabCustomToolScan,
  ProferPermissionMode,
} from '@profer/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { assertLabId, resolveLabDir, resolveLabRelativePath } from './cslab-paths'
import { createDebouncer } from './cslab-debounce'
import { resolveCsLabScript, resolveLabPython } from './cslab-python-runtime'
import { appendCsLabToolAudit } from './cslab-tool-audit'

const execFileAsync = promisify(execFile)
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MANIFEST_FILE = '.cslab-tools.json'

interface ToolManifestFile {
  version: 1
  labId: string
  scannedAt: number
  engine: 'ast' | 'heuristic' | 'none'
  fingerprint: string
  message: string
  tools: CsLabCustomTool[]
}

interface ScannerFunctionPayload {
  name: string
  docstring?: string
  moduleDoc?: string
  args?: Array<{
    name: string
    annotation?: string | null
    required?: boolean
    default?: string | null
  }>
  returns?: string | null
  unsupportedReason?: string | null
}

function toolRecordPath(labId: string, relPath: string): string {
  return resolveLabRelativePath(labId, relPath)
}

function manifestPath(labId: string): string {
  return resolveLabRelativePath(labId, `runtime/tools/${MANIFEST_FILE}`)
}

function parseLastJsonLine(text: string): unknown {
  const lines = text.trim().split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      return JSON.parse(line)
    } catch {
      // 继续向上找。
    }
  }
  return null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function cleanAnnotation(annotation: string | null | undefined): string | undefined {
  if (!annotation) return undefined
  const trimmed = annotation.trim().replace(/^["']|["']$/g, '')
  return trimmed || undefined
}

/** 把 Python 类型注解映射为 JSON Schema 基础类型。 */
export function annotationToJsonType(annotation?: string): {
  jsonType: CsLabCustomToolJsonType
  optional: boolean
} {
  if (!annotation) return { jsonType: 'any', optional: false }
  let text = annotation.trim().replace(/typing\./g, '')
  let optional = false

  const optionalMatch = /^Optional\[(.+)]$/.exec(text)
  if (optionalMatch) {
    optional = true
    text = optionalMatch[1]!.trim()
  } else if (/\|\s*None\b/.test(text)) {
    optional = true
    text = text.replace(/\|\s*None\b/g, '').trim()
  } else if (/^None\s*\|/.test(text)) {
    optional = true
    text = text.replace(/^None\s*\|/, '').trim()
  }

  const lowered = text.toLowerCase().replace(/\s+/g, '')
  if (/^(str|string|text)$/.test(lowered)) return { jsonType: 'string', optional }
  if (/^(int|integer)$/.test(lowered)) return { jsonType: 'integer', optional }
  if (/^(float|number|decimal|double)$/.test(lowered)) return { jsonType: 'number', optional }
  if (/^(bool|boolean)$/.test(lowered)) return { jsonType: 'boolean', optional }
  if (/^(list|tuple|set|sequence|iterable|frozenset)\[/.test(lowered)) {
    return { jsonType: 'array', optional }
  }
  if (/^(list|tuple|set|sequence|iterable|frozenset)$/.test(lowered)) {
    return { jsonType: 'array', optional }
  }
  if (/^(dict|mapping)\[/.test(lowered)) return { jsonType: 'object', optional }
  if (/^(dict|mapping)$/.test(lowered)) return { jsonType: 'object', optional }
  return { jsonType: 'any', optional }
}

function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

export interface ParsedPythonParam {
  name: string
  annotation?: string
  defaultValue?: string
  required: boolean
  variadic: boolean
}

/** 解析 `def f(...)` 括号内的参数串（启发式回退路径，导出供测试）。 */
export function parsePythonToolSignature(paramText: string): ParsedPythonParam[] {
  const params: ParsedPythonParam[] = []
  for (const raw of splitTopLevel(paramText)) {
    let segment = raw.trim()
    if (!segment) continue
    // 单独的 * / 仅表示 keyword-only / positional-only 分界，不是变长参数。
    if (segment === '*' || segment === '/') continue
    let variadic = false
    if (segment.startsWith('**') || (segment.startsWith('*') && segment.length > 1)) {
      variadic = true
      segment = segment.replace(/^\*+/, '').trim()
    }

    const equalsIndex = (() => {
      let depth = 0
      for (let index = 0; index < segment.length; index += 1) {
        const char = segment[index]!
        if (char === '(' || char === '[' || char === '{') depth += 1
        if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
        if (char === '=' && depth === 0) return index
      }
      return -1
    })()

    const left = equalsIndex >= 0 ? segment.slice(0, equalsIndex) : segment
    const defaultValue = equalsIndex >= 0 ? segment.slice(equalsIndex + 1).trim() : undefined
    const colonIndex = left.indexOf(':')
    const name = (colonIndex >= 0 ? left.slice(0, colonIndex) : left).trim()
    const annotation = colonIndex >= 0 ? cleanAnnotation(left.slice(colonIndex + 1)) : undefined
    if (!name) continue
    params.push({
      name,
      annotation,
      defaultValue,
      required: equalsIndex < 0,
      variadic,
    })
  }
  return params
}

function extractDocstring(source: string, fromIndex: number): string | undefined {
  const rest = source.slice(fromIndex)
  const match = /^\s*(?:\r?\n\s*)?(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(rest)
  if (!match) return undefined
  return match[1]?.trim().split(/\r?\n\r?\n/)[0]?.trim().replace(/\s+/g, ' ')
}

function extractModuleDocstring(source: string): string | undefined {
  const match = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(source)
  return match?.[1]?.trim().split(/\r?\n\r?\n/)[0]?.trim()
}

/** 启发式解析模块（无 Python 或 AST 失败时使用）。 */
export function parseHeuristicModule(
  moduleRelPath: string,
  source: string,
): CsLabCustomTool[] {
  const moduleDoc = extractModuleDocstring(source)
  const tools: CsLabCustomTool[] = []
  const declarationRe = /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

  let match: RegExpExecArray | null
  while ((match = declarationRe.exec(source)) !== null) {
    const isAsync = !!match[1]
    const name = match[2]!
    if (name.startsWith('_')) continue

    const openIndex = match.index + match[0].length - 1
    let depth = 0
    let closeIndex = -1
    for (let index = openIndex; index < source.length; index += 1) {
      const char = source[index]!
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          closeIndex = index
          break
        }
      }
    }
    if (closeIndex < 0) continue

    const paramText = source.slice(openIndex + 1, closeIndex)
    const afterParams = source.slice(closeIndex + 1)
    const returnMatch = /^\s*->\s*([^:]+):/.exec(afterParams)
    const colonIndex = (() => {
      let bracketDepth = 0
      for (let index = 0; index < afterParams.length; index += 1) {
        const char = afterParams[index]!
        if (char === '(' || char === '[' || char === '{') bracketDepth += 1
        if (char === ')' || char === ']' || char === '}') bracketDepth = Math.max(0, bracketDepth - 1)
        if (char === ':' && bracketDepth === 0) return index
      }
      return -1
    })()

    const docstring =
      colonIndex >= 0 ? extractDocstring(afterParams, colonIndex + 1) : undefined
    const parsedParams = parsePythonToolSignature(paramText)
    const variadic = parsedParams.some((param) => param.variadic)

    tools.push({
      name,
      moduleRelPath,
      description: docstring || moduleDoc || `${moduleRelPath}::${name}`,
      params: parsedParams
        .filter((param) => !param.variadic)
        .map((param) => {
          const mapped = annotationToJsonType(param.annotation)
          return {
            name: param.name,
            jsonType: mapped.jsonType,
            required: param.required && !mapped.optional,
            annotation: param.annotation,
            defaultValue: param.defaultValue,
            description: undefined,
          } satisfies CsLabCustomToolParam
        }),
      returns: returnMatch?.[1]?.trim(),
      unsupportedReason: isAsync
        ? '不支持 async 函数'
        : variadic
          ? '不支持 *args/**kwargs 变长参数'
          : undefined,
      source: 'heuristic',
    })
  }

  return tools
}

async function listToolFiles(labId: string): Promise<{ absPath: string; relPath: string; name: string }[]> {
  const toolsDir = resolveLabRelativePath(labId, 'runtime/tools')
  await fs.mkdir(toolsDir, { recursive: true })
  const entries = await fs.readdir(toolsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.py') && !entry.name.startsWith('.'))
    .map((entry) => ({
      absPath: join(toolsDir, entry.name),
      relPath: `runtime/tools/${entry.name}`,
      name: entry.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function fingerprintFiles(
  files: { absPath: string; relPath: string }[],
): Promise<string> {
  const parts: string[] = []
  for (const file of files) {
    try {
      const stat = await fs.stat(file.absPath)
      parts.push(`${file.relPath}:${Math.round(stat.mtimeMs)}:${stat.size}`)
    } catch {
      parts.push(`${file.relPath}:missing`)
    }
  }
  return sha256(parts.join('|'))
}

async function scanWithAst(
  python: { command: string; argsPrefix: string[] },
  scannerPath: string,
  absPath: string,
): Promise<{ ok: boolean; moduleDoc?: string; functions?: ScannerFunctionPayload[]; error?: string }> {
  const { stdout } = await execFileAsync(
    python.command,
    [...python.argsPrefix, scannerPath, '--file', absPath],
    { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  const parsed = parseLastJsonLine(stdout) as
    | { ok?: boolean; moduleDoc?: string; functions?: ScannerFunctionPayload[]; error?: string }
    | null
  if (!parsed) return { ok: false, error: '扫描器输出不可解析' }
  return {
    ok: parsed.ok === true,
    moduleDoc: parsed.moduleDoc,
    functions: Array.isArray(parsed.functions) ? parsed.functions : [],
    error: parsed.error,
  }
}

function buildToolFromAst(
  moduleRelPath: string,
  moduleDoc: string | undefined,
  fn: ScannerFunctionPayload,
  source: 'ast' | 'heuristic',
): CsLabCustomTool {
  const params: CsLabCustomToolParam[] = (fn.args ?? []).map((arg) => {
    const mapped = annotationToJsonType(arg.annotation ?? undefined)
    return {
      name: arg.name,
      jsonType: mapped.jsonType,
      required: arg.required !== false && !mapped.optional,
      annotation: cleanAnnotation(arg.annotation),
      defaultValue: arg.default ?? undefined,
    }
  })

  return {
    name: fn.name,
    moduleRelPath,
    description: fn.docstring?.split(/\r?\n/)[0]?.trim() || moduleDoc || `${moduleRelPath}::${fn.name}`,
    params,
    returns: fn.returns ?? undefined,
    unsupportedReason: fn.unsupportedReason ?? undefined,
    source,
  }
}

function dedupeTools(tools: CsLabCustomTool[]): CsLabCustomTool[] {
  const seen = new Set<string>()
  return tools.map((tool) => {
    if (seen.has(tool.name)) {
      return { ...tool, unsupportedReason: '函数名与其他工具重复，未装配' }
    }
    seen.add(tool.name)
    return tool
  })
}

export async function scanLabTools(labIdInput: string): Promise<CsLabCustomToolScan> {
  const labId = assertLabId(labIdInput)
  const files = await listToolFiles(labId)
  const fingerprint = await fingerprintFiles(files)
  const scannedAt = Date.now()

  if (files.length === 0) {
    const manifest: ToolManifestFile = {
      version: 1,
      labId,
      scannedAt,
      engine: 'none',
      fingerprint,
      message: 'runtime/tools 下暂无 Python 文件',
      tools: [],
    }
    writeJsonFileAtomic(manifestPath(labId), manifest)
    return { labId, tools: [], scannedAt, engine: 'none', message: manifest.message }
  }

  const python = await resolveLabPython(labId)
  const scannerPath = resolveCsLabScript('cslab-tool-scanner.py')
  let engine: CsLabCustomToolScan['engine'] = 'heuristic'
  let message = ''
  const tools: CsLabCustomTool[] = []

  if (python && scannerPath) {
    engine = 'ast'
    let astFailures = 0
    for (const file of files) {
      try {
        const result = await scanWithAst(python, scannerPath, file.absPath)
        if (!result.ok || !result.functions) {
          astFailures += 1
          const fallback = parseHeuristicModule(file.relPath, await fs.readFile(file.absPath, 'utf-8'))
          tools.push(...fallback)
          continue
        }
        for (const fn of result.functions) {
          if (!TOOL_NAME_RE.test(fn.name) || fn.name.startsWith('_')) continue
          tools.push(buildToolFromAst(file.relPath, result.moduleDoc, fn, 'ast'))
        }
      } catch (error) {
        astFailures += 1
        console.warn(`[CSLab] AST 扫描失败，降级启发式: ${file.relPath}`, error)
        const fallback = parseHeuristicModule(file.relPath, await fs.readFile(file.absPath, 'utf-8'))
        tools.push(...fallback)
      }
    }
    message =
      astFailures > 0
        ? `AST 扫描完成，${astFailures} 个文件降级为启发式解析`
        : 'AST 扫描完成'
  } else {
    engine = 'heuristic'
    for (const file of files) {
      try {
        tools.push(...parseHeuristicModule(file.relPath, await fs.readFile(file.absPath, 'utf-8')))
      } catch (error) {
        console.warn(`[CSLab] 工具文件读取失败: ${file.relPath}`, error)
      }
    }
    message = python
      ? '缺少 cslab-tool-scanner.py，已降级为启发式解析（类型可能不完整）'
      : '未检测到 Python，已使用启发式解析（类型可能不完整）'
  }

  const deduped = dedupeTools(tools)
  const manifest: ToolManifestFile = {
    version: 1,
    labId,
    scannedAt,
    engine,
    fingerprint,
    message,
    tools: deduped,
  }
  writeJsonFileAtomic(manifestPath(labId), manifest)

  return { labId, tools: deduped, scannedAt, engine, message }
}

function readManifest(labId: string): ToolManifestFile | null {
  const manifest = readJsonFileSafe<ToolManifestFile>(manifestPath(labId))
  if (!manifest || manifest.version !== 1 || manifest.labId !== labId) return null
  return manifest
}

/** 供 Pi 会话构建同步读取；不触发扫描。 */
export function readLabToolManifestSync(labIdInput: string): CsLabCustomToolScan | null {
  try {
    const labId = assertLabId(labIdInput)
    const manifest = readManifest(labId)
    if (!manifest) return null
    return {
      labId,
      tools: manifest.tools,
      scannedAt: manifest.scannedAt,
      engine: manifest.engine,
      message: manifest.message,
    }
  } catch {
    return null
  }
}

export async function getLabToolScan(labIdInput: string): Promise<CsLabCustomToolScan> {
  const labId = assertLabId(labIdInput)
  const cached = readLabToolManifestSync(labId)
  if (cached) {
    const files = await listToolFiles(labId)
    const fingerprint = await fingerprintFiles(files)
    const manifest = readManifest(labId)
    if (manifest?.fingerprint === fingerprint) return cached
  }
  return scanLabTools(labId)
}

export interface CsLabToolAuditContext {
  sessionId?: string
  /** Agent 调用或科研工具面板手动调用。 */
  source: 'agent' | 'ipc'
  permissionMode?: ProferPermissionMode
}

export async function runLabTool(
  input: CsLabCustomToolRunInput,
  auditContext: CsLabToolAuditContext = { source: 'ipc' },
): Promise<CsLabCustomToolRunResult> {
  const startedAt = Date.now()
  const audit = {
    moduleRelPath: undefined as string | undefined,
    exitCode: undefined as number | undefined,
    ok: false,
    result: undefined as unknown,
    error: undefined as string | undefined,
  }

  try {
    const labId = assertLabId(input.labId)
    if (!TOOL_NAME_RE.test(input.name)) throw new Error('工具名称非法')

    const scan = readLabToolManifestSync(labId)
    const tool = scan?.tools.find((item) => item.name === input.name)
    if (!tool) throw new Error('工具不存在，请先重新扫描')
    if (tool.unsupportedReason) throw new Error(tool.unsupportedReason)
    audit.moduleRelPath = tool.moduleRelPath

    const known = new Map(tool.params.map((param) => [param.name, param]))
    const args: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input.args ?? {})) {
      if (!known.has(key)) throw new Error(`未知参数: ${key}`)
      args[key] = value
    }
    for (const param of tool.params) {
      if (param.required && !(param.name in args)) throw new Error(`缺少必填参数: ${param.name}`)
    }

    const moduleAbs = toolRecordPath(labId, tool.moduleRelPath)
    const moduleDir = resolveLabRelativePath(labId, 'runtime/tools')
    // 必须以分隔符收尾，否则 runtime/tools-evil/ 会被误判为 runtime/tools 内部。
    const safePrefix = moduleDir.endsWith(sep) ? moduleDir : `${moduleDir}${sep}`
    if (!moduleAbs.startsWith(safePrefix)) {
      throw new Error('工具路径越界：目标不在 runtime/tools 目录内')
    }

    const runnerPath = resolveCsLabScript('cslab-tool-runner.py')
    if (!runnerPath) throw new Error('缺少 cslab-tool-runner.py')
    const python = await resolveLabPython(labId)
    if (!python) throw new Error('未检测到 Python 运行时')

    const argsPath = resolveLabRelativePath(
      labId,
      `runtime/logs/.tool-args-${randomUUID().slice(0, 8)}.json`,
    )
    await fs.mkdir(resolveLabRelativePath(labId, 'runtime/logs'), { recursive: true })
    await fs.writeFile(argsPath, JSON.stringify(args), 'utf-8')

    try {
      const { stdout } = await execFileAsync(
        python.command,
        [
          ...python.argsPrefix,
          runnerPath,
          '--file',
          moduleAbs,
          '--function',
          tool.name,
          '--args',
          argsPath,
        ],
        { timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: resolveLabDir(labId) },
      )
      const payload = parseLastJsonLine(stdout) as
        | { ok?: boolean; result?: unknown; error?: string }
        | null
      audit.exitCode = 0
      if (!payload) {
        audit.error = '执行器输出不可解析'
        return { ok: false, error: audit.error, elapsedMs: Date.now() - startedAt }
      }
      audit.ok = payload.ok === true
      audit.result = payload.result
      audit.error = payload.error
      return {
        ok: audit.ok,
        result: payload.result,
        error: payload.error,
        elapsedMs: Date.now() - startedAt,
      }
    } finally {
      await fs.rm(argsPath, { force: true }).catch(() => undefined)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    audit.error = message
    const exitCode = (error as { code?: unknown }).code
    if (typeof exitCode === 'number') audit.exitCode = exitCode
    return {
      ok: false,
      error: message,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    // 无论成功失败都记账；非法 labId 无法定位审计目录时跳过。
    let labId: string | undefined
    try {
      labId = assertLabId(input.labId)
    } catch {
      labId = undefined
    }
    if (labId) {
      await appendCsLabToolAudit({
        labId,
        sessionId: auditContext.sessionId,
        source: auditContext.source,
        permissionMode: auditContext.permissionMode,
        moduleRelPath: audit.moduleRelPath,
        function: input.name,
        args: input.args,
        ok: audit.ok,
        exitCode: audit.exitCode,
        elapsedMs: Date.now() - startedAt,
        result: audit.result,
        error: audit.error,
      })
    }
  }
}

// ===== 工具目录监听 =====

interface ToolWatcherHandle {
  close: () => Promise<void>
}

const toolWatchers = new Map<string, ToolWatcherHandle>()

export async function startLabToolWatcher(
  labIdInput: string,
  onChange: (scan: CsLabCustomToolScan) => void,
): Promise<{ watching: boolean; message: string }> {
  const labId = assertLabId(labIdInput)
  if (toolWatchers.has(labId)) return { watching: true, message: '监听已开启' }

  const toolsDir = resolveLabRelativePath(labId, 'runtime/tools')
  await fs.mkdir(toolsDir, { recursive: true })

  try {
    const module = (await import('chokidar')) as unknown as {
      watch?: (paths: string[], options: Record<string, unknown>) => {
        on(event: 'add' | 'change' | 'unlink', handler: (path: string) => void): unknown
        on(event: 'error', handler: (error: unknown) => void): unknown
        close(): Promise<void> | void
      }
      default?: { watch?: (paths: string[], options: Record<string, unknown>) => never }
    }
    const watch = module.watch ?? (module.default?.watch as typeof module.watch)
    if (!watch) return { watching: false, message: 'Chokidar 不可用' }

    const watcher = watch([toolsDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 },
      ignorePermissionErrors: true,
    })

    let pending: Promise<void> = Promise.resolve()
    const flush = createDebouncer(
      () => {
        pending = pending
          .then(async () => {
            const scan = await scanLabTools(labId)
            onChange(scan)
          })
          .catch((error: unknown) => {
            console.warn('[CSLab] 工具重新扫描失败:', error)
          })
      },
      300,
      1500,
    )

    const handler = (absolute: string): void => {
      if (!absolute.endsWith('.py')) return
      flush()
    }

    watcher.on('add', handler)
    watcher.on('change', handler)
    watcher.on('unlink', handler)
    watcher.on('error', (error) => console.warn('[CSLab] 工具 watcher 错误:', error))

    toolWatchers.set(labId, {
      close: async () => {
        flush.cancel()
        await watcher.close()
      },
    })
    return { watching: true, message: '已监听 runtime/tools' }
  } catch (error) {
    console.warn('[CSLab] 启动工具 watcher 失败:', error)
    return { watching: false, message: '无法启动工具监听' }
  }
}

export async function stopLabToolWatcher(
  labIdInput: string,
): Promise<{ watching: boolean; message: string }> {
  const labId = assertLabId(labIdInput)
  const active = toolWatchers.get(labId)
  if (!active) return { watching: false, message: '监听未开启' }
  toolWatchers.delete(labId)
  try {
    await active.close()
    return { watching: false, message: '监听已停止' }
  } catch {
    return { watching: false, message: '监听已停止（关闭句柄时出现异常）' }
  }
}

export async function closeAllLabToolWatchers(): Promise<void> {
  for (const [labId, active] of [...toolWatchers.entries()]) {
    toolWatchers.delete(labId)
    try {
      await active.close()
    } catch {
      // 进程退出路径，忽略。
    }
  }
}
