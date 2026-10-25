/**
 * 纯几何二维数学 AST 逆向构建器 + LaTeX 递归序列化器
 *
 * 目标：把 PDF 里「散落的字符图元 + 矢量线段」逆向重构为对标 OOXML `m:oMath`
 * 表达力的递归语法树（分式 / 上下标 / 根式 / n 元运算 / 矩阵 / 方程组 / 定界符 / 重音），
 * 再递归序列化为可直接粘进 Overleaf / TeXLive 编译的标准 LaTeX。
 *
 * 两条输入路径共用同一套节点与序列化器：
 * 1. **几何逆求**（主力）：字符图元 + 矢量线段 → MathNode；
 * 2. **原生 MathML**（加分项）：PDF /AF 关联文件里的 MathML → MathNode。
 *
 * 诚实声明：几何逆求对分式、上下标、根式、矩阵等结构性排版特征鲁棒，
 * 但对极端自由排版（手写体、旋转、非标准间距）不保证 100% 还原；
 * 高复杂度公式由上层按需送视觉 OCR 兜底。
 */

import type {
  MathAccent,
  MathNode,
  MathSymbolVariant,
  PointBBox,
} from '@profer/shared'
import type { PdfGlyphItem, VectorLine } from './types'

// ===== 数学符号 → LaTeX 映射 =====

/** 常见数学 Unicode 字符到 LaTeX 控制字的映射（键一律加引号：数学符号不是合法 JS 标识符） */
export const MATH_SYMBOL_TO_LATEX: Readonly<Record<string, string>> = {
  // 希腊小写
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
  'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega', 'ϵ': '\\epsilon', 'ϑ': '\\vartheta',
  'ϱ': '\\varrho', 'ς': '\\varsigma', 'ϕ': '\\varphi',
  // 希腊大写
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi',
  'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  // 关系符
  '≤': '\\le', '≥': '\\ge', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '∼': '\\sim', '∝': '\\propto', '≪': '\\ll', '≫': '\\gg', '≲': '\\lesssim',
  '≳': '\\gtrsim', '⊂': '\\subset', '⊆': '\\subseteq', '⊃': '\\supset',
  '⊇': '\\supseteq', '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
  // 运算符
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot',
  '∘': '\\circ', '∗': '\\ast', '⋆': '\\star', '⊕': '\\oplus', '⊗': '\\otimes',
  '⊙': '\\odot', '∪': '\\cup', '∩': '\\cap', '∖': '\\setminus', '∇': '\\nabla',
  '∂': '\\partial', '∞': '\\infty', '∅': '\\emptyset', '¬': '\\neg',
  '∧': '\\wedge', '∨': '\\vee', '∀': '\\forall', '∃': '\\exists',
  // 箭头
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow', '↦': '\\mapsto', '⟶': '\\longrightarrow',
  '⟵': '\\longleftarrow', '↼': '\\leftharpoonup', '⇀': '\\rightharpoonup',
  // 大型运算符
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∮': '\\oint',
  '∬': '\\iint', '∭': '\\iiint', '⋃': '\\bigcup', '⋂': '\\bigcap',
  '⋁': '\\bigvee', '⋀': '\\bigwedge',
  // 根号：几何折叠失败时的兜底符号（\sqrt 需要参数，孤立根号用 \surd）
  '√': '\\surd', '∛': '\\sqrt[3]{}', '∜': '\\sqrt[4]{}',
  // 数集与省略号
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}', 'ℙ': '\\mathbb{P}', 'ℱ': '\\mathcal{F}', 'ℒ': '\\mathcal{L}',
  'ℋ': '\\mathcal{H}', 'ℰ': '\\mathcal{E}',
  '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  // 定界符与其他
  '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '‖': '\\|',
  'ℏ': '\\hbar', '°': '^\\circ', '†': '\\dagger', '‡': '\\ddagger',
  '∠': '\\angle', '⊥': '\\perp', '∥': '\\parallel',
  '△': '\\triangle', '□': '\\square', '∎': '\\blacksquare',
  // 撇号在 KaTeX 中是上标算子（prime），紧跟其他上标会报「双重上标」，用空组隔开
  "'": "{}'",
  // 不可见空格 → 细空（用转义写法，避免源码中出现不可见字符）
  '\u00a0': '\\,', '\u2009': '\\,', '\u2005': '\\,', '\u202f': '\\,', '\u200b': '',
}

/** LaTeX 数学模式下需要反斜杠转义的 ASCII 字符 */
const LATEX_SPECIAL_CHARS = new Set(['\\', '{', '}', '#', '$', '%', '&', '_', '~', '^'])

