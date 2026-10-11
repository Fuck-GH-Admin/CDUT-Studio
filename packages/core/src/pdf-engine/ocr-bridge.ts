/**
 * 专用 OCR 信道桥接器（OcrBridge）
 *
 * 版面检测识别为纯位图/扫描区域的片段（figure / 无文本层区域），若注入了可用的
 * OCR 端口，则把识别出的带坐标字块无缝融入排版拓扑图，参与后续对齐与阅读排序。
 *
 * 端口模式：本文件不绑定任何具体 OCR 引擎（Tesseract.js / 外部服务），只定义
 * 结构化契约；未注入或不可用时如实返回空数组，绝不伪造识别结果。
 */

import type { NormalizedBBox } from '@profer/shared'
import type { LayoutNode } from './types'

/** OCR 返回的字块（rect 为原图像素坐标） */
export interface PdfOcrBlock {
  text: string
  rect: { x: number; y: number; w: number; h: number }
  confidence: number
}

export interface PdfOcrResult {
  blocks: PdfOcrBlock[]
  imageWidth: number
  imageHeight: number
}

/** OCR 端口契约（结构可对接 TesseractOcrPort 等实现） */
export interface PdfOcrPort {
  readonly available: boolean
  readonly unavailableReason?: string
  recognize(input: {
    imageBuffer: Uint8Array
    regionBBox: NormalizedBBox
    language?: string
  }): Promise<PdfOcrResult>
}

/** 页面尺寸信息（用于把归一化坐标反算为点坐标） */
export interface OcrPageInfo {
  pageNumber: number
  width: number
  height: number
}

/** 把 OCR 字块矩形（原图像素）变换为页面归一化坐标 */
export function transformToNormalizedBBox(
  rect: PdfOcrBlock['rect'],
  regionBBox: NormalizedBBox,
  imageWidth: number,
  imageHeight: number,
): NormalizedBBox {
  const regionWidth = regionBBox[2] - regionBBox[0]
  const regionHeight = regionBBox[3] - regionBBox[1]
  const safeW = imageWidth > 0 ? imageWidth : 1
  const safeH = imageHeight > 0 ? imageHeight : 1
  const x0 = regionBBox[0] + (rect.x / safeW) * regionWidth
  const y0 = regionBBox[1] + (rect.y / safeH) * regionHeight
  const x1 = regionBBox[0] + ((rect.x + rect.w) / safeW) * regionWidth
  const y1 = regionBBox[1] + ((rect.y + rect.h) / safeH) * regionHeight
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
  return [clamp01(x0), clamp01(y0), clamp01(x1), clamp01(y1)]
}

/**
 * 把图像区域交给 OCR 端口识别，并映射为排版节点。
 *
 * @param imageRegionBuffer 区域裁剪后的图像字节
 * @param regionBBox 区域在页面中的归一化坐标
 * @param ocrPort OCR 端口（可缺省 / 不可用则返回空数组）
 * @param pageInfo 页面尺寸（缺省时点坐标退化为归一化坐标）
 */
export async function bridgeVisualRegionToOcr(
  imageRegionBuffer: Uint8Array,
  regionBBox: NormalizedBBox,
  ocrPort?: PdfOcrPort,
  pageInfo?: OcrPageInfo,
): Promise<LayoutNode[]> {
  if (!ocrPort || !ocrPort.available) return []

  let result: PdfOcrResult
  try {
    result = await ocrPort.recognize({ imageBuffer: imageRegionBuffer, regionBBox })
  } catch (error) {
    console.warn('[PDF引擎] OCR 识别失败，跳过该区域:', error)
    return []
  }

  const pageNumber = pageInfo?.pageNumber ?? 1
  const pageWidth = pageInfo?.width ?? 1
  const pageHeight = pageInfo?.height ?? 1
  const stamp = Date.now().toString(36)

  return result.blocks
    .filter((block) => block.text.trim().length > 0)
    .map((block, index): LayoutNode => {
      const bbox = transformToNormalizedBBox(block.rect, regionBBox, result.imageWidth, result.imageHeight)
      const pointBbox: [number, number, number, number] = [
        bbox[0] * pageWidth,
        bbox[1] * pageHeight,
        bbox[2] * pageWidth,
        bbox[3] * pageHeight,
      ]
      return {
        id: `ocr-blk-${stamp}-${index}`,
        pageNumber,
        kind: 'paragraph',
        text: block.text,
        bbox,
        pointBbox,
        confidence: Math.max(0, Math.min(1, block.confidence)),
        readingStreamId: 0,
        readingOrderIndex: 0,
        isOcrRecognized: true,
      }
    })
}
