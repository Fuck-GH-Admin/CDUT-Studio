/**
 * 公式验算依赖内置（Bug 3）单元测试
 *
 * 覆盖：vendor/antlr4 目录结构完整性（含 dist-info 元数据）、
 * requirements/formula.txt 不得再声明 antlr4、
 * formula profile 的模块构成、脚本入口注入 vendor 的代码存在性。
 *
 * 重点：`.dist-info` 一旦丢失，SymPy 的
 * `version('antlr4-python3-runtime')` 断言会抛 PackageNotFoundError，
 * 整个内置方案**静默失效**——本测试把该结构锁死。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCsLabResourceDir, resolveCsLabScript } from './cslab-python-runtime'

const VENDOR_DIR = resolveCsLabResourceDir('vendor')

function readVendorFile(...segments: string[]): string | null {
  if (!VENDOR_DIR) return null
  const path = join(VENDOR_DIR, ...segments)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

describe('vendor/antlr4 结构完整性', () => {
  test('Given 随包资源 Then vendor 目录可定位', () => {
    expect(VENDOR_DIR).toBeDefined()
  })

  test('Given vendor/antlr4 Then 是完整包目录而非平铺子模块', () => {
    expect(VENDOR_DIR).toBeDefined()
    const initPath = join(VENDOR_DIR!, 'antlr4', '__init__.py')
    expect(existsSync(initPath)).toBe(true)
  })

  test('Given vendor/antlr4 Then 含 ANTLR 运行时必需子包', () => {
    for (const sub of ['atn', 'dfa', 'error', 'tree', 'xpath']) {
      expect(existsSync(join(VENDOR_DIR!, 'antlr4', sub))).toBe(true)
    }
  })

  test('Given dist-info 元数据 Then importlib.metadata 可解析版本 4.11.x', () => {
    const metadata = readVendorFile('antlr4_python3_runtime-4.11.1.dist-info', 'METADATA')
    expect(metadata).not.toBeNull()
    expect(metadata!).toContain('Name: antlr4-python3-runtime')
    expect(metadata!).toMatch(/Version: 4\.11\./)
  })

  test('Given dist-info 目录 Then 许可证随包保留', () => {
    const licenseText = readVendorFile('LICENSE.txt')
    expect(licenseText).not.toBeNull()
    expect(licenseText!).toContain('Redistribution and use in source and binary forms')
    expect(readVendorFile('VENDOR.md')).not.toBeNull()
  })

  test('Given formula 依赖清单 Then 不再声明 antlr4-python3-runtime', () => {
    const requirements = resolveCsLabScript('requirements/formula.txt')
    // resolveCsLabScript 只定位单文件；直接按资源目录读取。
    const content = readVendorFile('..', 'requirements', 'formula.txt')
      ?? (requirements ? readFileSync(requirements, 'utf-8') : null)
    expect(content).not.toBeNull()
    const declared = content!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(declared.some((line) => /^antlr4-python3-runtime/.test(line))).toBe(false)
    expect(declared.some((line) => /^sympy/.test(line))).toBe(true)
  })
})

describe('formula profile 与脚本入口', () => {
  test('Given formula 脚本 Then 入口把 vendor 前置到 sys.path', () => {
    const scriptPath = resolveCsLabScript('cslab-formula-verifier.py')
    expect(scriptPath).toBeDefined()
    const source = readFileSync(scriptPath!, 'utf-8')
    expect(source).toContain('_VENDOR_DIR')
    expect(source).toContain('sys.path.insert(0, _VENDOR_DIR)')
  })

  test('Given formula 脚本 Then 入口强制 UTF-8 标准流', () => {
    const scriptPath = resolveCsLabScript('cslab-formula-verifier.py')
    const source = readFileSync(scriptPath!, 'utf-8')
    expect(source).toContain('sys.stdout.reconfigure(encoding="utf-8")')
    expect(source).toContain('sys.stderr.reconfigure(encoding="utf-8")')
  })

  test('Given 所有 cslab Python 脚本 Then 均强制 UTF-8 标准流', () => {
    for (const name of [
      'cslab-formula-verifier.py',
      'cslab-plot-digitizer.py',
      'cslab-tool-scanner.py',
      'cslab-tool-runner.py',
      'cslab-docling-extractor.py',
      'cslab-geohazard-solver.py',
      'cslab-instrument-extractor.py',
    ]) {
      const path = resolveCsLabScript(name)
      expect(path, `${name} 应随包分发`).toBeDefined()
      const source = readFileSync(path!, 'utf-8')
      expect(source, `${name} 缺少 UTF-8 标准流治理`).toContain('reconfigure(encoding="utf-8")')
    }
  })
})