/** 把一段文本中的数学符号归一化为 LaTeX（含特殊字符转义） */
export function normalizeMathSymbols(text: string): string {
  // 排版修饰符 / 组合记号：KaTeX 无对应字形，直接丢弃，绝不输出报错字符
  const DROP_CHARS = new Set(['\u00af', '\u02dc', '\u02c6', '\u02c7', '\u02d8', '\u02d9', '\u02da', '\u02dd'])

  let out = ''
  let lastWasControlWord = false
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // 私用区 / 未映射的排版码位（CMEX 等字体的大括号、定界符常落在这里）
    // 直接丢弃：宁可少一个字符，也绝不输出无法编译的乱码
    if (
      (code >= 0xe000 && code <= 0xf8ff) ||
      (code >= 0xf0000 && code <= 0x10fffd) ||
      code === 0xfffd ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      continue
    }
    // 控制字符一律丢弃
    if (code < 0x20 && code !== 0x09) continue
    // 组合记号 / 变体选择符 / 竖排兼容形式：重音已在 accent 节点处理，
    // 此处残留会导致 KaTeX 双重上标或缺字形告警
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe00 && code <= 0xfe2f) ||
      (code >= 0xfe30 && code <= 0xfe4f)
    ) {
      continue
    }
    if (DROP_CHARS.has(char)) continue

    let chunk: string
    const mapped = MATH_SYMBOL_TO_LATEX[char]
    if (mapped !== undefined) {
      chunk = mapped
    } else if (char === '^') {
      chunk = '\\hat{}'
    } else if (char === '~') {
      chunk = '\\sim '
    } else if (char === '\u2212' || char === '\u2013' || char === '\u2014') {
      chunk = '-'
    } else if (LATEX_SPECIAL_CHARS.has(char)) {
      chunk = `\\${char}`
    } else {
      chunk = char
    }

    // 控制字（\rho）后紧跟字母/数字会拼成未定义控制序列（\rhoK），必须补空格断词；
    // 普通多字母标识符（dx、f(x)）不受影响
    const isControlWord = /^\\[A-Za-z]+$/.test(chunk)
    if (lastWasControlWord && /^[A-Za-z0-9]/.test(chunk)) {
      out += ' '
    }
    lastWasControlWord = isControlWord
    out += chunk
  }
  return out
}

