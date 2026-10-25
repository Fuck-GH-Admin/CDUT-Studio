import { describe, expect, test } from 'bun:test'
import {
  buildMathAst,
  mathmlToLatex,
  normalizeMathSymbols,
  serializeMathAstToLatex,
} from '../math-ast-builder'
import type { PdfGlyphItem, VectorLine } from '../types'
import type { PointBBox } from '@profer/shared'

/** 构造单个字符图元；originY 取 bbox 底边（基线），y 轴向下 */
function glyph(
  char: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fontSize = 10,
  fontName = 'CMMI10',
): PdfGlyphItem {
  return {
    char,
    fontName,
    fontSize,
    originX: x0,
    originY: y1,
    width: x1 - x0,
    height: y1 - y0,
    bbox: [x0, y0, x1, y1],
    renderingMode: 0,
    colorAlpha: 1,
    isOutOfCanvas: false,
  }
}

/** 紧密排布的一串字符（同字号同基线，间隙为 0）→ 会被聚成单个原子 */
function run(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fontSize = 10,
  fontName = 'CMMI10',
): PdfGlyphItem[] {
  const chars = Array.from(text)
  const width = (x1 - x0) / chars.length
  return chars.map((char, index) =>
    glyph(char, x0 + index * width, y0, x0 + (index + 1) * width, y1, fontSize, fontName),
  )
}

function hline(x0: number, y: number, x1: number): VectorLine {
  return { x0, y0: y, x1, y1: y, isHorizontal: true, thickness: 1 }
}

const REGION: PointBBox = [0, 0, 400, 400]

function latex(glyphs: PdfGlyphItem[], vectorLines: VectorLine[] = []): string {
  return serializeMathAstToLatex(
    buildMathAst({ glyphs, vectorLines, region: REGION, bodyFontSize: 10 }),
  )
}

describe('分式重构', () => {
  test('分子 + 横向矢量线 + 分母折叠为 \\frac{a+b}{c+d}', () => {
    const glyphs = [
      ...run('a+b', 30, 40, 54, 50),
      ...run('c+d', 30, 60, 54, 70),
    ]
    const lines = [hline(28, 55, 56)]

    expect(latex(glyphs, lines)).toBe('\\frac{a+b}{c+d}')
  })

  test('无矢量线时不硬造分式', () => {
    const glyphs = [...run('a+b', 30, 40, 54, 50)]

    expect(latex(glyphs)).toBe('a+b')
  })
})

describe('上下标自适应反求', () => {
  test('x_i^2 精确还原为 x_{i}^{2}，绝不输出 xi2', () => {
    const glyphs = [
      glyph('x', 30, 90, 40, 100, 10),
      glyph('i', 41, 96, 46, 103, 7),
      glyph('2', 47, 90, 52, 97, 7),
    ]

    expect(latex(glyphs)).toBe('x_{i}^{2}')
  })

  test('纯下标 x_i 还原为 x_{i}', () => {
    const glyphs = [
      glyph('x', 30, 90, 40, 100, 10),
      glyph('i', 41, 96, 46, 103, 7),
    ]

    expect(latex(glyphs)).toBe('x_{i}')
  })

  test('纯上标 e^x 还原为 e^{x}', () => {
    const glyphs = [
      glyph('e', 30, 90, 40, 100, 10),
      glyph('x', 41, 84, 47, 91, 7),
    ]

    expect(latex(glyphs)).toBe('e^{x}')
  })
})

describe('积分与求和上下界', () => {
  test('∫ 带上下小字还原为 \\int_{a}^{b} ...', () => {
    const glyphs = [
      glyph('∫', 30, 40, 46, 56, 16, 'CMEX10'),
      glyph('b', 34, 32, 40, 39, 7),
      glyph('a', 34, 58, 40, 65, 7),
      ...run('f(x)', 50, 46, 90, 56),
      ...run('dx', 95, 46, 115, 56),
    ]

    expect(latex(glyphs)).toBe('\\int_{a}^{b} f(x) dx')
  })

  test('∑ 带上下界还原为 \\sum_{i=1}^{n}', () => {
    const glyphs = [
      glyph('∑', 30, 40, 46, 56, 16, 'CMEX10'),
      ...run('i=1', 30, 58, 48, 65, 7),
      glyph('n', 34, 32, 41, 39, 7),
      ...run('x', 50, 46, 60, 56),
    ]

    expect(latex(glyphs)).toBe('\\sum_{i=1}^{n} x')
  })
})

