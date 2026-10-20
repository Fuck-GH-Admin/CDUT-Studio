/**
 * CSLab 可选 Python 增强通道
 *
 * 红线：Python 永远不是主路径。所有核心能力均有 TS 实现；
 * 这里只负责在检测到 python/uv 时处理 MAT v7.3、BioLogic .mpr 等
 * 纯 TS 难以覆盖的变体。任何失败都必须安静降级，不阻断摄取。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CsLabPythonCapability } from '@profer/shared'
import { buildDataset, type ParsedDataset } from './cslab-formats/types'

const execFileAsync = promisify(execFile)

interface PythonProbe {
  capability: CsLabPythonCapability
  pythonCommand?: string
  scriptPath?: string
}

let cachedProbe: Promise<PythonProbe> | null = null

function resolveExtractorScript(): string | undefined {
  const candidates: string[] = []
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'cslab', 'cslab-instrument-extractor.py'))
  candidates.push(join(__dirname, '..', 'resources', 'cslab', 'cslab-instrument-extractor.py'))
  candidates.push(join(__dirname, '..', '..', 'resources', 'cslab', 'cslab-instrument-extractor.py'))
  candidates.push(join(process.cwd(), 'apps', 'electron', 'resources', 'cslab', 'cslab-instrument-extractor.py'))
  return candidates.find((candidate) => existsSync(candidate))
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 2500, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function probePython(): Promise<PythonProbe> {
  const scriptPath = resolveExtractorScript()

  const candidates =
    process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version']
    if (await commandWorks(command, args)) {
      const uvPath = (await commandWorks('uv', ['--version'])) ? 'uv' : undefined
      return {
        capability: {
          available: !!scriptPath,
          pythonPath: command,
          uvPath,
          note: scriptPath
            ? `已检测到 ${command}${uvPath ? ' 与 uv' : ''}；可处理 MAT v7.3 / BioLogic .mpr 等增强格式`
            : `已检测到 ${command}，但缺少 cslab-instrument-extractor.py，增强通道不可用`,
        },
        pythonCommand: command,
        scriptPath,
      }
    }
  }

  return {
    capability: {
      available: false,
      note: '未检测到 Python；MAT v7.3 / BioLogic .mpr 将仅登记元数据（不生成伪造数据）',
    },
  }
}

export function getPythonCapability(): Promise<CsLabPythonCapability> {
  if (!cachedProbe) cachedProbe = probePython()
  return cachedProbe.then((probe) => probe.capability)
}

export function __resetPythonProbeForTest(): void {
  cachedProbe = null
}

interface PythonDatasetPayload {
  ok: boolean
  message?: string
  xLabel?: string
  xUnit?: string
  series?: Array<{ label: string; unit?: string; values: number[] }>
  x?: number[]
  metadata?: Record<string, string>
}

/**
 * 尝试用 Python 增强脚本解析文件；不可用或失败时返回 null。
 */
export async function tryParseWithPython(
  filePath: string,
  format: 'mat-v73' | 'biologic-mpr',
): Promise<ParsedDataset | null> {
  if (!cachedProbe) cachedProbe = probePython()
  const probe = await cachedProbe
  if (!probe.capability.available || !probe.pythonCommand || !probe.scriptPath) return null

  try {
    const { stdout } = await execFileAsync(
      probe.pythonCommand,
      [probe.scriptPath, '--input', filePath, '--format', format],
      { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    const payload = JSON.parse(stdout) as PythonDatasetPayload
    if (!payload.ok || !Array.isArray(payload.x) || !Array.isArray(payload.series)) return null

    return buildDataset({
      format,
      xLabel: payload.xLabel ?? 'X',
      xUnit: payload.xUnit,
      seriesLabels: payload.series.map((item) => ({ label: item.label, unit: item.unit })),
      x: payload.x,
      series: payload.series.map((item) => item.values),
      metadata: payload.metadata,
    })
  } catch (error) {
    console.warn(`[CSLab] Python 增强解析失败（${format}），已降级:`, error)
    return null
  }
}
