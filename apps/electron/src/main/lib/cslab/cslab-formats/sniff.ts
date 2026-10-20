/**
 * 科研仪器文件格式嗅探（扩展名 + 首 128 字节魔数）
 */

import { extname } from 'node:path'
import { isMatLevel5, isMatV73 } from './mat-level5'
import { isSpc } from './spc'

export type CsLabSniffedFormat =
  | 'mat-level5'
  | 'mat-v73'
  | 'bruker-raw'
  | 'rigaku-ras'
  | 'xrdml'
  | 'bruker-brml'
  | 'thermo-spc'
  | 'jcamp-dx'
  | 'biologic-mpr'
  | 'biologic-mpt'
  | 'text-table'
  | 'unknown'

export interface CsLabSniffResult {
  format: CsLabSniffedFormat
  extension: string
  /** 面向用户的说明（降级或识别依据）。 */
  note?: string
}

const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.dat', '.asc', '.dpt', '.tsv', '.prn'])
const XRD_TEXT_EXTENSIONS = new Set(['.ras', '.uxd'])
const JCAMP_EXTENSIONS = new Set(['.dx', '.jdx'])

export function sniffFormat(filePath: string, head: Buffer): CsLabSniffResult {
  const extension = extname(filePath).toLowerCase()

  if (isMatV73(head)) {
    return {
      format: 'mat-v73',
      extension,
      note: 'MATLAB v7.3（HDF5）：需要可选 Python 增强通道（h5py）才能提取数值',
    }
  }
  if (isMatLevel5(head)) return { format: 'mat-level5', extension }
  if (isSpc(head)) return { format: 'thermo-spc', extension }

  if (extension === '.mat') {
    return { format: 'unknown', extension, note: '未识别到 MATLAB MAT 头' }
  }

  if (extension === '.raw') {
    const signature = head.subarray(0, 16).toString('latin1').toUpperCase()
    if (signature.startsWith('RAW')) return { format: 'bruker-raw', extension }
    return { format: 'bruker-raw', extension, note: '未识别到 RAW 文件头，将尝试通用二进制恢复' }
  }

  if (XRD_TEXT_EXTENSIONS.has(extension)) return { format: 'rigaku-ras', extension }
  if (extension === '.xrdml') return { format: 'xrdml', extension }
  if (extension === '.brml') return { format: 'bruker-brml', extension }
  if (JCAMP_EXTENSIONS.has(extension)) return { format: 'jcamp-dx', extension }
  if (extension === '.mpr') return { format: 'biologic-mpr', extension }
  if (extension === '.mpt') return { format: 'biologic-mpt', extension }

  if (TEXT_EXTENSIONS.has(extension)) {
    const text = head.toString('latin1')
    if (/^##TITLE=/im.test(text) || /^##JCAMP-DX=/im.test(text)) {
      return { format: 'jcamp-dx', extension }
    }
    return { format: 'text-table', extension }
  }

  return { format: 'unknown', extension, note: '不支持的文件扩展名' }
}
