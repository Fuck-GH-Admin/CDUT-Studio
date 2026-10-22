/**
 * 图表数字化 / 公式验算 TS 包装层单元测试
 *
 * 通过注入 `CsLabPythonRunner`，在不依赖本机 Python、也不污染全局模块注册表的情况下验证：
 * - dataURL 与标定参数校验；
 * - Python 返回载荷的归一化、过滤与降级；
 * - verify 与 ocr 的参数隔离与错误兜底。
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { CsLabPythonRunner } from './cslab-python-runtime'
import { digitizePlot } from './cslab-plot-digitizer'
import { ocrFormula, verifyFormula } from './cslab-formula-verifier'

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8='
const CALIBRATION = {
  x: {
    ticks: [
      { px: 0, py: 0, value: 0 },
      { px: 100, py: 0, value: 10 },
    ],
    scale: 'auto' as const,
  },
  y: {
    ticks: [
      { px: 0, py: 100, value: 0 },
      { px: 0, py: 0, value: 10 },
    ],
    scale: 'auto' as const,
  },
}

interface PythonCall {
  labId: string
  script: string
  args: string[]
}

let calls: PythonCall[] = []
let handler: (script: string, args: string[]) => Promise<string>

const runner: CsLabPythonRunner = {
  runPython: async (labId, script, args) => {
    calls.push({ labId, script, args })
    return handler(script, args)
  },
}

beforeEach(() => {
  calls = []
  handler = async () => JSON.stringify({ ok: false, message: '默认 fake' })
})

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('digitizePlot 包装层', () => {
  test('归一化 Python 载荷：过滤坏点、默认标签、刻度类型回退', async () => {
    handler = async () =>
      JSON.stringify({
        ok: true,
        width: 400,
        height: 300,
        rotationDeg: 0,
        axisFit: {
          x: { scale: 'log', r2: 0.999 },
          y: { scale: 'weird', r2: 0.81 },
        },
        series: [
          {
            label: 'A',
            points: [
              [0, 0],
              [1, 1],
              ['bad', 2],
              [3, 'x'],
            ],
            pixels: [
              [10, 20],
              [11, 21],
            ],
          },
          { label: 'too-short', points: [[0, 0]], pixels: [] },
          { points: [[2, 2], [3, 3]], pixels: [[1, 1]] },
        ],
      })

    const result = await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'line',
        calibration: CALIBRATION,
      },
      runner,
    )

    expect(result.ok).toBe(true)
    expect(result.width).toBe(400)
    expect(result.height).toBe(300)
    expect(result.rotationDeg).toBe(0)
    expect(result.axisFit?.x.scale).toBe('log')
    expect(result.axisFit?.y.scale).toBe('linear')
    expect(result.series).toHaveLength(2)
    expect(result.series[0]?.points).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(result.series[0]?.pixels).toEqual([
      [10, 20],
      [11, 21],
    ])
    expect(result.series[1]?.label).toBe('series-3')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.script).toBe('cslab-plot-digitizer.py')
    expect(argValue(calls[0]!.args, '--mode')).toBe('line')
    expect(argValue(calls[0]!.args, '--tolerance')).toBe('28')
    expect(argValue(calls[0]!.args, '--color')).toBeUndefined()
    expect(JSON.parse(argValue(calls[0]!.args, '--calibration') ?? '{}')).toEqual(CALIBRATION)
  })

  test('颜色与容差参数被透传并夹紧到 8~60', async () => {
    handler = async () => JSON.stringify({ ok: false, message: '不需要结果' })

    await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'scatter',
        calibration: CALIBRATION,
        color: '#ff0000',
        tolerance: 999,
      },
      runner,
    )

    expect(argValue(calls[0]!.args, '--mode')).toBe('scatter')
    expect(argValue(calls[0]!.args, '--color')).toBe('#ff0000')
    expect(argValue(calls[0]!.args, '--tolerance')).toBe('60')
  })

  test('Python 返回 ok:false 时透传原因且不生成伪造曲线', async () => {
    handler = async () =>
      JSON.stringify({ ok: false, message: '未在框选区域检测到目标颜色曲线' })

    const result = await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'line',
        calibration: CALIBRATION,
      },
      runner,
    )

    expect(result.ok).toBe(false)
    expect(result.series).toEqual([])
    expect(result.message).toBe('未在框选区域检测到目标颜色曲线')
  })

  test('ok:true 但所有曲线点数不足时降级为失败', async () => {
    handler = async () =>
      JSON.stringify({
        ok: true,
        series: [{ label: 'A', points: [[0, 0]], pixels: [] }],
      })

    const result = await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'line',
        calibration: CALIBRATION,
      },
      runner,
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('未能从框选区域提取到有效曲线')
  })

  test('Python 抛错与非法 JSON 均降级为 ok:false', async () => {
    handler = async () => {
      throw new Error('Python 运行时缺失')
    }
    const failed = await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'line',
        calibration: CALIBRATION,
      },
      runner,
    )
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('Python 运行时缺失')

    handler = async () => 'not-json'
    const invalid = await digitizePlot(
      {
        labId: 'lab-test-01',
        imageDataUrl: PNG_DATA_URL,
        mode: 'line',
        calibration: CALIBRATION,
      },
      runner,
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.series).toEqual([])
  })

  test('非法 dataURL 与不足刻度在调用 Python 前即拒绝', async () => {
    await expect(
      digitizePlot(
        {
          labId: 'lab-test-01',
          imageDataUrl: 'data:image/gif;base64,AAAA',
          mode: 'line',
          calibration: CALIBRATION,
        },
        runner,
      ),
    ).rejects.toThrow('框选图像格式无效')

    await expect(
      digitizePlot(
        {
          labId: 'lab-test-01',
          imageDataUrl: PNG_DATA_URL,
          mode: 'line',
          calibration: {
            x: { ticks: [{ px: 0, py: 0, value: 0 }], scale: 'auto' },
            y: { ticks: [{ px: 0, py: 0, value: 0 }], scale: 'auto' },
          },
        },
        runner,
      ),
    ).rejects.toThrow('X/Y 轴各至少需要 2 个标定刻度')

    expect(calls).toHaveLength(0)
  })
})

describe('verifyFormula 包装层', () => {
  test('空表达式直接返回可读错误且不启动 Python', async () => {
    const result = await verifyFormula(
      {
        labId: 'lab-test-01',
        latexLhs: '  ',
        latexRhs: 'm a',
      },
      runner,
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('等式左右两侧')
    expect(calls).toHaveLength(0)
  })

  test('归一化验算结果：过滤非法数组、residual 转字符串、时间戳兜底', async () => {
    handler = async () =>
      JSON.stringify({
        ok: true,
        engine: 'latex2sympy2',
        equivalent: false,
        residual: -1,
        dimensions: { homogeneous: false, note: '量纲不一致' },
        singularities: ['x', 2, null],
        limitNotes: ['条件性收敛', false],
        preprocess: { appliedFixes: ['补充括号', 7] },
        elapsedMs: 42,
      })

    const result = await verifyFormula(
      {
        labId: 'lab-test-01',
        latexLhs: 'F',
        latexRhs: 'm*a',
        symbolDimensions: { F: 'force' },
      },
      runner,
    )

    expect(result.ok).toBe(true)
    expect(result.engine).toBe('latex2sympy2')
    expect(result.equivalent).toBe(false)
    expect(result.residual).toBe('-1')
    expect(result.dimensions).toEqual({ homogeneous: false, note: '量纲不一致' })
    expect(result.singularities).toEqual(['x'])
    expect(result.limitNotes).toEqual(['条件性收敛'])
    expect(result.preprocess?.appliedFixes).toEqual(['补充括号'])
    expect(result.elapsedMs).toBe(42)

    expect(calls[0]?.script).toBe('cslab-formula-verifier.py')
    expect(argValue(calls[0]!.args, '--mode')).toBe('verify')
    expect(argValue(calls[0]!.args, '--lhs')).toBe('F')
    expect(argValue(calls[0]!.args, '--rhs')).toBe('m*a')
    expect(JSON.parse(argValue(calls[0]!.args, '--symbols') ?? '{}')).toEqual({
      F: 'force',
    })
  })

  test('elapsedMs 为 0 时归一化为 undefined', async () => {
    handler = async () =>
      JSON.stringify({ ok: true, engine: 'sympy', equivalent: true, elapsedMs: 0 })

    const result = await verifyFormula(
      {
        labId: 'lab-test-01',
        latexLhs: 'a',
        latexRhs: 'a',
      },
      runner,
    )
    expect(result.equivalent).toBe(true)
    expect(result.elapsedMs).toBeUndefined()
  })

  test('Python 抛错与非法 JSON 均降级为 ok:false', async () => {
    handler = async () => {
      throw new Error('缺少 SymPy')
    }
    const failed = await verifyFormula(
      {
        labId: 'lab-test-01',
        latexLhs: 'a',
        latexRhs: 'b',
      },
      runner,
    )
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('缺少 SymPy')

    handler = async () => 'broken-json'
    const invalid = await verifyFormula(
      {
        labId: 'lab-test-01',
        latexLhs: 'a',
        latexRhs: 'b',
      },
      runner,
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.engine).toBe('sympy')
  })
})

describe('ocrFormula 包装层', () => {
  test('合法图像返回识别 LaTeX 与引擎', async () => {
    handler = async () =>
      JSON.stringify({ ok: true, latex: 'F = m a', engine: 'pix2text' })

    const result = await ocrFormula('lab-test-01', PNG_DATA_URL, runner)
    expect(result.ok).toBe(true)
    expect(result.latex).toBe('F = m a')
    expect(result.engine).toBe('pix2text')
    expect(argValue(calls[0]!.args, '--mode')).toBe('ocr')
    expect(argValue(calls[0]!.args, '--image')).toBeTruthy()
  })

  test('OCR 失败只返回 ok:false，不影响后续手工验算', async () => {
    handler = async () => {
      throw new Error('Pix2Text 未安装')
    }
    const result = await ocrFormula('lab-test-01', PNG_DATA_URL, runner)
    expect(result.ok).toBe(false)
    expect(result.engine).toBe('pix2text')
    expect(result.message).toContain('Pix2Text 未安装')
  })

  test('非法图像 dataURL 直接拒绝', async () => {
    await expect(
      ocrFormula('lab-test-01', 'data:image/gif;base64,AAAA', runner),
    ).rejects.toThrow('框选图像格式无效')
    expect(calls).toHaveLength(0)
  })
})
