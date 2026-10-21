/**
 * CSLab 实验室私有 Python 运行时
 *
 * 评审加固 11.2：虚拟环境可执行文件路径必须平台感知，
 * Windows 为 `.venv/Scripts/python.exe`，POSIX 为 `.venv/bin/python`。
 *
 * 红线：
 * 1. 一键安装只写入实验室 `runtime/.venv`，绝不修改全局 Python；
 * 2. 依赖缺失时如实返回 missing，不伪造 installed；
 * 3. 所有外部命令均设置超时与 windowsHide。
 */

import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  CsLabToolDepsProgress,
  CsLabToolProfile,
  CsLabToolProfileStatus,
  CsLabToolRuntimeStatus,
} from '@profer/shared'
import { assertLabId, resolveLabDir } from './cslab-paths'
import { ensureUvBinary } from './cslab-uv'
import { confirmUvUntrustedInstall } from './cslab-uv-consent'

const execFileAsync = promisify(execFile)

const PROFILE_MODULES: Record<CsLabToolProfile, string[]> = {
  plot: ['numpy', 'cv2', 'skimage', 'scipy'],
  // SymPy 的 LaTeX 解析依赖 antlr4；缺失时只能退化为 sympify 纯 ASCII 表达式。
  formula: ['sympy', 'antlr4'],
  'formula-ocr': ['pix2text'],
  instrument: ['h5py', 'yadg', 'eclabfiles'],
}

const PROFILE_LABELS: Record<CsLabToolProfile, string> = {
  plot: '图表数字化（numpy / OpenCV / scikit-image / SciPy）',
  formula: '公式验算（SymPy + antlr4 LaTeX 解析）',
  'formula-ocr': '公式 OCR（Pix2Text，体积较大）',
  instrument: '仪器增强解析（h5py / yadg / eclabfiles）',
}

/** 平台感知的 venv Python 路径（评审加固 11.2）。 */
export function getVenvPythonPath(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

/** 平台感知的 venv bin 目录。 */
export function getVenvBinDir(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? join(venvDir, 'Scripts') : join(venvDir, 'bin')
}

export function getLabVenvDir(labId: string): string {
  return join(resolveLabDir(assertLabId(labId)), 'runtime', '.venv')
}

/** 定位随包 cslab 资源脚本（与 Phase 1 提取器同一套探测顺序）。 */
export function resolveCsLabScript(name: string): string | undefined {
  const candidates: string[] = []
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'cslab', name))
  candidates.push(join(__dirname, '..', 'resources', 'cslab', name))
  candidates.push(join(__dirname, '..', '..', 'resources', 'cslab', name))
  candidates.push(join(process.cwd(), 'resources', 'cslab', name))
  candidates.push(join(process.cwd(), 'apps', 'electron', 'resources', 'cslab', name))
  return candidates.find((candidate) => existsSync(candidate))
}

function resolveRequirementsPath(profile: CsLabToolProfile): string | undefined {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates: string[] = []
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'cslab', 'requirements', `${profile}.txt`))
  }
  candidates.push(join(__dirname, '..', 'resources', 'cslab', 'requirements', `${profile}.txt`))
  candidates.push(
    join(__dirname, '..', '..', 'resources', 'cslab', 'requirements', `${profile}.txt`),
  )
  candidates.push(
    join(process.cwd(), 'apps', 'electron', 'resources', 'cslab', 'requirements', `${profile}.txt`),
  )
  return candidates.find((candidate) => existsSync(candidate))
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 3000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

interface PythonCandidate {
  command: string
  argsPrefix: string[]
}

async function probeSystemPython(): Promise<PythonCandidate | null> {
  const candidates: PythonCandidate[] =
    process.platform === 'win32'
      ? [
          { command: 'python', argsPrefix: [] },
          { command: 'py', argsPrefix: ['-3'] },
          { command: 'python3', argsPrefix: [] },
        ]
      : [
          { command: 'python3', argsPrefix: [] },
          { command: 'python', argsPrefix: [] },
        ]

  for (const candidate of candidates) {
    if (await commandWorks(candidate.command, [...candidate.argsPrefix, '--version'])) {
      return candidate
    }
  }
  return null
}

async function probeUv(): Promise<string | null> {
  return (await commandWorks('uv', ['--version'])) ? 'uv' : null
}

