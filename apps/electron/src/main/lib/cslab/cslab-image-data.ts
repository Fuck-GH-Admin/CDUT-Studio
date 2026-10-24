/**
 * CSLab 图像 dataURL 解码
 *
 * 仅做格式识别与 Buffer 解包；不做像素处理。
 * SVG 可解码/落盘，但图表数字化前必须栅格化（由调用方明确拒绝）。
 */

import { promises as fs } from 'node:fs'
import { extname } from 'node:path'

export const MAX_IMAGE_BYTES = 24 * 1024 * 1024

export interface DecodedImage {
  buffer: Buffer
  extension: string
  mime: string
}

function sniffExtension(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg'
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'gif'
  }
  const head = buffer.toString('utf-8', 0, Math.min(256, buffer.length)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg'
  return fallback
}

export function mimeForExtension(extension: string): string {
  switch (extension.toLowerCase().replace(/^\./, '')) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    case 'avif':
      return 'image/avif'
    default:
      return 'application/octet-stream'
  }
}

export function decodeImageDataUrl(dataUrl: string): DecodedImage {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('图像 dataURL 格式无效')
  const declared = match[1]!.split('/')[1] ?? ''
  const buffer = Buffer.from(match[2]!.replace(/\s/g, ''), 'base64')
  if (buffer.length === 0) throw new Error('图像数据为空')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图像超过 24MB，请缩小图像范围')
  const extension = sniffExtension(buffer, declared === 'jpeg' ? 'jpg' : declared || 'png')
  return { buffer, extension, mime: mimeForExtension(extension) }
}

export async function fileToImageDataUrl(path: string): Promise<DecodedImage & { dataUrl: string }> {
  const buffer = await fs.readFile(path)
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图像超过 24MB，请缩小图像范围')
  const extension = sniffExtension(buffer, extname(path).replace(/^\./, '') || 'png')
  const mime = mimeForExtension(extension)
  return {
    buffer,
    extension,
    mime,
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
  }
}
