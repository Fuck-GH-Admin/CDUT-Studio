/**
 * Agent 工作区沙盒守卫单元测试（Bug 19）
 *
 * 覆盖：读宽松 / 写严控判定、敏感目录硬拒绝、`..` 穿透、符号链接穿透、
 * 8.3 短文件名与大小写归一化、命令路径抽取、剪贴板读取命令硬拦截、工具级分流。
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  detectClipboardReadCommand,
  evaluatePathAccess,
  evaluateToolSandbox,
  extractPathTokens,
  isWithin,
  resolveSandboxContext,
  toRealPath,
} from './cslab-sandbox-guard'

let root = ''
let workspaceRoot = ''
let sessionDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cslab-sandbox-'))
  workspaceRoot = join(root, 'agent-workspaces', 'default')
  sessionDir = join(workspaceRoot, 'sess-1')
  mkdirSync(join(sessionDir, 'sub'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'workspace-files'), { recursive: true })
  mkdirSync(join(root, 'outside'), { recursive: true })
  mkdirSync(join(root, 'outside', '.ssh'), { recursive: true })
  writeFileSync(join(sessionDir, 'a.txt'), 'x', 'utf-8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ctx = (): { sessionDir: string; workspaceRoot: string } => resolveSandboxContext(workspaceRoot, 'sess-1')

describe('isWithin / toRealPath', () => {
  test('Given 目标在根内 Then 判定为归属', () => {
    expect(isWithin(workspaceRoot, sessionDir)).toBe(true)
    expect(isWithin(workspaceRoot, join(sessionDir, 'a.txt'))).toBe(true)
    expect(isWithin(sessionDir, sessionDir)).toBe(true)
  })

  test('Given 目标在根外 Then 判定为不归属', () => {
    expect(isWithin(workspaceRoot, join(root, 'outside'))).toBe(false)
  })

  test('Given .. 穿透路径 Then 归一化后仍判定为不归属', () => {
    const traversal = join(sessionDir, '..', '..', '..', 'outside', 'x.txt')
    expect(isWithin(workspaceRoot, traversal)).toBe(false)
  })

  test('Given 符号链接指向沙盒外 Then realpath 展开后判定为不归属', () => {
    const linkPath = join(sessionDir, 'escape-link')
    try {
      symlinkSync(join(root, 'outside'), linkPath, 'junction')
    } catch {
      // 无符号链接权限
    }
    // Windows 关闭开发者模式/受企业策略限制时 symlinkSync 会静默产生悬空链接，
    // 此时绝不能给出错误断言——只有链接真实可用才验证穿透拦截。
    if (!existsSync(linkPath)) return
    expect(isWithin(workspaceRoot, toRealPath(linkPath))).toBe(false)
    expect(evaluatePathAccess({ path: linkPath, access: 'write', ...ctx() }).action).toBe('confirm')
  })

  test('Given 目标尾段尚不存在 Then realpath 展宽到已存在祖先后仍判定归属', () => {
    // 与符号链接展开共用同一条「最深已存在祖先 realpath」代码路径（R1）。
    const future = join(sessionDir, 'not-yet', 'deep', 'file.md')
    expect(toRealPath(future)).toBe(join(toRealPath(sessionDir), 'not-yet', 'deep', 'file.md'))
    expect(isWithin(workspaceRoot, future)).toBe(true)
    expect(isWithin(workspaceRoot, join(root, 'outside', 'not-yet', 'x.md'))).toBe(false)
  })

  test('Given 大小写不同的同一条路径 Then Windows 下判定为归属', () => {
    const upper = workspaceRoot.toUpperCase()
    if (process.platform === 'win32') {
      expect(isWithin(upper, sessionDir)).toBe(true)
    } else {
      expect(isWithin(workspaceRoot, sessionDir)).toBe(true)
    }
  })
})

describe('evaluatePathAccess', () => {
  test('Given session 内路径 Then 读写皆放行', () => {
    const p = join(sessionDir, 'sub', 'out.md')
    expect(evaluatePathAccess({ path: p, access: 'read', ...ctx() }).action).toBe('allow')
    expect(evaluatePathAccess({ path: p, access: 'write', ...ctx() }).action).toBe('allow')
  })

  test('Given workspace-files 内路径 Then 读放行 / 写需确认', () => {
    const p = join(workspaceRoot, 'workspace-files', 'note.md')
    expect(evaluatePathAccess({ path: p, access: 'read', ...ctx() }).action).toBe('allow')
    const write = evaluatePathAccess({ path: p, access: 'write', ...ctx() })
    expect(write.action).toBe('confirm')
  })

  test('Given 沙盒外普通路径 Then 读放行 / 写需确认', () => {
    const p = join(root, 'outside', 'report.csv')
    expect(evaluatePathAccess({ path: p, access: 'read', ...ctx() }).action).toBe('allow')
    expect(evaluatePathAccess({ path: p, access: 'write', ...ctx() }).action).toBe('confirm')
  })

  test('Given ~/.ssh 密钥目录 Then 读写皆硬拒绝', () => {
    const p = join(root, 'outside', '.ssh', 'id_rsa')
    expect(evaluatePathAccess({ path: p, access: 'read', ...ctx() }).action).toBe('deny')
    expect(evaluatePathAccess({ path: p, access: 'write', ...ctx() }).action).toBe('deny')
  })

  test('Given 其他会话目录 Then 读需确认', () => {
    const p = join(workspaceRoot, 'sess-2', 'a.txt')
    mkdirSync(join(workspaceRoot, 'sess-2'), { recursive: true })
    const verdict = evaluatePathAccess({ path: p, access: 'read', ...ctx() })
    expect(verdict.action).toBe('confirm')
  })

  test('Given 空路径 Then 放行', () => {
    expect(evaluatePathAccess({ path: '  ', access: 'write', ...ctx() }).action).toBe('allow')
  })
})

describe('detectClipboardReadCommand', () => {
  test('Given 剪贴板读取命令 Then 命中并返回手段名', () => {
    expect(detectClipboardReadCommand('Get-Clipboard')).not.toBeNull()
    expect(detectClipboardReadCommand('pbpaste | head')).not.toBeNull()
    expect(detectClipboardReadCommand('xclip -selection clipboard -o')).not.toBeNull()
    expect(detectClipboardReadCommand('xsel --output --clipboard')).not.toBeNull()
    expect(detectClipboardReadCommand('wl-paste')).not.toBeNull()
    expect(detectClipboardReadCommand('python -c "import pyperclip; print(pyperclip.paste())"')).not.toBeNull()
    expect(detectClipboardReadCommand("osascript -e 'the clipboard'")).not.toBeNull()
  })

  test('Given 普通命令 Then 不误判', () => {
    expect(detectClipboardReadCommand('ls -la')).toBeNull()
    expect(detectClipboardReadCommand('grep -r foo ./src')).toBeNull()
  })
})

describe('extractPathTokens', () => {
  test('Given 含绝对路径的命令 Then 抽出路径 token', () => {
    const tokens = extractPathTokens(`cat ${join(root, 'outside', 'a.txt')}`)
    expect(tokens.length).toBeGreaterThan(0)
  })

  test('Given 含 ../ 穿透的命令 Then 抽出穿透段', () => {
    const tokens = extractPathTokens('cat ../../../etc/passwd')
    expect(tokens.some((t) => t.includes('..'))).toBe(true)
  })
})

describe('evaluateToolSandbox', () => {
  test('Given Write 到沙盒外 Then 返回 confirm', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Write',
      toolInput: { file_path: join(root, 'outside', 'leak.md'), content: 'x' },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('confirm')
  })

  test('Given Read 沙盒外普通文件 Then 放行（读宽松）', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Read',
      toolInput: { file_path: join(root, 'outside', 'report.csv') },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('allow')
  })

  test('Given Bash 读剪贴板 Then 硬拒绝', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Bash',
      toolInput: { command: 'Get-Clipboard' },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('deny')
  })

  test('Given Bash 写入沙盒外 Then confirm', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Bash',
      toolInput: { command: `echo hi > ${join(root, 'outside', 'out.txt')}` },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('confirm')
  })

  test('Given Bash 只读列举 Then 放行', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('allow')
  })

  test('Given Bash 写入 session 内 Then 放行', () => {
    const verdict = evaluateToolSandbox({
      toolName: 'Bash',
      toolInput: { command: `echo hi > ${join(sessionDir, 'out.txt')}` },
      ctx: ctx(),
    })
    expect(verdict.action).toBe('allow')
  })
})

describe('resolveSandboxContext', () => {
  test('Given 工作区根与 sessionId Then sessionDir 落在其下', () => {
    const c = resolveSandboxContext(workspaceRoot, 'sess-1')
    expect(resolve(c.sessionDir)).toBe(resolve(join(workspaceRoot, 'sess-1')))
    expect(isWithin(c.workspaceRoot, c.sessionDir)).toBe(true)
  })
})
