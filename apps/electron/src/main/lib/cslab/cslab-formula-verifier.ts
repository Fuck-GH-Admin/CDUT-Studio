/**
 * 公式 SymPy 验算与可选 OCR 的 TS 包装层
 *
 * 评审加固 11.5：verify 与 ocr 完全隔离；
 * OCR 失败只返回 ok:false，不影响用户手工输入 LaTeX 的验算链路。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CsLabFormulaOcrResult,
  CsLabFormulaVerifyInput,
  CsLabFormulaVerifyResult,
} from '@profer/shared'
import { assertLabId } from './cslab-paths'
import {
  defaultCsLabPythonRunner,
  type CsLabPythonRunner,
} from './cslab-python-runtime'

const MAX_IMAGE_BYTES = 24 * 1024 * 1024

function parseDataUrl(dataUrl: string): { buffer: Buffer; extension: string } {
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('框选图像格式无效（仅支持 PNG/JPEG dataURL）')
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1]!
  const buffer = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64')
  if (buffer.length === 0) throw new Error('框选图像为空')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('框选图像超过 24MB，请缩小框选范围')
  return { buffer, extension }
}

interface RawVerifyPayload {
  ok?: boolean
  engine?: string
  message?: string
  equivalent?: boolean
  residual?: string | null
  dimensions?: unknown
  singularities?: unknown
  limitNotes?: unknown
  preprocess?: { appliedFixes?: unknown }
  elapsedMs?: number
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export async function verifyFormula(
  input: CsLabFormulaVerifyInput,
  runner: CsLabPythonRunner = defaultCsLabPythonRunner,
): Promise<CsLabFormulaVerifyResult> {
  const labId = assertLabId(input.labId)
  const lhs = typeof input.latexLhs === 'string' ? input.latexLhs.trim() : ''
  const rhs = typeof input.latexRhs === 'string' ? input.latexRhs.trim() : ''
  if (!lhs || !rhs) {
    return { ok: false, engine: 'sympy', message: '请提供等式左右两侧的 LaTeX' }
  }

  try {
    const stdout = await runner.runPython(
      labId,
      'cslab-formula-verifier.py',
      [
        '--mode',
        'verify',
        '--lhs',
        lhs,
        '--rhs',
        rhs,
        '--symbols',
        JSON.stringify(input.symbolDimensions ?? {}),
      ],
      { timeoutMs: 120_000 },
    )
    const payload = JSON.parse(stdout.trim()) as RawVerifyPayload
    return {
      ok: payload.ok === true,
      engine: payload.engine ?? 'sympy',
      message: payload.message,
      equivalent: typeof payload.equivalent === 'boolean' ? payload.equivalent : undefined,
      residual: payload.residual == null ? undefined : String(payload.residual),
      dimensions:
        payload.dimensions && typeof payload.dimensions === 'object'
          ? (payload.dimensions as CsLabFormulaVerifyResult['dimensions'])
          : undefined,
      singularities: toStringArray(payload.singularities),
      limitNotes: toStringArray(payload.limitNotes),
      preprocess: {
        appliedFixes: toStringArray(payload.preprocess?.appliedFixes),
      },
      elapsedMs: Number(payload.elapsedMs ?? 0) || undefined,
    }
  } catch (error) {
    return {
      ok: false,
      engine: 'sympy',
      message: error instanceof Error ? error.message : '公式验算失败',
    }
  }
}

interface RawOcrPayload {
  ok?: boolean
  latex?: string
  engine?: string
  message?: string
}

export async function ocrFormula(
  labIdInput: string,
  imageDataUrl: string,
  runner: CsLabPythonRunner = defaultCsLabPythonRunner,
): Promise<CsLabFormulaOcrResult> {
  const labId = assertLabId(labIdInput)
  const image = parseDataUrl(imageDataUrl)
  const tempDir = await fs.mkdtemp(join(tmpdir(), 'cslab-formula-'))
  const imagePath = join(tempDir, `formula-${randomUUID().slice(0, 8)}.${image.extension}`)

  try {
    await fs.writeFile(imagePath, image.buffer)
    const stdout = await runner.runPython(
      labId,
      'cslab-formula-verifier.py',
      ['--mode', 'ocr', '--image', imagePath],
      // OCR 首次可能加载模型，给予更宽裕的超时。
      { timeoutMs: 180_000 },
    )
    const payload = JSON.parse(stdout.trim()) as RawOcrPayload
    return {
      ok: payload.ok === true,
      latex: payload.latex,
      engine: payload.engine ?? 'pix2text',
      message: payload.message,
    }
  } catch (error) {
    return {
      ok: false,
      engine: 'pix2text',
      message: error instanceof Error ? error.message : '公式识别失败',
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
