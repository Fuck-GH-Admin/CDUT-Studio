/**
 * 泥石流 Python/numpy 可选求解通道。
 *
 * 仅当实验室 Python 环境可用且脚本存在时启用；失败由调用方回退 TypeScript。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CsLabDebrisFlowSimulationInput,
  CsLabDebrisFlowSimulationResult,
  CsLabGeoRaster,
} from '@profer/shared'
import { parseEsriAsciiGrid } from './cslab-geohazard'
import { resolveCsLabScript, runCsLabPython } from './cslab-python-runtime'

export interface PythonSimulationOutput {
  result: CsLabDebrisFlowSimulationResult
  depth: CsLabGeoRaster
  speed: CsLabGeoRaster
  arrival: CsLabGeoRaster
}

function parseResultJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!) as Record<string, unknown>
      if (parsed && parsed.ok === true) return parsed
    } catch {
      // 继续向前找 JSON 行。
    }
  }
  throw new Error('Python 求解器未返回有效 JSON')
}

export async function runPythonDebrisFlow(
  labId: string,
  demPath: string,
  input: CsLabDebrisFlowSimulationInput,
): Promise<PythonSimulationOutput> {
  if (!resolveCsLabScript('cslab-geohazard-solver.py')) {
    throw new Error('缺少 cslab-geohazard-solver.py 脚本')
  }
  const workDir = join(tmpdir(), `cslab-geohazard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(workDir, { recursive: true })
  const paramsPath = join(workDir, 'params.json')
  await fs.writeFile(paramsPath, JSON.stringify({
    source: input.source,
    rheology: input.rheology,
    volumeM3: input.volumeM3,
    rainfall: input.rainfall,
    durationS: input.durationS,
    cfl: input.cfl,
    depositionVelocity: input.depositionVelocity,
  }), 'utf-8')

  try {
    const stdout = await runCsLabPython(labId, 'cslab-geohazard-solver.py', [
      '--dem', demPath,
      '--params', paramsPath,
      '--out', workDir,
    ], { timeoutMs: 10 * 60_000 })
    const raw = parseResultJson(stdout)
    const depth = parseEsriAsciiGrid(await fs.readFile(join(workDir, 'max_depth.asc'), 'utf-8'))
    const speed = parseEsriAsciiGrid(await fs.readFile(join(workDir, 'max_speed.asc'), 'utf-8'))
    const arrival = parseEsriAsciiGrid(await fs.readFile(join(workDir, 'arrival.asc'), 'utf-8'))

    const result: CsLabDebrisFlowSimulationResult = {
      ok: true,
      demUri: input.demUri,
      model: String(raw.model) === 'bingham' ? 'bingham' : 'voellmy',
      engineUsed: 'python',
      source: raw.source as CsLabDebrisFlowSimulationResult['source'],
      releasedVolumeM3: Number(raw.releasedVolumeM3 ?? 0),
      peakDischargeM3s: Number(raw.peakDischargeM3s ?? 0),
      maxDepthM: Number(raw.maxDepthM ?? 0),
      maxSpeedMs: Number(raw.maxSpeedMs ?? 0),
      runoutDistanceM: Number(raw.runoutDistanceM ?? 0),
      depositionVolumeM3: Number(raw.depositionVolumeM3 ?? 0),
      arrivalTimeS: Number(raw.arrivalTimeS ?? 0),
      hazardAreaM2: (raw.hazardAreaM2 as CsLabDebrisFlowSimulationResult['hazardAreaM2']) ?? { high: 0, medium: 0, low: 0 },
      timeseries: Array.isArray(raw.timeseries)
        ? raw.timeseries as CsLabDebrisFlowSimulationResult['timeseries']
        : [],
      outputs: {},
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
      message: typeof raw.message === 'string' ? raw.message : undefined,
    }
    return { result, depth, speed, arrival }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
