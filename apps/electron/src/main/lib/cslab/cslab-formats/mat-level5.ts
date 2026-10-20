/**
 * MATLAB Level 5 (.mat) 纯 TypeScript 解析器
 *
 * 支持：miMATRIX（数值矩阵）、miCOMPRESSED（zlib 压缩元素）、大小端。
 * v7.3（HDF5）仅识别，交由可选 Python 增强通道处理。
 */

import { inflateSync } from 'node:zlib'
import { buildDataset, type ParsedDataset } from './types'

const MI_INT8 = 1
const MI_UINT8 = 2
const MI_INT16 = 3
const MI_UINT16 = 4
const MI_INT32 = 5
const MI_UINT32 = 6
const MI_SINGLE = 7
const MI_DOUBLE = 9
const MI_INT64 = 12
const MI_UINT64 = 13
const MI_MATRIX = 14
const MI_COMPRESSED = 15
const MI_UTF8 = 16
const MI_UTF16 = 17
const MI_UTF32 = 18

interface MatVariable {
  name: string
  rows: number
  cols: number
  /** 列主序展开的数值（与 MATLAB 内存布局一致）。 */
  values: number[]
  complex: boolean
}

interface Tag {
  type: number
  size: number
  dataOffset: number
  nextOffset: number
}

export function isMatLevel5(head: Buffer): boolean {
  return head.length >= 128 && head.subarray(0, 20).toString('latin1').includes('MATLAB 5.0 MAT-file')
}

export function isMatV73(head: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])
  return head.length >= 8 && head.subarray(0, 8).equals(signature)
}

function readTag(buffer: Buffer, offset: number, littleEndian: boolean): Tag | null {
  if (offset + 8 > buffer.length) return null
  const first = littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  const smallSize = first >>> 16
  if (smallSize !== 0) {
    return {
      type: first & 0xffff,
      size: smallSize,
      dataOffset: offset + 4,
      nextOffset: offset + 8,
    }
  }
  const size = littleEndian ? buffer.readUInt32LE(offset + 4) : buffer.readUInt32BE(offset + 4)
  const dataOffset = offset + 8
  const padding = size % 8 === 0 ? 0 : 8 - (size % 8)
  return { type: first, size, dataOffset, nextOffset: dataOffset + size + padding }
}

function readNumeric(buffer: Buffer, tag: Tag, littleEndian: boolean): number[] {
  const { type, size, dataOffset } = tag
  const result: number[] = []
  const end = Math.min(buffer.length, dataOffset + size)

  switch (type) {
    case MI_DOUBLE:
      for (let i = dataOffset; i + 8 <= end; i += 8) {
        result.push(littleEndian ? buffer.readDoubleLE(i) : buffer.readDoubleBE(i))
      }
      break
    case MI_SINGLE:
      for (let i = dataOffset; i + 4 <= end; i += 4) {
        result.push(littleEndian ? buffer.readFloatLE(i) : buffer.readFloatBE(i))
      }
      break
    case MI_INT8:
      for (let i = dataOffset; i < end; i += 1) result.push(buffer.readInt8(i))
      break
    case MI_UINT8:
      for (let i = dataOffset; i < end; i += 1) result.push(buffer.readUInt8(i))
      break
    case MI_INT16:
      for (let i = dataOffset; i + 2 <= end; i += 2) {
        result.push(littleEndian ? buffer.readInt16LE(i) : buffer.readInt16BE(i))
      }
      break
    case MI_UINT16:
      for (let i = dataOffset; i + 2 <= end; i += 2) {
        result.push(littleEndian ? buffer.readUInt16LE(i) : buffer.readUInt16BE(i))
      }
      break
    case MI_INT32:
      for (let i = dataOffset; i + 4 <= end; i += 4) {
        result.push(littleEndian ? buffer.readInt32LE(i) : buffer.readInt32BE(i))
      }
      break
    case MI_UINT32:
      for (let i = dataOffset; i + 4 <= end; i += 4) {
        result.push(littleEndian ? buffer.readUInt32LE(i) : buffer.readUInt32BE(i))
      }
      break
    case MI_INT64:
      for (let i = dataOffset; i + 8 <= end; i += 8) {
        const value = littleEndian ? buffer.readBigInt64LE(i) : buffer.readBigInt64BE(i)
        result.push(Number(value))
      }
      break
    case MI_UINT64:
      for (let i = dataOffset; i + 8 <= end; i += 8) {
        const value = littleEndian ? buffer.readBigUInt64LE(i) : buffer.readBigUInt64BE(i)
        result.push(Number(value))
      }
      break
    default:
      break
  }

  return result
}

function readName(buffer: Buffer, tag: Tag): string {
  const bytes = buffer.subarray(tag.dataOffset, Math.min(buffer.length, tag.dataOffset + tag.size))
  if (tag.type === MI_UTF8) return bytes.toString('utf-8').replace(/\0+$/, '')
  if (tag.type === MI_UTF16) {
    try {
      return bytes.toString('utf16le').replace(/\0+$/, '')
    } catch {
      return ''
    }
  }
  return bytes.toString('latin1').replace(/\0+$/, '')
}