/** 判定 LaTeX 花括号是否配平（不配平的公式在 KaTeX 中必然编译失败） */
export function hasBalancedBraces(latex: string): boolean {
  let depth = 0
  for (let i = 0; i < latex.length; i += 1) {
    const char = latex[i]!
    // 反斜杠转义的字面量括号（\{ \}）自成一体，不参与配平
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

// ===== 原子（紧密字形串）聚类 =====

export interface MathAtom {
  glyphs: PdfGlyphItem[]
  bbox: PointBBox
  fontSize: number
  /** 基线（originY 中位数），y 轴向下 */
  baseline: number
  text: string
}

/** 同字号同基线、且水平间隙很小的连续字形并为一个原子 */
function clusterAtoms(glyphs: readonly PdfGlyphItem[]): MathAtom[] {
  // 必须先按基线（y）再按 x 排序：直接按 x 排会把分式分子/分母两行交错，
  // 导致「上一个原子」跳行、间隙判据失效而无法合并。
  const sorted = [...glyphs]
    .filter((glyph) => glyph.char.trim().length > 0 || glyph.char === ' ')
    .sort((a, b) => (a.bbox[1] !== b.bbox[1] ? a.bbox[1] - b.bbox[1] : a.bbox[0] - b.bbox[0]))

  const atoms: MathAtom[] = []
  for (const glyph of sorted) {
    const last = atoms[atoms.length - 1]
    const gap = last ? glyph.bbox[0] - last.bbox[2] : Number.POSITIVE_INFINITY
    const sameSize = last ? Math.abs(glyph.fontSize - last.fontSize) <= last.fontSize * 0.08 : false
    const sameBaseline = last
      ? Math.abs(glyph.originY - last.baseline) <= last.fontSize * 0.12
      : false
    const tight = gap <= (last?.fontSize ?? glyph.fontSize) * 0.22

    if (last && sameSize && sameBaseline && tight) {
      last.glyphs.push(glyph)
      last.bbox = [
        Math.min(last.bbox[0], glyph.bbox[0]),
        Math.min(last.bbox[1], glyph.bbox[1]),
        Math.max(last.bbox[2], glyph.bbox[2]),
        Math.max(last.bbox[3], glyph.bbox[3]),
      ]
      last.text += glyph.char
    } else {
      atoms.push({
        glyphs: [glyph],
        bbox: [...glyph.bbox] as PointBBox,
        fontSize: glyph.fontSize,
        baseline: glyph.originY,
        text: glyph.char,
      })
    }
  }
  return atoms
}

function median(values: readonly number[], fallback: number): number {
  if (values.length === 0) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? fallback) : ((sorted[mid - 1] ?? fallback) + (sorted[mid] ?? fallback)) / 2
}

/**
 * 主字号：取「主基线」上原子字号的中位数。
 *
 * 直接取全体会被上下标/大运算符的字号带偏（例如 x_i^2 的中位数落在 7pt 而非 10pt），
 * 故先定位主基线（基线中位数）再统计主基线上的字号。
 */
function dominantFontSize(atoms: readonly MathAtom[], fallback: number): number {
  if (atoms.length === 0) return fallback
  const allSizes = atoms.map((atom) => atom.fontSize)
  const maxSize = Math.max(...allSizes)
  const mainBaseline = median(atoms.map((atom) => atom.baseline), 0)
  const tolerance = maxSize * 0.15
  const mainAtoms = atoms.filter((atom) => Math.abs(atom.baseline - mainBaseline) <= tolerance)
  return median(mainAtoms.map((atom) => atom.fontSize), median(allSizes, fallback))
}

// ===== 矢量线段：分数线 / 根式上划线 =====

interface MathBar {
  x0: number
  x1: number
  y: number
}

const MIN_BAR_LENGTH_RATIO = 0.06

function collectBars(
  vectorLines: readonly VectorLine[],
  region: PointBBox,
  atoms: readonly MathAtom[],
  minLenRatio: number,
): MathBar[] {
  const width = region[2] - region[0]
  const minLen = width * minLenRatio
  const bars: MathBar[] = []
  for (const line of vectorLines) {
    if (!line.isHorizontal) continue
    if (line.thickness > 3) continue
    const x0 = Math.min(line.x0, line.x1)
    const x1 = Math.max(line.x0, line.x1)
    if (x1 - x0 < minLen) continue
    const y = (line.y0 + line.y1) / 2
    // 必须上下都有字形，才可能是分数线；只在上方有字形的是根式上划线，由根式逻辑单独处理
    const hasAbove = atoms.some((atom) => atom.bbox[3] <= y + 0.02 * (atom.fontSize || 1) && overlapsX(atom, x0, x1))
    const hasBelow = atoms.some((atom) => atom.bbox[1] >= y - 0.02 * (atom.fontSize || 1) && overlapsX(atom, x0, x1))
    if (hasAbove && hasBelow) bars.push({ x0, x1, y })
  }
  return bars.sort((a, b) => a.y - b.y)
}

function collectOverlines(
  vectorLines: readonly VectorLine[],
  region: PointBBox,
  atoms: readonly MathAtom[],
): MathBar[] {
  const width = region[2] - region[0]
  const minLen = width * 0.03
  const bars: MathBar[] = []
  for (const line of vectorLines) {
    if (!line.isHorizontal) continue
    if (line.thickness > 3) continue
    const x0 = Math.min(line.x0, line.x1)
    const x1 = Math.max(line.x0, line.x1)
    if (x1 - x0 < minLen) continue
    const y = (line.y0 + line.y1) / 2
    const hasBelow = atoms.some((atom) => atom.bbox[1] >= y - 0.02 * (atom.fontSize || 1) && overlapsX(atom, x0, x1))
    const hasAbove = atoms.some((atom) => atom.bbox[3] <= y + 0.02 * (atom.fontSize || 1) && overlapsX(atom, x0, x1))
    // 上方无字形、下方有字形 → 根式上划线 / 重音上划线
    if (hasBelow && !hasAbove) bars.push({ x0, x1, y })
  }
  return bars
}

function overlapsX(atom: MathAtom, x0: number, x1: number): boolean {
  const overlap = Math.min(atom.bbox[2], x1) - Math.max(atom.bbox[0], x0)
  const width = Math.min(atom.bbox[2] - atom.bbox[0], x1 - x0)
  return width > 0 && overlap >= width * 0.5
}

// ===== 递归构建 =====

export interface BuildContext {
  bodyFontSize: number
  bars: MathBar[]
  overlines: MathBar[]
}

function makeRow(children: MathNode[]): MathNode {
  const filtered = children.filter(Boolean)
  if (filtered.length === 0) return { type: 'row', children: [] }
  if (filtered.length === 1) return filtered[0]!
  return { type: 'row', children: filtered }
}

/** 单个原子 → 叶节点 */
function atomToLeaf(atom: MathAtom): MathNode {
  const text = atom.text.trim()
  if (text.length === 0) return { type: 'row', children: [] }
  if (/^[0-9]+([.,][0-9]+)?$/.test(text)) return { type: 'number', text }
  if (/^[+\-*/=<>,.;:!?'|()[\]{}]+$/.test(text) || /^[\u2190-\u21FF\u2200-\u22FF]$/.test(text)) {
    return { type: 'op', text: normalizeMathSymbols(text) }
  }
  return { type: 'symbol', text: normalizeMathSymbols(text), variant: classifyVariant(atom) }
}

function classifyVariant(atom: MathAtom): MathSymbolVariant {
  const font = (atom.glyphs[0]?.fontName ?? '').toLowerCase()
  if (/[Α-Ωα-ω]/.test(atom.text)) return 'greek'
  if (/italic|it\b|-it|mti|obi|cmmi|cmex/.test(font)) return 'italic'
  return 'normal'
}

const ACCENT_COMBINING: Readonly<Record<string, MathAccent>> = {
  '\u0302': 'hat',
  '\u0303': 'tilde',
  '\u0304': 'bar',
  '\u0305': 'overline',
  '\u0307': 'dot',
  '\u0308': 'ddot',
  '\u20D7': 'vec',
}

/** 原子文本中的组合重音符号 */
function extractAccent(text: string): { accent: MathAccent | null; base: string } {
  for (const [mark, accent] of Object.entries(ACCENT_COMBINING)) {
    if (text.includes(mark)) {
      return { accent, base: text.split(mark).join('') }
    }
  }
  return { accent: null, base: text }
}

/**
 * 把一组原子 + 分数线递归折叠为 MathNode。
 *
 * 折叠优先级：分式 → 根式 → 定界符/矩阵/方程组 → n 元运算 → 上下标 → 叶节点。
 */
export function buildFromAtoms(
  atoms: readonly MathAtom[],
  ctx: BuildContext,
  region: PointBBox,
  depth = 0,
): MathNode {
  if (atoms.length === 0) return { type: 'row', children: [] }
  if (depth > 12) return makeRow(atoms.map(atomToLeaf))

  const ordered = [...atoms].sort((a, b) => (a.bbox[0] !== b.bbox[0] ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1]))
  const spanX0 = Math.min(...ordered.map((atom) => atom.bbox[0]))
  const spanX1 = Math.max(...ordered.map((atom) => atom.bbox[2]))

  // ---- 1. 分式折叠 ----
  for (const bar of ctx.bars) {
    if (bar.x1 <= spanX0 || bar.x0 >= spanX1) continue
    const tolerance = ctx.bodyFontSize * 0.25
    const numerator = ordered.filter(
      (atom) => atom.bbox[3] <= bar.y + tolerance && overlapsX(atom, bar.x0, bar.x1),
    )
    const denominator = ordered.filter(
      (atom) => atom.bbox[1] >= bar.y - tolerance && overlapsX(atom, bar.x0, bar.x1),
    )
    if (numerator.length === 0 || denominator.length === 0) continue

    const consumed = new Set([...numerator, ...denominator])
    const rest = ordered.filter((atom) => !consumed.has(atom))
    const barMid = (bar.x0 + bar.x1) / 2
    const left = rest.filter((atom) => atom.bbox[2] <= barMid)
    const right = rest.filter((atom) => atom.bbox[0] > barMid)

    const fraction: MathNode = {
      type: 'fraction',
      numerator: buildFromAtoms(numerator, ctx, region, depth + 1),
      denominator: buildFromAtoms(denominator, ctx, region, depth + 1),
    }
    return makeRow([
      ...left.map((atom) => atomToLeaf(atom)),
      fraction,
      ...right.map((atom) => atomToLeaf(atom)),
    ])
  }

  // ---- 2. 根式折叠 ----
  const radicalIndex = ordered.findIndex((atom) => /[√∛∜]/.test(atom.text))
  if (radicalIndex >= 0) {
    const root = ordered[radicalIndex]!
    const baseSize = dominantFontSize(ordered, ctx.bodyFontSize)
    // 指数：紧邻根号左上角的小字
    const degreeCandidate = ordered
      .slice(0, radicalIndex)
      .reverse()
      .find(
        (atom) =>
          atom.fontSize <= root.fontSize * 0.8 &&
          atom.bbox[1] < root.bbox[3] - root.fontSize * 0.2 &&
          atom.bbox[2] <= root.bbox[0] + root.fontSize * 0.4,
      )
    // 被开方数：根号右侧同基线、且在上划线覆盖范围内的连续原子
    const overline = ctx.overlines.find(
      (bar) => bar.x0 <= root.bbox[2] + baseSize && bar.x1 > root.bbox[2],
    )
    const radicandAtoms: MathAtom[] = []
    let cursorRight = root.bbox[2]
    for (const atom of ordered.slice(radicalIndex + 1)) {
      const gap = atom.bbox[0] - cursorRight
      const sameBand = Math.abs(atom.baseline - root.baseline) <= root.fontSize * 0.6
      const underOverline = overline ? atom.bbox[2] <= overline.x1 + baseSize * 0.3 : true
      if (gap > baseSize * 1.2 && radicandAtoms.length > 0) break
      if (!sameBand && radicandAtoms.length > 0) break
      if (!underOverline) break
      radicandAtoms.push(atom)
      cursorRight = Math.max(cursorRight, atom.bbox[2])
    }

    const consumed = new Set<MathAtom>([root, ...radicandAtoms])
    if (degreeCandidate) consumed.add(degreeCandidate)
    const rest = ordered.filter((atom) => !consumed.has(atom))
    const before = rest.filter((atom) => atom.bbox[2] <= root.bbox[0] + ctx.bodyFontSize * 0.2)
    const after = rest.filter((atom) => atom.bbox[0] > root.bbox[0] + ctx.bodyFontSize * 0.2)

    const radical: MathNode = {
      type: 'radical',
      radicand: buildFromAtoms(radicandAtoms, ctx, region, depth + 1),
      ...(degreeCandidate
        ? { degree: buildFromAtoms([degreeCandidate], ctx, region, depth + 1) }
        : {}),
    }
    return makeRow([
      ...before.map((atom) => atomToLeaf(atom)),
      radical,
      ...after.map((atom) => atomToLeaf(atom)),
    ])
  }

  // ---- 3. 定界符 / 矩阵 / 方程组 ----
  const delimPair = findDelimPair(ordered, ctx)
  if (delimPair) {
    const { leftDelim, rightDelim, inner } = delimPair
    const rows = groupAtomsIntoRows(inner, ctx)
    if (rows.length >= 2) {
      const cells = rows.map((row) => splitRowIntoCells(row, ctx))
      const colCount = Math.max(...cells.map((row) => row.length))
      const uniform = cells.every((row) => row.length === colCount) && colCount >= 2
      const isCases = rightDelim === '' || leftDelim === '{'

      if (isCases) {
        return {
          type: 'cases',
          rows: cells.map((row) => ({
            left: buildFromAtoms(row[0] ?? [], ctx, region, depth + 1),
            ...(row[1] ? { right: buildFromAtoms(row[1], ctx, region, depth + 1) } : {}),
          })),
        }
      }
      if (uniform) {
        return {
          type: 'matrix',
          rows: cells.map((row) => row.map((cell) => buildFromAtoms(cell, ctx, region, depth + 1))),
          leftDelim,
          rightDelim,
        }
      }
    }
    return {
      type: 'delim',
      left: leftDelim,
      right: rightDelim,
      body: buildFromAtoms(inner, ctx, region, depth + 1),
    }
  }

  // ---- 4. n 元运算（求和 / 积分 / 求积） ----
  const naryIndex = ordered.findIndex((atom) => /[∑∏∐∫∮∬∭⋃⋂⋁⋀]/.test(atom.text))
  if (naryIndex >= 0) {
    const op = ordered[naryIndex]!
    const baseSize = dominantFontSize(ordered, ctx.bodyFontSize)
    const opMidX = (op.bbox[0] + op.bbox[2]) / 2

    const isScript = (atom: MathAtom): boolean =>
      atom.fontSize <= baseSize * 0.85 && Math.abs((atom.bbox[0] + atom.bbox[2]) / 2 - opMidX) <= baseSize * 2.2

    const supAtoms = ordered.filter(
      (atom) => isScript(atom) && atom.bbox[3] <= op.bbox[3] && atom.bbox[1] < op.bbox[1],
    )
    const subAtoms = ordered.filter(
      (atom) => isScript(atom) && atom.bbox[1] >= op.baseline - baseSize * 0.1 && atom.bbox[3] > op.bbox[3],
    )
    const consumed = new Set<MathAtom>([op, ...supAtoms, ...subAtoms])
    const rest = ordered.filter((atom) => !consumed.has(atom))
    const before = rest.filter((atom) => atom.bbox[2] <= op.bbox[0] + baseSize * 0.2)
    const after = rest.filter((atom) => atom.bbox[0] > op.bbox[0] + baseSize * 0.2)

    const nary: MathNode = {
      type: 'nary',
      operator: normalizeMathSymbols(op.text.trim()),
      ...(subAtoms.length > 0
        ? { sub: buildFromAtoms(subAtoms, ctx, region, depth + 1) }
        : {}),
      ...(supAtoms.length > 0
        ? { sup: buildFromAtoms(supAtoms, ctx, region, depth + 1) }
        : {}),
      body: buildFromAtoms(after, ctx, region, depth + 1),
    }
    return makeRow([...before.map((atom) => atomToLeaf(atom)), nary])
  }

  // ---- 5. 上下标折叠 ----
  const withScripts = foldSubSup(ordered, ctx, region, depth)
  return makeRow(withScripts)
}

/** 把水平原子串折叠为 base + 上下标 */
function foldSubSup(
  ordered: readonly MathAtom[],
  ctx: BuildContext,
  region: PointBBox,
  depth: number,
): MathNode[] {
  const baseSize = dominantFontSize(ordered, ctx.bodyFontSize)
  const baseBaseline = median(
    ordered.filter((atom) => atom.fontSize > baseSize * 0.85).map((atom) => atom.baseline),
    median(ordered.map((atom) => atom.baseline), 0),
  )
  const offsetThreshold = baseSize * 0.22
  const sizeThreshold = baseSize * 0.85

  const result: MathNode[] = []
  let index = 0
  while (index < ordered.length) {
    const atom = ordered[index]!

    // 带组合重音的原子
    const { accent, base } = extractAccent(atom.text)
    if (accent) {
      const baseAtom: MathAtom = { ...atom, text: base }
      result.push({ type: 'accent', base: atomToLeaf(baseAtom), accent })
      index += 1
      continue
    }

    const isScriptSize = atom.fontSize <= sizeThreshold
    const raised = atom.baseline <= baseBaseline - offsetThreshold
    const lowered = atom.baseline >= baseBaseline + offsetThreshold

    if (isScriptSize && (raised || lowered) && result.length > 0) {
      const baseNode = result.pop()!
      let supAtoms: MathAtom[] = []
      let subAtoms: MathAtom[] = []
      while (index < ordered.length) {
        const script = ordered[index]!
        const scriptRaised = script.baseline <= baseBaseline - offsetThreshold
        const scriptLowered = script.baseline >= baseBaseline + offsetThreshold
        if (script.fontSize > sizeThreshold || (!scriptRaised && !scriptLowered)) break
        if (scriptRaised) supAtoms.push(script)
        else subAtoms.push(script)
        index += 1
      }
      const node: MathNode =
        supAtoms.length > 0 && subAtoms.length > 0
          ? {
              type: 'subSup',
              base: baseNode,
              sub: buildFromAtoms(subAtoms, ctx, region, depth + 1),
              sup: buildFromAtoms(supAtoms, ctx, region, depth + 1),
            }
          : supAtoms.length > 0
            ? { type: 'sup', base: baseNode, sup: buildFromAtoms(supAtoms, ctx, region, depth + 1) }
            : { type: 'sub', base: baseNode, sub: buildFromAtoms(subAtoms, ctx, region, depth + 1) }
      result.push(node)
      continue
    }

    result.push(atomToLeaf(atom))
    index += 1
  }
  return result
}

const OPEN_DELIMS = '([{⟨⌊⌈|‖'
const CLOSE_DELIMS = ')]}⟩⌋⌉|‖'

function findDelimPair(
  ordered: readonly MathAtom[],
  ctx: BuildContext,
): { leftDelim: string; rightDelim: string; inner: MathAtom[] } | null {
  if (ordered.length < 3) return null
  const first = ordered[0]!
  const last = ordered[ordered.length - 1]!
  const leftText = first.text.trim()
  const rightText = last.text.trim()
  if (leftText.length === 0 || !OPEN_DELIMS.includes(leftText[leftText.length - 1]!)) return null

  // 右定界符可缺省（方程组只有左大括号）
  const hasRight = rightText.length > 0 && CLOSE_DELIMS.includes(rightText[rightText.length - 1]!)
  const inner = hasRight ? ordered.slice(1, -1) : ordered.slice(1)
  if (inner.length < 2) return null

  return {
    leftDelim: normalizeMathSymbols(leftText[leftText.length - 1]!),
    rightDelim: hasRight ? normalizeMathSymbols(rightText[rightText.length - 1]!) : '',
    inner,
  }
}

/** 按基线聚行（矩阵 / 方程组的行） */
function groupAtomsIntoRows(atoms: readonly MathAtom[], ctx: BuildContext): MathAtom[][] {
  const sorted = [...atoms].sort((a, b) => a.baseline - b.baseline)
  const rows: MathAtom[][] = []
  for (const atom of sorted) {
    const last = rows[rows.length - 1]
    const lastAtom = last?.[0]
    if (lastAtom && Math.abs(atom.baseline - lastAtom.baseline) <= ctx.bodyFontSize * 0.45) {
      last.push(atom)
    } else {
      rows.push([atom])
    }
  }
  return rows.map((row) => row.sort((a, b) => a.bbox[0] - b.bbox[0]))
}

/** 按 X 间隙切分一行内的单元格 */
function splitRowIntoCells(row: readonly MathAtom[], ctx: BuildContext): MathAtom[][] {
  const cells: MathAtom[][] = []
  for (const atom of row) {
    const last = cells[cells.length - 1]
    const lastAtom = last?.[last.length - 1]
    const gap = lastAtom ? atom.bbox[0] - lastAtom.bbox[2] : 0
    if (last && gap <= ctx.bodyFontSize * 0.75) {
      last.push(atom)
    } else {
      cells.push([atom])
    }
  }
  return cells
}

/** 构建数学 AST 的输入 */
export interface BuildMathAstInput {
  glyphs: readonly PdfGlyphItem[]
  vectorLines: readonly VectorLine[]
  region: PointBBox
  bodyFontSize: number
}

/**
 * 由字符图元 + 矢量线段逆向构建二维数学语法树。
 *
 * @param input 区域内字形、页面矢量线段、区域点坐标框、正文字号
 */
export function buildMathAst(input: BuildMathAstInput): MathNode {
  const atoms = clusterAtoms(input.glyphs)
  const region = input.region
  const ctx: BuildContext = {
    bodyFontSize: input.bodyFontSize > 0 ? input.bodyFontSize : 10,
    bars: collectBars(input.vectorLines, region, atoms, MIN_BAR_LENGTH_RATIO),
    overlines: collectOverlines(input.vectorLines, region, atoms),
  }
  return buildFromAtoms(atoms, ctx, region)
}

// ===== LaTeX 递归序列化 =====

/** 括号包裹（仅当子节点是复合结构时） */
function braceIfComplex(node: MathNode, latex: string): string {
  const simple =
    node.type === 'symbol' ||
    node.type === 'number' ||
    node.type === 'op' ||
    node.type === 'text' ||
    (node.type === 'row' && node.children.length <= 1)
  return simple ? latex : `{${latex}}`
}

/**
 * 递归序列化为标准 LaTeX（可直接粘进 Overleaf / TeXLive 编译）。
 */
export function serializeMathAstToLatex(root: MathNode): string {
  switch (root.type) {
    case 'row':
      return root.children.map(serializeMathAstToLatex).join(' ')
    case 'symbol':
    case 'number':
    case 'op':
      return root.text
    case 'text':
      return `\\text{${root.text}}`
    case 'fraction':
      return `\\frac{${serializeMathAstToLatex(root.numerator)}}{${serializeMathAstToLatex(root.denominator)}}`
    case 'sub':
      return `${serializeMathAstToLatex(root.base)}_{${serializeMathAstToLatex(root.sub)}}`
    case 'sup':
      return `${serializeMathAstToLatex(root.base)}^{${serializeMathAstToLatex(root.sup)}}`
    case 'subSup': {
      const base = serializeMathAstToLatex(root.base)
      const sub = root.sub ? `_{${serializeMathAstToLatex(root.sub)}}` : ''
      const sup = root.sup ? `^{${serializeMathAstToLatex(root.sup)}}` : ''
      return `${base}${sub}${sup}`
    }
    case 'radical': {
      const radicand = `{${serializeMathAstToLatex(root.radicand)}}`
      return root.degree
        ? `\\sqrt[${serializeMathAstToLatex(root.degree)}]${radicand}`
        : `\\sqrt${radicand}`
    }
    case 'nary': {
      const op = root.operator
      const sub = root.sub ? `_{${serializeMathAstToLatex(root.sub)}}` : ''
      const sup = root.sup ? `^{${serializeMathAstToLatex(root.sup)}}` : ''
      const body = serializeMathAstToLatex(root.body)
      return `${op}${sub}${sup} ${body}`.trim()
    }
    case 'matrix': {
      const env = root.leftDelim === '[' && root.rightDelim === ']'
        ? 'bmatrix'
        : root.leftDelim === '\\{' || root.leftDelim === '{'
          ? 'Bmatrix'
          : root.leftDelim === '\\|' || root.leftDelim === '|'
            ? 'vmatrix'
            : 'pmatrix'
      const rows = root.rows
        .map((row) => row.map(serializeMathAstToLatex).join(' & '))
        .join(' \\\\ ')
      return `\\begin{${env}} ${rows} \\end{${env}}`
    }
    case 'cases': {
      const rows = root.rows
        .map((row) => {
          const left = serializeMathAstToLatex(row.left)
          return row.right ? `${left} & ${serializeMathAstToLatex(row.right)}` : left
        })
        .join(' \\\\ ')
      return `\\begin{cases} ${rows} \\end{cases}`
    }
    case 'delim': {
      const body = serializeMathAstToLatex(root.body)
      const braceBrackets = root.left === '\\{' || root.left === '{'
      const openEnded = !root.right || root.right === '\\}' || root.right === '}' || root.right === ''
      if (braceBrackets && openEnded) {
        return `\\begin{cases} ${body} \\end{cases}`
      }
      // \left \right 对任意定界符均合法；缺失的一侧用 "." 占位
      const left = root.left || '.'
      const right = root.right || '.'
      return `\\left${left} ${body} \\right${right}`
    }
    case 'accent': {
      const base = braceIfComplex(root.base, serializeMathAstToLatex(root.base))
      const macro =
        root.accent === 'overline' ? '\\overline' : `\\${root.accent}`
      return `${macro}${base}`
    }
    default:
      return ''
  }
}

// ===== MathML → MathNode（原生标签支路） =====

interface MmlNode {
  tag: string
  attrs: Record<string, string>
  children: MmlNode[]
  text: string
}

/** 极简 XML 扫描器（零依赖，只覆盖 MathML 所需） */
function parseXml(xml: string): MmlNode | null {
  const root: MmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: MmlNode[] = [root]
  const tokenRe = /<[^>]+>|[^<]+/g
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(xml)) !== null) {
    const token = match[0]
    if (token.startsWith('<')) {
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop()
        continue
      }
      const selfClosing = token.endsWith('/>')
      const inner = token.slice(1, selfClosing ? -2 : -1).trim()
      const tagMatch = /^([\w:.-]+)/.exec(inner)
      if (!tagMatch) continue
      const tag = tagMatch[1]!.toLowerCase().replace(/^.*:/, '')
      const attrs: Record<string, string> = {}
      const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g
      let attrMatch: RegExpExecArray | null
      while ((attrMatch = attrRe.exec(inner)) !== null) {
        const key = (attrMatch[1] ?? attrMatch[3] ?? '').toLowerCase().replace(/^.*:/, '')
        const value = attrMatch[2] ?? attrMatch[4] ?? ''
        if (key) attrs[key] = value
      }
      const node: MmlNode = { tag, attrs, children: [], text: '' }
      stack[stack.length - 1]!.children.push(node)
      if (!selfClosing) stack.push(node)
    } else {
      const text = token.trim()
      if (text) stack[stack.length - 1]!.text += text
    }
  }
  return root.children[0] ?? null
}

