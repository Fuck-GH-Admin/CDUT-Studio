import { describe, expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { decodeImageDataUrl } from './cslab-image-data'

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

describe('CSLab 图像 dataURL 解码', () => {
  test('Given PNG When 解码 Then 识别 png', () => {
    const png = new PNG({ width: 2, height: 2 })
    png.data.fill(255)
    const decoded = decodeImageDataUrl(dataUrl('image/png', PNG.sync.write(png)))
    expect(decoded.extension).toBe('png')
    expect(decoded.mime).toBe('image/png')
  })

  test('Given WebP 魔数 When 解码 Then 识别 webp', () => {
    const buffer = Buffer.from('RIFF0000WEBP', 'ascii')
    const decoded = decodeImageDataUrl(dataUrl('image/webp', buffer))
    expect(decoded.extension).toBe('webp')
    expect(decoded.mime).toBe('image/webp')
  })

  test('Given JPEG When 解码 Then 识别 jpg', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const decoded = decodeImageDataUrl(dataUrl('image/jpeg', buffer))
    expect(decoded.extension).toBe('jpg')
  })

  test('Given SVG When 解码 Then 识别 svg', () => {
    const buffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8')
    const decoded = decodeImageDataUrl(dataUrl('image/svg+xml', buffer))
    expect(decoded.extension).toBe('svg')
  })

  test('Given 非图像 dataURL When 解码 Then 明确报错', () => {
    expect(() => decodeImageDataUrl('data:text/plain;base64,aGVsbG8=')).toThrow('图像 dataURL')
  })
})
