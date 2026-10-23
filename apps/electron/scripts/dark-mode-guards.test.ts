/**
 * 深色模式静态守卫
 *
 * 目的：把「硬编码白底/黑字、低不透明度文字、暗色 Logo 死代码」挡在提交前。
 * 纯文件扫描，不引入额外依赖；豁免必须在注释里写明原因。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dir, '..')
const RENDERER_ROOT = join(APP_ROOT, 'src/renderer')
const UI_ROOT = resolve(APP_ROOT, '../../packages/ui/src')
const MODELS_DIR = join(APP_ROOT, 'src/renderer/assets/models')
const MODEL_LOGO_FILE = join(APP_ROOT, 'src/renderer/lib/model-logo.ts')

/** 单行/上一行豁免注释：原因必填 */
const IGNORE_MARKER = 'dark-guard-ignore:'
const IGNORE_WITH_REASON = /dark-guard-ignore:\s*\S+/

/** 规则一文件级白名单：白色是设计意图，不能改成主题色 */
const BG_WHITE_ALLOWLIST = new Map<string, string>([
  ['src/renderer/components/settings/FeishuSettings.tsx', '二维码需要纯白底保证识别率'],
  ['src/renderer/components/settings/WeChatSettings.tsx', '二维码需要纯白底保证识别率'],
  ['src/renderer/components/onboarding/FeatureTour.tsx', '固定深色遮罩上的白色 CTA'],
])

interface Violation {
  file: string
  line: number
  rule: string
  detail: string
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'public') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

function toRepoPath(file: string): string {
  return relative(APP_ROOT, file).replaceAll('\\', '/')
}

/** 命中行或上一行是否带合法豁免注释 */
function hasIgnore(lines: string[], index: number, violations: Violation[], file: string, lineNo: number): boolean {
  const current = lines[index] ?? ''
  const previous = lines[index - 1] ?? ''
  const markerLine = current.includes(IGNORE_MARKER) ? current : previous.includes(IGNORE_MARKER) ? previous : null
  if (!markerLine) return false
  if (!IGNORE_WITH_REASON.test(markerLine)) {
    violations.push({ file, line: lineNo, rule: 'ignore-reason', detail: 'dark-guard-ignore 必须写明原因' })
  }
  return true
}

/** 在命中行附近窗口内寻找 dark: 变体（兼容多行 className） */
function hasDarkVariantNearby(lines: string[], index: number): boolean {
  const window = lines.slice(Math.max(0, index - 2), index + 4).join('\n')
  return /\bdark:/.test(window)
}

describe('深色模式守卫：硬编码白底与黑字', () => {
  test('bg-white / text-black 必须提供 dark: 变体或白名单豁免', () => {
    const violations: Violation[] = []
    for (const file of [...walk(RENDERER_ROOT), ...walk(UI_ROOT)]) {
      const rel = toRepoPath(file)
      const allowReason = BG_WHITE_ALLOWLIST.get(rel)
      if (allowReason) continue
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        const hit = /\bbg-white\b(?![/\w-])/.test(line) || /\btext-black\b/.test(line)
        if (!hit) return
        if (hasIgnore(lines, index, violations, rel, index + 1)) return
        if (hasDarkVariantNearby(lines, index)) return
        violations.push({
          file: rel,
          line: index + 1,
          rule: 'bare-white',
          detail: '缺少 dark: 变体（二维码/固定深色遮罩请加白名单）',
        })
      })
    }
    expect(violations).toEqual([])
  })
})

describe('深色模式守卫：低对比文字', () => {
  test('禁止 text-foreground/20 与 /30 级别的弱化文字', () => {
    const violations: Violation[] = []
    const pattern = /\btext-(?:foreground|muted-foreground)\/(?:20|30)\b/
    for (const file of [...walk(RENDERER_ROOT), ...walk(UI_ROOT)]) {
      const rel = toRepoPath(file)
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return
        if (hasIgnore(lines, index, violations, rel, index + 1)) return
        violations.push({
          file: rel,
          line: index + 1,
          rule: 'low-contrast-text',
          detail: '不透明度低于 45%，深色下不满足 WCAG AA',
        })
      })
    }
    expect(violations).toEqual([])
  })
})

describe('深色模式守卫：暗色模型图标', () => {
  test('每个导入的 *_dark.png 都必须注册进暗色映射表', () => {
    const source = readFileSync(MODEL_LOGO_FILE, 'utf8')
    const importRe = /import\s+(\w+)\s+from\s+['"][^'"]*_dark\.png['"]/g
    const violations: string[] = []
    for (const match of source.matchAll(importRe)) {
      const symbol = match[1]!
      const total = source.match(new RegExp(`\\b${symbol}\\b`, 'g'))?.length ?? 0
      // 至少出现两次：import 声明 + 暗色映射表引用
      if (total < 2) violations.push(symbol)
    }
    expect(violations).toEqual([])
  })

  test('每个 *_dark.png 资源都存在同名亮色资源', () => {
    const files = readdirSync(MODELS_DIR)
    /** 亮色侧按型号拆分、没有同名基准图的暗色资源 */
    const lightAliasExceptions = new Map<string, string>([
      ['gpt_dark.png', '亮色侧使用 gpt_3.5.png / gpt_4.png / gpt_o1.png 等型号图'],
    ])
    const orphans = files
      .filter((name) => name.endsWith('_dark.png'))
      .filter((name) => !lightAliasExceptions.has(name))
      .filter((name) => !files.includes(name.replace(/_dark\.png$/, '.png')))
    expect(orphans).toEqual([])
  })
})