function parseMatrix(buffer: Buffer, tag: Tag, littleEndian: boolean): MatVariable | null {
  const end = Math.min(buffer.length, tag.dataOffset + tag.size)
  let offset = tag.dataOffset
  let rows = 0
  let cols = 0
  let complex = false
  let name = ''
  let numeric: number[] = []
  let childIndex = 0

  while (offset < end) {
    const child = readTag(buffer, offset, littleEndian)
    if (!child || child.nextOffset <= offset) break
    offset = child.nextOffset

    // 子元素顺序固定：0=Array Flags，1=Dimensions，2=Name，3=Real，4=Imag。
    if (childIndex === 0) {
      const flags = readNumeric(buffer, child, littleEndian)
      complex = flags.length >= 1 && (Math.trunc(flags[0] ?? 0) & 0x0800) !== 0
      childIndex += 1
      continue
    }

    if (childIndex === 1) {
      const dims = readNumeric(buffer, child, littleEndian)
      if (dims.length >= 2) {
        rows = Math.max(0, Math.trunc(dims[0] ?? 0))
        cols = Math.max(0, Math.trunc(dims[1] ?? 0))
      }
      childIndex += 1
      continue
    }

    if (childIndex === 2) {
      name = readName(buffer, child)
      childIndex += 1
      continue
    }

    if (numeric.length === 0) {
      numeric = readNumeric(buffer, child, littleEndian)
    } else {
      // 第二段数值为虚部；本解析器仅保留实部，但保留 complex 标记。
      complex = true
    }
    childIndex += 1
  }

  if (!rows && !cols && numeric.length > 0) {
    rows = numeric.length
    cols = 1
  }
  if (rows * cols === 0 || numeric.length === 0) return null

  return {
    name: name || 'variable',
    rows,
    cols,
    values: numeric.slice(0, rows * cols),
    complex,
  }
}

function collectVariables(buffer: Buffer, littleEndian: boolean, out: MatVariable[]): void {
  let offset = 128
  while (offset < buffer.length) {
    const tag = readTag(buffer, offset, littleEndian)
    if (!tag || tag.nextOffset <= offset) break
    offset = tag.nextOffset

    if (tag.type === MI_COMPRESSED) {
      try {
        const inflated = inflateSync(buffer.subarray(tag.dataOffset, tag.dataOffset + tag.size))
        const inner = readTag(inflated, 0, littleEndian)
        if (inner?.type === MI_MATRIX) {
          const variable = parseMatrix(inflated, inner, littleEndian)
          if (variable) out.push(variable)
        }
      } catch (error) {
        console.warn('[CSLab] MAT 压缩元素解压失败，已跳过', error)
      }
      continue
    }

    if (tag.type === MI_MATRIX) {
      const variable = parseMatrix(buffer, tag, littleEndian)
      if (variable) out.push(variable)
    }
  }
}

/**
 * 解析 Level 5 MAT 文件中的首个数值矩阵，归一化为 X + Y 序列。
 */
export function parseMatLevel5(buffer: Buffer): ParsedDataset {
  if (!isMatLevel5(buffer)) throw new Error('不是有效的 MATLAB Level 5 MAT 文件')

  const marker = buffer.subarray(126, 128).toString('latin1')
  const littleEndian = marker === 'IM'
  const variables: MatVariable[] = []
  collectVariables(buffer, littleEndian, variables)

  const candidate = variables.find(
    (item) => item.rows > 0 && item.cols > 0 && item.rows * item.cols > 1,
  )
  if (!candidate) throw new Error('MAT 文件中未找到可用的数值矩阵')

  const { rows, cols, values, name, complex } = candidate
  const x: number[] = []
  const series: number[][] = []
  const seriesLabels: Array<{ label: string; unit?: string }> = []

  if (cols >= 2) {
    for (let row = 0; row < rows; row += 1) x.push(values[row] ?? 0)
    for (let col = 1; col < cols; col += 1) {
      const column: number[] = []
      for (let row = 0; row < rows; row += 1) column.push(values[row + col * rows] ?? 0)
      series.push(column)
      seriesLabels.push({ label: `${name}[:, ${col + 1}]` })
    }
  } else if (rows >= 2) {
    for (let row = 0; row < rows; row += 1) x.push(row)
    series.push(values.slice(0, rows))
    seriesLabels.push({ label: name })
  } else {
    throw new Error('MAT 数值矩阵维度过小，无法构成二维坐标')
  }

  return buildDataset({
    format: 'matlab-level5',
    xLabel: cols >= 2 ? `${name}[:, 1]` : 'Index',
    seriesLabels,
    x,
    series,
    metadata: {
      matVariable: name,
      matDimensions: `${rows} × ${cols}`,
      matComplex: complex ? '是（仅保留实部）' : '否',
      variables: variables.map((item) => item.name).join(', '),
    },
  })
}
