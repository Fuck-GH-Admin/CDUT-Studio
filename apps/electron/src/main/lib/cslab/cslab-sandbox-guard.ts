/**
 * Agent 工作区沙盒越界守卫（Bug 19）
 *
 * 策略：**读宽松 / 写严控**。
 * - 读取 workspace root 与其 workspace-files 放行；
 * - 向沙盒外写入，或触碰敏感位置（家目录根 / ~/.ssh / 其他会话目录 / 系统目录）一律需用户授权；
 * - 读取系统剪贴板是硬红线，任何手段都直接拒绝。
 *
 * 路径判定红线（R1）：
 * 1. 先 `path.resolve()` 归一化；
 * 2. 对**最深已存在祖先目录**做 `fs.realpathSync.native()`，展开符号链接与 8.3 短文件名，再拼回剩余段；
 * 3. Windows 下大小写折叠后再比较；
 * 4. 前缀比较一律用 `path.relative()` + `..` 断言，**绝不用字符串 startsWith**。
 *
 * 命令侧的路径抽取本质是启发式，可能漏判；因此 prompt 层已注入硬红线
 * （agent-prompt-builder.ts 的 SECURITY_GUARDRAILS_BLOCK）作为纵深防御。
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalAgentToolName } from '@profer/shared'

export type SandboxAccess = 'read' | 'write'

export interface SandboxContext {
  /** 最小沙盒：`~/.cdutai/agent-workspaces/{slug}/{sessionId}` */
  sessionDir: string
  /** 工作区根：`~/.cdutai/agent-workspaces/{slug}` */
  workspaceRoot: string
}

export type SandboxVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'confirm'; target: string; access: SandboxAccess; reason: string }

/** 直接拒绝的敏感位置（读写皆禁，不给授权机会）。 */
const HARD_DENY_SEGMENTS = [
  join('.ssh'),
  join('.aws'),
  join('.gnupg'),
  join('.docker'),
]

/** 需要授权确认的敏感位置（读写皆需确认）。 */
const CONFIRM_ON_READ_SEGMENTS = [join('.cdutai'), join('.config'), '.git']

/**
 * 工作区根下的跨会话共享条目（读放行）。
 * 除这些之外的直接子目录默认视为**其他会话目录**，读取需授权。
 */
const SHARED_WORKSPACE_ENTRIES = new Set([
  'workspace-files',
  '.cdutai',
  'skills',
  'workspace-profile.md',
  'CLAUDE.md',
  'mcp.json',
  'agent-presets.json',
])

/** 大小写折叠：Windows 路径大小写不敏感，必须折叠后再比较。 */
function foldCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * 展开到真实物理路径。
 * 不存在的目标取「最深已存在祖先」做 realpath，再把剩余相对段拼回去，
 * 从而同时消除符号链接穿透与 8.3 短文件名歧义。
 */
export function toRealPath(input: string): string {
  const resolved = resolve(input)
  let current = resolved
  const tail: string[] = []
  // 最多回溯 64 层，避免异常输入导致死循环。
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(current)) {
      try {
        const real = realpathSync.native(current)
        return tail.length > 0 ? join(real, ...tail.reverse()) : real
      } catch {
        return resolved
      }
    }
    const parent = dirname(current)
    if (parent === current) return resolved
    tail.push(current.slice(parent.length + 1))
    current = parent
  }
  return resolved
}

/**
 * 前缀归属判定。
 *
 * 两侧都过 `toRealPath`：Windows 下 `tmpdir()` 常返回 8.3 短名、
 * 符号链接与大小写混用，只有两侧都展开为真实物理路径后比较才可靠。
 * 用 `path.relative` + `..` 断言，天然免疫 `..` 穿透与大小写差异。
 */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(foldCase(toRealPath(root)), foldCase(toRealPath(target)))
  if (!rel) return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 归一化用于去重与展示的路径。 */
function displayPath(input: string): string {
  return resolve(input).replace(/\//g, sep)
}

/**
 * 判定单个路径的访问权限。
 *
 * | 场景 | access | 结果 |
 * |---|---|---|
 * | 位于 sessionDir 内 | 任意 | allow |
 * | 位于 workspaceRoot 内 | read | allow |
 * | 位于 workspaceRoot 内 | write | confirm |
 * | 命中硬拒绝目录（~/.ssh 等） | 任意 | deny |
 * | 其他会话目录 / 系统目录 / 家目录根 | 任意 | confirm |
 * | 其他路径 | read | allow |
 * | 其他路径 | write | confirm |
 */
export function evaluatePathAccess(input: {
  path: string
  access: SandboxAccess
  sessionDir: string
  workspaceRoot: string
}): SandboxVerdict {
  const raw = input.path?.trim()
  if (!raw) return { action: 'allow' }

  const real = toRealPath(raw)
  const folded = foldCase(real)

  for (const segment of HARD_DENY_SEGMENTS) {
    if (folded.includes(foldCase(sep + segment + sep)) || folded.endsWith(foldCase(sep + segment))) {
      return { action: 'deny', reason: `访问密钥目录被禁止：${segment}` }
    }
  }

  const inSession = isWithin(input.sessionDir, real)
  if (inSession) return { action: 'allow' }

  const inWorkspace = isWithin(input.workspaceRoot, real)
  if (inWorkspace) {
    // 工作区内但不在本会话目录：区分跨会话共享条目与其他会话目录。
    const rel = relative(foldCase(toRealPath(input.workspaceRoot)), foldCase(real))
    const head = rel.split(sep)[0] ?? ''
    // head 来自大小写折叠后的 rel，条目同样折叠后比较，保证 Windows 下命中。
    const isShared = [...SHARED_WORKSPACE_ENTRIES].some((entry) => foldCase(entry) === head)
    if (input.access === 'read') {
      if (isShared) return { action: 'allow' }
      return {
        action: 'confirm',
        target: displayPath(raw),
        access: 'read',
        reason: '读取其他会话目录需要授权',
      }
    }
    return {
      action: 'confirm',
      target: displayPath(raw),
      access: 'write',
      reason: isShared
        ? '向工作区共享目录写入需要授权'
        : '向其他会话目录写入需要授权',
    }
  }

  // 读操作默认放行，除非落在需要确认的敏感目录树内。
  if (input.access === 'read') {
    for (const segment of CONFIRM_ON_READ_SEGMENTS) {
      if (folded.includes(foldCase(sep + segment + sep))) {
        return {
          action: 'confirm',
          target: displayPath(raw),
          access: 'read',
          reason: `读取敏感目录 ${segment} 需要授权`,
        }
      }
    }
    return { action: 'allow' }
  }

  return {
    action: 'confirm',
    target: displayPath(raw),
    access: 'write',
    reason: '向工作区外写入需要授权',
  }
}

// ===== 命令侧启发式抽取 =====

/** 明确产生写副作用的文件工具；其余按读处理，保持「读宽松」。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** 命令中显式写操作的特征（用于区分 read / write）。 */
const WRITE_HINT_RE =
  /(?<![0-9&])>|\b(rm|rmdir|mv|cp|mkdir|touch|mktemp|chmod|chown|chattr|truncate|tee|install|dd)\s|\bsed\s+[^|&;]*-i\b|\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b|\bpip[23]?\s+(install|uninstall|upgrade)\b|\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b|\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)|\b(node|python[23]?|ruby|perl|php)\s+[^-]/