describe('根式重构', () => {
  test('√ + 上划线还原为 \\sqrt{x+1}', () => {
    const glyphs = [
      glyph('√', 20, 40, 32, 56, 16, 'CMEX10'),
      ...run('x+1', 36, 42, 80, 52),
    ]
    const lines = [hline(28, 40, 90)]

    expect(latex(glyphs, lines)).toBe('\\sqrt{x+1}')
  })
})

describe('矩阵与方程组网格聚类', () => {
  test('括号 + 2×2 网格还原为 \\begin{pmatrix}', () => {
    const glyphs = [
      glyph('(', 20, 40, 28, 70, 10, 'CMR10'),
      glyph('a', 40, 42, 50, 52),
      glyph('b', 70, 42, 80, 52),
      glyph('c', 40, 58, 50, 68),
      glyph('d', 70, 58, 80, 68),
      glyph(')', 100, 40, 108, 70, 10, 'CMR10'),
    ]

    expect(latex(glyphs)).toBe('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')
  })

  test('左大括号 + 多行还原为 \\begin{cases}', () => {
    const glyphs = [
      glyph('{', 20, 40, 28, 70, 10, 'CMR10'),
      ...run('x>0', 40, 42, 80, 52),
      ...run('x<=0', 40, 58, 90, 68),
    ]

    expect(latex(glyphs)).toBe('\\begin{cases} x>0 \\\\ x<=0 \\end{cases}')
  })
})

describe('MathML 原生标签转换', () => {
  test('mfrac 转换为同一 MathNode 并序列化为 \\frac{a}{b}', () => {
    expect(mathmlToLatex('<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>')).toBe('\\frac{a}{b}')
  })

  test('msubsup 转换为 x_{i}^{2}', () => {
    const result = mathmlToLatex(
      '<math><msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup></math>',
    )
    expect(result).toBe('x_{i}^{2}')
  })

  test('msqrt 转换为 \\sqrt{...}', () => {
    expect(mathmlToLatex('<math><msqrt><mi>x</mi></msqrt></math>')).toBe('\\sqrt{x}')
  })

  test('mtable 转换为 pmatrix', () => {
    const xml = [
      '<math><mrow><mo>(</mo><mtable>',
      '<mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr>',
      '<mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr>',
      '</mtable><mo>)</mo></mrow></math>',
    ].join('')
    expect(mathmlToLatex(xml)).toContain('\\begin{pmatrix}')
    expect(mathmlToLatex(xml)).toContain('a & b \\\\ c & d')
  })

  test('非 MathML 输入返回 null，绝不伪造', () => {
    expect(mathmlToLatex('')).toBeNull()
    expect(mathmlToLatex('not xml at all')).toBeNull()
    expect(mathmlToLatex('<unclosed')).toBeNull()
  })
})

describe('数学符号归一化', () => {
  test('希腊字母与关系符映射为 LaTeX 控制字', () => {
    expect(normalizeMathSymbols('α ∈ ℝ')).toBe('\\alpha \\in \\mathbb{R}')
    expect(normalizeMathSymbols('p ≤ 0.05')).toBe('p \\le 0.05')
    expect(normalizeMathSymbols('a ≠ b')).toBe('a \\neq b')
    expect(normalizeMathSymbols('x → ∞')).toBe('x \\to \\infty')
  })

  test('LaTeX 特殊字符被转义', () => {
    expect(normalizeMathSymbols('a_b')).toBe('a\\_b')
    expect(normalizeMathSymbols('100%')).toBe('100\\%')
    expect(normalizeMathSymbols('a&b')).toBe('a\\&b')
  })
})
