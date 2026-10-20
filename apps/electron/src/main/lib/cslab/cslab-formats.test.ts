/**
 * CSLab 多格式解析器测试
 */

import { describe, expect, test } from 'bun:test'
import { parseDelimitedText } from './cslab-formats/header-data-separator'
import { parseMatLevel5 } from './cslab-formats/mat-level5'
import { parseSpc } from './cslab-formats/spc'
import { parseJcampDx } from './cslab-formats/jcamp'
import { parseBrukerRaw } from './cslab-formats/xrd'
import { sniffFormat } from './cslab-formats/sniff'

function matElement(type: number, data: Buffer): Buffer {
  const padding = data.length % 8 === 0 ? 0 : 8 - (data.length % 8)
  const head = Buffer.alloc(8)
  head.writeUInt32LE(type, 0)
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, Buffer.alloc(padding)])
}

function matSmallElement(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE((data.length << 16) | type, 0)
  data.copy(head, 4)
  return head
}

function buildMatFile(): Buffer {
  const header = Buffer.alloc(128)
  header.write('MATLAB 5.0 MAT-file, Created by: CSLab test', 0, 'latin1')
  header.write('IM', 126, 'latin1')

  // Array Flags: uint32 x2 —— flags=0，class=6（double）
  const flagsData = Buffer.alloc(8)
  flagsData.writeUInt32LE(0, 0)
  flagsData.writeUInt32LE(6, 4)
  const flags = matElement(6, flagsData)

  // Dimensions: int32 [3, 2]
  const dimsData = Buffer.alloc(8)
  dimsData.writeInt32LE(3, 0)
  dimsData.writeInt32LE(2, 4)
  const dims = matElement(5, dimsData)

  // Name: small int8 "A"
  const name = matSmallElement(1, Buffer.from('A\0\0\0', 'latin1'))

  // Real: double 列主序 [1,2,3, 10,20,30]
  const realData = Buffer.alloc(48)
  ;[1, 2, 3, 10, 20, 30].forEach((value, index) => {
    realData.writeDoubleLE(value, index * 8)
  })
  const real = matElement(9, realData)

  const matrix = matElement(14, Buffer.concat([flags, dims, name, real]))
  return Buffer.concat([header, matrix])
}

function buildSpcFile(): Buffer {
  const header = Buffer.alloc(512)
  header[0] = 0x4d
  header[1] = 0x4c
  header[2] = 0 // 32-bit float Y 值
  header[3] = 0x4b
  header.writeUInt32LE(4, 6)
  header.writeDoubleLE(10, 10)
  header.writeDoubleLE(13, 18)

  const data = Buffer.alloc(16)
  ;[1, 2, 3, 4].forEach((value, index) => data.writeFloatLE(value, index * 4))
  return Buffer.concat([header, data])
}

describe('HeaderDataSeparator', () => {
  test('自动识别制表符、表头单位与元数据', () => {
    const text = [
      '# Instrument: CHI760E',
      'Potential / V\tCurrent / mA',
      '0.1\t1.25',
      '0.2\t1.30',
      '0.3\t1.35',
    ].join('\n')

    const result = parseDelimitedText(text, 'chi')
    expect(result.delimiter).toBe('\t')
    expect(result.dataStartRow).toBe(2)
    expect(result.dataset.rowCount).toBe(3)
    expect(result.dataset.columns[0]?.label).toBe('Potential')
    expect(result.dataset.columns[0]?.unit).toBe('V')
    expect(result.dataset.columns[1]?.label).toBe('Current')
    expect(result.dataset.columns[1]?.unit).toBe('mA')
    expect(result.dataset.series.y1).toEqual([1.25, 1.3, 1.35])
    expect(result.metadata.Instrument).toBe('CHI760E')
  })

  test('拒绝纯日志文本', () => {
    expect(() => parseDelimitedText('just a log line\nanother line')).toThrow()
  })
})

describe('MATLAB Level 5', () => {
  test('解析双击列主序矩阵并拆分 X/Y', () => {
    const dataset = parseMatLevel5(buildMatFile())
    expect(dataset.format).toBe('matlab-level5')
    expect(dataset.x).toEqual([1, 2, 3])
    expect(dataset.series.y1).toEqual([10, 20, 30])
    expect(dataset.rowCount).toBe(3)
  })
})

describe('Thermo SPC', () => {
  test('解析 32 位浮点 Y 与线性 X', () => {
    const dataset = parseSpc(buildSpcFile())
    expect(dataset.series.y1).toEqual([1, 2, 3, 4])
    expect(dataset.x).toEqual([10, 11, 12, 13])
    expect(dataset.rowCount).toBe(4)
  })
})

describe('JCAMP-DX', () => {
  test('解析压缩 X++(Y..Y) 数据行', () => {
    const text = [
      '##TITLE=Test',
      '##FIRSTX=1',
      '##LASTX=2',
      '##NPOINTS=3',
      '##XYDATA=(X++(Y..Y))',
      '1 10 20 30',
      '##END=',
    ].join('\n')
    const dataset = parseJcampDx(text)
    expect(dataset.series.y1).toEqual([10, 20, 30])
    expect(dataset.x).toEqual([1, 1.5, 2])
  })
})

describe('Bruker RAW', () => {
  test('从二进制头部后恢复等步长扫描序列', () => {
    const header = Buffer.alloc(512)
    header.write('RAW 1.01', 0, 'latin1')
    const points = 120
    const data = Buffer.alloc(points * 16)
    for (let index = 0; index < points; index += 1) {
      data.writeDoubleLE(10 + index * 0.02, index * 16)
      data.writeDoubleLE(100 + index * 3, index * 16 + 8)
    }

    const dataset = parseBrukerRaw(Buffer.concat([header, data]))
    expect(dataset.rowCount).toBe(points)
    expect(dataset.x[1]).toBeCloseTo(10.02, 6)
    expect(dataset.series.y1?.[1]).toBe(103)
  })
})

describe('格式嗅探', () => {
  test('识别 MAT Level 5 与 SPC', () => {
    expect(sniffFormat('scan.mat', buildMatFile().subarray(0, 128)).format).toBe('mat-level5')
    expect(sniffFormat('spectrum.spc', buildSpcFile().subarray(0, 128)).format).toBe('thermo-spc')
    expect(sniffFormat('scan.raw', Buffer.from('RAW 1.01')).format).toBe('bruker-raw')
    expect(sniffFormat('export.txt', Buffer.from('a,b\n1,2')).format).toBe('text-table')
  })
})