/** 返回当前 lab 用于执行脚本的 Python 命令（venv 优先）。 */
export async function resolveLabPython(labId: string): Promise<{
  command: string
  argsPrefix: string[]
  venvPath: string
  usingVenv: boolean
} | null> {
  const venvDir = getLabVenvDir(labId)
  const venvPython = getVenvPythonPath(venvDir)
  // 静默自愈：venv 目录存在但解释器损坏时，回退系统 Python，由安装流程重建。
  if (existsSync(venvPython) && (await commandWorks(venvPython, ['--version']))) {
    return { command: venvPython, argsPrefix: [], venvPath: venvDir, usingVenv: true }
  }
  const system = await probeSystemPython()
  if (!system) return null
  return {
    command: system.command,
    argsPrefix: system.argsPrefix,
    venvPath: venvDir,
    usingVenv: false,
  }
}

interface ModuleProbeResult {
  installed: string[]
  missing: string[]
}

async function probeModules(
  python: { command: string; argsPrefix: string[] },
  modules: string[],
): Promise<ModuleProbeResult> {
  const snippet = [
    'import importlib.util, json',
    `mods = ${JSON.stringify(modules)}`,
    'missing = [m for m in mods if importlib.util.find_spec(m) is None]',
    'print(json.dumps({"missing": missing}))',
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(
      python.command,
      [...python.argsPrefix, '-c', snippet],
      { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout.trim()) as { missing?: string[] }
    const missing = new Set(Array.isArray(parsed.missing) ? parsed.missing : [])
    return {
      installed: modules.filter((module) => !missing.has(module)),
      missing: modules.filter((module) => missing.has(module)),
    }
  } catch {
    return { installed: [], missing: [...modules] }
  }
}

const profileStatusCache = new Map<string, CsLabToolRuntimeStatus>()

/** 查询实验室工具运行时状态（每个 profile 的缺失包）。 */
export async function getToolRuntimeStatus(labIdInput: string): Promise<CsLabToolRuntimeStatus> {
  const labId = assertLabId(labIdInput)
  const cached = profileStatusCache.get(labId)
  if (cached) return cached

  const python = await resolveLabPython(labId)
  const uvPath = (await probeUv()) ?? undefined

  if (!python) {
    const profiles = {} as Record<CsLabToolProfile, CsLabToolProfileStatus>
    for (const profile of Object.keys(PROFILE_MODULES) as CsLabToolProfile[]) {
      profiles[profile] = { installed: false, missing: [...PROFILE_MODULES[profile]] }
    }
    const status: CsLabToolRuntimeStatus = {
      uvPath,
      uvReady: !!uvPath,
      profiles,
      note: '未检测到 Python；可安装 Python 3.11+ 或 uv 后启用可选增强能力',
    }
    profileStatusCache.set(labId, status)
    return status
  }

  const allModules = [...new Set(Object.values(PROFILE_MODULES).flat())]
  const probe = await probeModules(python, allModules)
  const profiles = {} as Record<CsLabToolProfile, CsLabToolProfileStatus>
  for (const profile of Object.keys(PROFILE_MODULES) as CsLabToolProfile[]) {
    const modules = PROFILE_MODULES[profile]
    const missing = modules.filter((module) => probe.missing.includes(module))
    profiles[profile] = { installed: missing.length === 0, missing }
  }

  const status: CsLabToolRuntimeStatus = {
    pythonPath: python.command,
    venvPath: python.usingVenv ? python.venvPath : undefined,
    uvPath,
    uvReady: !!uvPath,
    profiles,
    note: python.usingVenv
      ? '已使用实验室私有 .venv'
      : '当前使用系统 Python；一键安装会创建实验室私有 .venv',
  }
  profileStatusCache.set(labId, status)
  return status
}

export function __resetToolRuntimeCacheForTest(labId?: string): void {
  if (labId) profileStatusCache.delete(labId)
  else profileStatusCache.clear()
}

export interface EnsureEnvironmentOptions {
  onProgress?: (progress: CsLabToolDepsProgress) => void
}

/** 一键创建 venv 并安装指定 profile 依赖（只写实验室目录）。 */
export async function ensureToolEnvironment(
  labIdInput: string,
  profile: CsLabToolProfile,
  options: EnsureEnvironmentOptions = {},
): Promise<CsLabToolRuntimeStatus> {
  const labId = assertLabId(labIdInput)
  const emit = (stage: CsLabToolDepsProgress['stage'], message: string): void => {
    options.onProgress?.({ labId, profile, stage, message })
  }

  const requirements = resolveRequirementsPath(profile)
  if (!requirements) {
    emit('error', `缺少 ${profile} 依赖清单文件`)
    throw new Error(`缺少 ${profile} 依赖清单文件`)
  }

  const venvDir = getLabVenvDir(labId)
  const venvPython = getVenvPythonPath(venvDir)

  emit('resolve', `准备安装 ${PROFILE_LABELS[profile]}`)
  let uvPath = await probeUv()
  if (!uvPath) {
    emit('resolve', '未检测到 uv，尝试自动下载单文件 uv')
    uvPath = await ensureUvBinary({
      labId,
      onProgress: (progress) => emit('resolve', progress.message),
      confirmUntrustedInstall: confirmUvUntrustedInstall,
    })
    if (!uvPath) {
      emit('resolve', 'uv 加速不可用，已自动切换为标准 Python 引擎')
    }
  }

  const venvHealthy = existsSync(venvPython) && (await commandWorks(venvPython, ['--version']))
  if (!venvHealthy && existsSync(venvDir)) {
    emit('venv', '检测到损坏的虚拟环境，正在静默重建')
    await fs.rm(venvDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (!venvHealthy) {
    emit('venv', '创建实验室私有虚拟环境')
    const createWithSystemPython = async (): Promise<void> => {
      const system = await probeSystemPython()
      if (!system) {
        emit('error', '未检测到 Python，无法创建虚拟环境')
        throw new Error('未检测到 Python，请先安装 Python 3.11+ 或 uv')
      }
      await execFileAsync(
        system.command,
        [...system.argsPrefix, '-m', 'venv', venvDir],
        { timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      )
    }

    if (uvPath) {
      try {
        await execFileAsync(uvPath, ['venv', venvDir, '--python', '3.11'], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
      } catch (error) {
        emit('venv', 'uv 创建虚拟环境失败，已回退系统 Python')
        console.warn('[CSLab] uv venv 失败，回退系统 Python:', error)
        uvPath = null
        await fs.rm(venvDir, { recursive: true, force: true }).catch(() => undefined)
        await createWithSystemPython()
      }
    } else {
      await createWithSystemPython()
    }
  }

  if (!existsSync(venvPython) || !(await commandWorks(venvPython, ['--version']))) {
    emit('error', '虚拟环境创建失败：未找到可用的 python 可执行文件')
    throw new Error('虚拟环境创建失败：未找到可用的 python 可执行文件')
  }

  emit('install', `安装 ${profile} 依赖（可能需要数分钟）`)
  if (uvPath) {
    try {
      await execFileAsync(
        uvPath,
        ['pip', 'install', '--python', venvPython, '-r', requirements],
        { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      )
    } catch (error) {
      emit('install', 'uv 安装依赖失败，已回退标准 pip')
      console.warn('[CSLab] uv pip 失败，回退 venv pip:', error)
      uvPath = null
    }
  }
  if (!uvPath) {
    await execFileAsync(
      venvPython,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements],
      { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    )
  }

  emit('verify', '校验依赖可导入性')
  profileStatusCache.delete(labId)
  const status = await getToolRuntimeStatus(labId)
  if (!status.profiles[profile].installed) {
    const missing = status.profiles[profile].missing.join(', ')
    emit('error', `安装完成但以下模块仍不可用：${missing}`)
    throw new Error(`安装完成但以下模块仍不可用：${missing}`)
  }

  emit('done', '依赖安装完成')
  return status
}

/** 在实验室 Python 中执行 cslab 脚本（venv 优先）。 */
export async function runCsLabPython(
  labId: string,
  scriptName: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  const scriptPath = resolveCsLabScript(scriptName)
  if (!scriptPath) throw new Error(`缺少 ${scriptName} 脚本`)
  const python = await resolveLabPython(labId)
  if (!python) throw new Error('未检测到 Python 运行时')

  const { stdout } = await execFileAsync(
    python.command,
    [...python.argsPrefix, scriptPath, ...args],
    {
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      // 红线：内部脚本的临时文件、__pycache__ 等副作用必须落在实验室沙箱内。
      cwd: resolveLabDir(labId),
    },
  )
  return stdout
}

/** 可注入的 Python 执行器（单元测试使用，生产默认走 runCsLabPython）。 */
export interface CsLabPythonRunner {
  runPython: (
    labId: string,
    scriptName: string,
    args: string[],
    options?: { timeoutMs?: number; maxBuffer?: number },
  ) => Promise<string>
}

export const defaultCsLabPythonRunner: CsLabPythonRunner = {
  runPython: runCsLabPython,
}

/** 探测系统 Python（供路由层状态展示）。 */
export async function getSystemPythonPath(): Promise<string | null> {
  const system = await probeSystemPython()
  return system?.command ?? null
}

/** 供测试：写入依赖清单后清理缓存。 */
export async function __ensureVenvForTest(venvDir: string): Promise<void> {
  await fs.mkdir(venvDir, { recursive: true })
}