/** 从命令文本中抽取路径形态的 token（Windows 绝对 / POSIX 绝对 / ~/ / ../ 穿透）。 */
export function extractPathTokens(command: string): string[] {
  const found = new Set<string>()
  const patterns: RegExp[] = [
    /[A-Za-z]:[\\/][^\s"'<>|;`]*/g,
    /~\/[^\s"'<>|;`]*/g,
    /(?:^|[\s"'=(])((?:\/(?:home|Users|tmp|var|etc|opt|root|mnt|srv|proc|sys|dev)[^\s"'<>|;`]*))/g,
    /(?:^|[\s"'=(])((?:\.\.[\\/])+[^\s"'<>|;`]*)/g,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const token = (match[1] ?? match[0]).trim()
      if (token.length > 1) found.add(token)
    }
  }
  return [...found]
}

/**
 * 剪贴板读取命令检测（硬红线）。
 * 命中返回说明文案，未命中返回 null。
 */
export function detectClipboardReadCommand(command: string): string | null {
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bGet-Clipboard\b/i, label: 'PowerShell Get-Clipboard' },
    { re: /\bpbpaste\b/i, label: 'macOS pbpaste' },
    { re: /\bxclip\b[^|;&]*\s(-o|--out)\b/i, label: 'xclip -o' },
    { re: /\bxsel\b[^|;&]*\s(-o|--output)\b/i, label: 'xsel --output' },
    { re: /\bwl-paste\b/i, label: 'Wayland wl-paste' },
    { re: /\bclip\.exe\b/i, label: 'Windows clip.exe 读取' },
    { re: /osascript[^|;&]*clipboard/i, label: 'AppleScript clipboard' },
    { re: /\bpyperclip\.paste\b/i, label: 'Python pyperclip.paste' },
    { re: /\btkinter\b[^|;&]*clipboard_get/i, label: 'Tkinter clipboard_get' },
  ]
  for (const item of patterns) {
    if (item.re.test(command)) return item.label
  }
  return null
}

/** 供测试与调用方复用的路径上下文解析。 */
export function resolveSandboxContext(
  workspaceRoot: string,
  sessionId: string,
): SandboxContext {
  return {
    workspaceRoot: resolve(workspaceRoot),
    sessionDir: resolve(join(workspaceRoot, sessionId)),
  }
}

/**
 * 对一次工具调用做沙盒判定。
 * 返回 `allow` / `deny` / `confirm`，其中 `confirm` 交由上层走用户授权流程。
 */
export function evaluateToolSandbox(input: {
  toolName: string
  toolInput: Record<string, unknown>
  ctx: SandboxContext
}): SandboxVerdict {
  const { toolName, toolInput, ctx } = input
  const command =
    typeof toolInput.command === 'string' ? toolInput.command : undefined

  // 1) 剪贴板读取：硬拒绝，任何 shell 命令形态都拦。
  if (command) {
    const hit = detectClipboardReadCommand(command)
    if (hit) {
      return {
        action: 'deny',
        reason: `CLIPBOARD_READ_BLOCKED: 禁止通过 ${hit} 读取系统剪贴板。剪贴板内容只能由用户显式粘贴提供。`,
      }
    }
  }

  // 2) 命令工具：抽取路径 token，按 read/write 分别判定。
  if (command) {
    const access: SandboxAccess = WRITE_HINT_RE.test(command) ? 'write' : 'read'
    for (const token of extractPathTokens(command)) {
      const verdict = evaluatePathAccess({ path: token, access, ...ctx })
      if (verdict.action !== 'allow') return verdict
    }
    return { action: 'allow' }
  }

  // 3) 文件工具：按工具语义区分读/写，读取保持宽松。
  const access: SandboxAccess = WRITE_TOOLS.has(canonicalAgentToolName(toolName)) ? 'write' : 'read'
  const targetPath =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.notebook_path === 'string'
        ? toolInput.notebook_path
        : typeof toolInput.path === 'string'
          ? toolInput.path
          : undefined
  if (targetPath) {
    return evaluatePathAccess({ path: targetPath, access, ...ctx })
  }

  return { action: 'allow' }
}