function mmlChildrenToRow(node: MmlNode): MathNode {
  const parts: MathNode[] = []
  for (const child of node.children) {
    const converted = convertMmlNode(child)
    if (converted) parts.push(converted)
  }
  return makeRow(parts)
}

function convertMmlNode(node: MmlNode): MathNode | null {
  switch (node.tag) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'menclose':
    case 'mphantom':
    case 'semantics':
      return mmlChildrenToRow(node)
    case 'mi':
      return { type: 'symbol', text: normalizeMathSymbols(node.text), variant: 'italic' }
    case 'mn':
      return { type: 'number', text: node.text }
    case 'mo':
      return { type: 'op', text: normalizeMathSymbols(node.text) }
    case 'mtext':
      return { type: 'text', text: node.text }
    case 'msqrt':
      return { type: 'radical', radicand: mmlChildrenToRow(node) }
    case 'mroot': {
      const base = convertMmlNode(node.children[0] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const degree = convertMmlNode(node.children[1] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      return { type: 'radical', radicand: base ?? { type: 'row', children: [] }, ...(degree ? { degree } : {}) }
    }
    case 'mfrac': {
      const numerator = convertMmlNode(node.children[0] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const denominator = convertMmlNode(node.children[1] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      return {
        type: 'fraction',
        numerator: numerator ?? { type: 'row', children: [] },
        denominator: denominator ?? { type: 'row', children: [] },
      }
    }
    case 'msub':
    case 'munder': {
      const base = convertMmlNode(node.children[0] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const sub = convertMmlNode(node.children[1] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      return { type: 'sub', base: base ?? { type: 'row', children: [] }, sub: sub ?? { type: 'row', children: [] } }
    }
    case 'msup':
    case 'mover': {
      const base = convertMmlNode(node.children[0] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const sup = convertMmlNode(node.children[1] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      return { type: 'sup', base: base ?? { type: 'row', children: [] }, sup: sup ?? { type: 'row', children: [] } }
    }
    case 'msubsup':
    case 'munderover': {
      const base = convertMmlNode(node.children[0] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const sub = convertMmlNode(node.children[1] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      const sup = convertMmlNode(node.children[2] ?? { tag: 'mrow', attrs: {}, children: [], text: '' })
      return {
        type: 'subSup',
        base: base ?? { type: 'row', children: [] },
        ...(sub ? { sub } : {}),
        ...(sup ? { sup } : {}),
      }
    }
    case 'mtable': {
      const rows: MathNode[][] = []
      for (const rowNode of node.children) {
        if (rowNode.tag !== 'mtr' && rowNode.tag !== 'mlabeledtr') continue
        const cells: MathNode[] = []
        for (const cellNode of rowNode.children) {
          if (cellNode.tag !== 'mtd') continue
          cells.push(mmlChildrenToRow(cellNode))
        }
        rows.push(cells)
      }
      return rows.length > 0 ? { type: 'matrix', rows, leftDelim: '(', rightDelim: ')' } : null
    }
    case 'mfenced': {
      const open = node.attrs.open ?? '('
      const close = node.attrs.close ?? ')'
      const body = mmlChildrenToRow(node)
      if (open === '{' && (close === '' || close === '.' || close === '}')) {
        return { type: 'cases', rows: [{ left: body }] }
      }
      return {
        type: 'delim',
        left: normalizeMathSymbols(open),
        right: close === '.' ? '' : normalizeMathSymbols(close),
        body,
      }
    }
    case 'mspace':
    case 'annotation':
    case 'none':
    case 'mprescripts':
      return null
    default:
      return mmlChildrenToRow(node)
  }
}

/**
 * 把原生 MathML 字符串转换为 MathNode。
 *
 * 解析失败或结构不认识时返回 null，调用方回落几何构建，绝不伪造。
 */
export function mathmlToMathAst(xml: string): MathNode | null {
  if (!xml || !xml.includes('<')) return null
  try {
    const root = parseXml(xml)
    if (!root) return null
    return convertMmlNode(root)
  } catch {
    return null
  }
}

/** 把原生 MathML 直接序列化为 LaTeX（内部走 MathNode，与几何路径共用序列化器） */
export function mathmlToLatex(xml: string): string | null {
  const ast = mathmlToMathAst(xml)
  return ast ? serializeMathAstToLatex(ast) : null
}
