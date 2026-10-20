/**
 * Thermo Galactic .spc 二进制光谱解析器
 *
 * 依据 SPC 规范：
 * - 首两字节 0x4D 0x4C（"ML"）= 小端新格式（512 字节头）；0x4C 0x4D（"LM"）= 大端旧格式（128 字节头）；
 * - ftflgs bit0 = Y 为 16 位整数（否则为 32 位浮点）；
 * - fexp 为 16 位整数的二进制指数缩放（Y = raw × 2^fexp）；
 * - ffirst / flast 给出线性 X 轴端点。
 */

import { buildDataset, type ParsedDataset } from './types'

const SPC_NEW_HEADER = 512
const SPC_OLD_HEADER = 128

export function isSpc(buffer: Buffer): boolean {
  if (buffer.length < 2) return false
  const first = buffer[0]
  const second = buffer[1]
  return (first === 0x4d && second === 0x4c) || (first === 0x4c && second === 0x4d)
}

export function parseSpc(buffer: Buffer): ParsedDataset {
  if (!isSpc(buffer)) throw new Error('不是有效的 Thermo SPC 文件')

  const littleEndian = buffer[0] === 0x4d
  const headerSize = littleEndian ? SPC_NEW_HEADER : SPC_OLD_HEADER
  if (buffer.length < headerSize) throw new Error('SPC 文件头不完整')

  const readUInt32 = (offset: number): number =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  const readDouble = (offset: number): number =>
    littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset)

  const flags = buffer[2] ?? 0
  const exponent = buffer.readInt8(4)
  const pointCount = readUInt32(6)
  const firstX = readDouble(10)
  const lastX = readDouble(18)

  if (!Number.isFinite(pointCount) || pointCount <= 0 || pointCount > 100_000_000) {
    throw new Error('SPC 点数无效')
  }

  const use16Bit = (flags & 0x01) !== 0
  const bytesPerPoint = use16Bit ? 2 : 4
  const subHeaderMarker = buffer[30] ?? 0
  // 部分 Thermo 文件在标准头后附加 44 字节子头（首字节 'K'）。
  const dataOffset = headerSize + (subHeaderMarker === 0x4b ? 44 : 0)
  const required = dataOffset + pointCount * bytesPerPoint
  if (buffer.length < required) {
    throw new Error(`SPC 数据区不完整：需要 ${required} 字节，实际 ${buffer.length} 字节`)
  }

  const y: number[] = []
  const scale = use16Bit ? 2 ** exponent : 1
  for (let index = 0; index < pointCount; index += 1) {
    const offset = dataOffset + index * bytesPerPoint
    if (use16Bit) {
      const raw = littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
      y.push(raw * scale)
    } else {
      y.push(littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset))
    }
  }

  // ftflgs bit1 置位时，X 数组紧随 Y 数组之后（float32）。
  const storedXOffset = dataOffset + pointCount * bytesPerPoint
  let x: number[]
  if ((flags & 0x02) !== 0 && buffer.length >= storedXOffset + pointCount * 4) {
    x = []
    for (let index = 0; index < pointCount; index += 1) {
      const offset = storedXOffset + index * 4
      x.push(littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset))
    }
  } else if (pointCount > 1) {
    const step = (lastX - firstX) / (pointCount - 1)
    x = Array.from({ length: pointCount }, (_, index) => firstX + step * index)
  } else {
    x = [firstX]
  }

  return buildDataset({
    format: 'thermo-spc',
    xLabel: 'Wavenumber',
    xUnit: 'cm⁻¹',
    seriesLabels: [{ label: 'Intensity' }],
    x,
    series: [y],
    metadata: {
      spcVersion: `0x${(buffer[3] ?? 0).toString(16).padStart(2, '0')}`,
      spcFlags: `0x${flags.toString(16).padStart(2, '0')}`,
      exponent: String(exponent),
      pointCount: String(pointCount),
      endianness: littleEndian ? 'little-endian' : 'big-endian',
    },
  })
}
