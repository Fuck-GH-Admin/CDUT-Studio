/**
 * CSLab 实证解析与图表抽取测试
 *
 * 覆盖：Markdown 表格指标抽取（表头识别 / 单位归一化 / ± 不确定度 / 基线列 / 非数值跳过 / 上限）、
 * PNG 合法封装（签名 / IHDR / IDAT 可逆 / 参数校验）、PDF 图像流提取
 * （JPEG 直存、裸像素封装 PNG、位置+顺序配对、vector-unsampled 回填、失败容错）。
 *
 * 红线：全程注入假 pdfjs 模块，不加载 node:sqlite、不联网、不解析真实 PDF。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaperFigureAsset } from '@profer/shared'
import type { ExtractPaperFiguresOptions, FigureBlock, PdfJsLike } from './cslab-empirical-parser'

let rootDir = ''
let labRoot = ''
let mod: typeof import('./cslab-empirical-parser')

const LAB_ID = 'empirical-parser-test'
const PAPER_SLUG = 'paper-one'

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-empirical-'))
  // 必须在加载模块前隔离配置根目录（resolveLabDir 读取 cslab-workspaces 索引）
  process.env.PROFER_CONFIG_DIR = rootDir
  const { ensureLabLayout } = await import('./cslab-paths')
  labRoot = join(rootDir, 'lab-root')
  ensureLabLayout(LAB_ID, labRoot)
  mod = await import('./cslab-empirical-parser')
})

afterAll(() => {
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放，临时目录交还系统回收。
  }
})

// ===== 假 pdfjs 模块（绝不加载真实 pdfjs-dist） =====

const FAKE_OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  paintImageXObject: 4,
  paintJpegXObject: 5,
  paintImageMaskXObject: 6,
}

interface FakeOp {
  fn: keyof typeof FAKE_OPS
  args: unknown[]
}

interface FakePageSpec {
  /** 用户空间可视区（[x0,y0,x1,y1]，y 向上）；缺省时无位置信息 */
  view?: number[]
  /** 视口高度；与 view 二选一提供位置信息 */
  height?: number
  ops: FakeOp[]
  objs: Record<string, unknown>
  failOperatorList?: boolean
}

interface FakePdfSpec {
  numPages: number
  pages: Record<number, FakePageSpec>
  failGetDocument?: boolean
  /** objs.get 抛错的 objId（模拟对象未解析） */
  throwObjIds?: string[]
}

function makeFakePdfjs(spec: FakePdfSpec): PdfJsLike {
  return {
    OPS: FAKE_OPS,
    getDocument() {
      return {
        promise: spec.failGetDocument
          ? Promise.reject(new Error('PDF 打开失败'))
          : Promise.resolve({
              numPages: spec.numPages,
              async getPage(pageNumber: number) {
                const pageSpec = spec.pages[pageNumber]
                if (!pageSpec) throw new Error('页不存在')
                return {
                  ...(pageSpec.view ? { view: pageSpec.view } : {}),
                  ...(pageSpec.height
                    ? { getViewport: () => ({ width: 612, height: pageSpec.height! }) }
                    : {}),
                  async getOperatorList() {
                    if (pageSpec.failOperatorList) throw new Error('算子表读取失败')
                    return {
                      fnArray: pageSpec.ops.map((op) => FAKE_OPS[op.fn]),
                      argsArray: pageSpec.ops.map((op) => op.args),
                    }
                  },
                  objs: {
                    get(id: unknown) {
                      const key = String(id)
                      if (spec.throwObjIds?.includes(key)) throw new Error('对象未解析')
                      if (!(key in pageSpec.objs)) throw new Error('对象不存在')
                      return pageSpec.objs[key]
                    },
                  },
                }
              },
              async destroy() {},
            }),
      }
    },
  }
}

/** 绘制一张图像的最小算子序列：save → transform（单位正方形→放置框）→ paint → restore */
function imageOps(fn: keyof typeof FAKE_OPS, objId: string, placement?: [number, number, number, number]): FakeOp[] {
  const ops: FakeOp[] = [{ fn: 'save', args: [] }]
  if (placement) {
    const [x, y, w, h] = placement
    ops.push({ fn: 'transform', args: [w, 0, 0, h, x, y] })
  }
  ops.push({ fn, args: [objId] })
  ops.push({ fn: 'restore', args: [] })
  return ops
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
const RAW_RGB = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) // 2x2 RGB

function attachmentPath(relPath: string): string {
  return join(labRoot, 'vault', 'notes', relPath)
}

function runExtract(overrides: Partial<ExtractPaperFiguresOptions>): Promise<PaperFigureAsset[]> {
  return mod.extractPaperFigures({
    labId: LAB_ID,
    paperSlug: PAPER_SLUG,
    pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    figureBlocks: [],
    ...overrides,
  })
}

// ===== A. 数值指标抽取 =====

describe('parseEmpiricalMetricsFromMarkdown', () => {
  test('典型表格：单位归一化、± 不确定度、基线/条件列、非数值行跳过', () => {
    const markdown = [
      '## 3. 结果',
      '',
      '| 指标 | 数值 | 单位 | 基线 | 条件 |',
      '| --- | --- | --- | --- | --- |',
      '| 禁带宽度 | 1.42 | eV | 1.36 | 300 K |',
      '| 转化率 | 95.2 ± 0.3 | ％ | 91.0 | 25 ℃ |',
      '| 粒径 | 2.5e2 | nm | — | — |',
      '| 样品状态 | 红色粉末 | | | |',
      '',
      '正文段落不参与抽取。',
    ].join('\n')

    const metrics = mod.parseEmpiricalMetricsFromMarkdown(markdown, 3)
    expect(metrics).toHaveLength(3)
    expect(metrics[0]).toEqual({
      name: '禁带宽度',
      value: 1.42,
      unit: 'eV',
      baseline: 1.36,
      condition: '300 K',
      page: 3,
    })
    // ± 不确定度并入 value 字符串（主值在前）
    expect(metrics[1]?.value).toBe('95.2 ± 0.3')
    expect(metrics[1]?.unit).toBe('%')
    expect(metrics[1]?.baseline).toBe(91)
    expect(metrics[1]?.condition).toBe('25 ℃')
    expect(metrics[2]).toEqual({ name: '粒径', value: 250, unit: 'nm', page: 3 })
  })

  test('英文表头 + 数值单元格内单位 + 科学计数法 + 指标名括号单位', () => {
    const markdown = [
      '| Parameter | Value | Baseline |',
      '| --- | --- | --- |',
      '| Band gap | 1.55e0 eV | 1.50 |',
      '| Conductivity | 3.2e-2 S/cm | — |',
      '| Carrier lifetime (ns) | 12.6 | 10 |',
    ].join('\n')

    const metrics = mod.parseEmpiricalMetricsFromMarkdown(markdown, 2)
    expect(metrics).toHaveLength(3)
    expect(metrics[0]?.unit).toBe('eV')
    expect(metrics[0]?.value).toBe(1.55)
    expect(metrics[1]?.unit).toBe('S/cm')
    expect(metrics[1]?.value).toBeCloseTo(0.032)
    expect(metrics[1]?.baseline).toBeUndefined()
    // 单元格无单位时从指标名括号回填
    expect(metrics[2]?.name).toBe('Carrier lifetime')
    expect(metrics[2]?.unit).toBe('ns')
    expect(metrics[2]?.baseline).toBe(10)
  })

  test('单位归一化：℃/μm/um/MPa/kg/m³/Å/m/s', () => {
    const units = ['℃', 'μm', 'um', 'MPa', 'kg/m^3', 'Å', 'm/s']
    const rows = units.map((unit, i) => `| m${i} | 1 | ${unit} |`).join('\n')
    const markdown = ['| 指标 | 数值 | 单位 |', '| --- | --- | --- |', rows].join('\n')

    const metrics = mod.parseEmpiricalMetricsFromMarkdown(markdown, 1)
    expect(metrics.map((m) => m.unit)).toEqual(['°C', 'µm', 'µm', 'MPa', 'kg/m³', 'Å', 'm/s'])
  })

  test('表头未识别时按数据列推断 value 列', () => {
    const markdown = ['| A | B |', '| --- | --- |', '| foo | 3.5 |', '| bar | 4.5 |'].join('\n')
    const metrics = mod.parseEmpiricalMetricsFromMarkdown(markdown, 1)
    expect(metrics).toHaveLength(2)
    expect(metrics[0]).toEqual({ name: 'foo', value: 3.5, page: 1 })
    expect(metrics[1]).toEqual({ name: 'bar', value: 4.5, page: 1 })
  })

  test('空输入/无表格/全非数值返回空数组', () => {
    expect(mod.parseEmpiricalMetricsFromMarkdown('', 1)).toEqual([])
    expect(mod.parseEmpiricalMetricsFromMarkdown('纯文本没有表格', 1)).toEqual([])
    const markdown = ['| 指标 | 数值 |', '| --- | --- |', '| 状态 | 红色 |', '| 形貌 | 片状 |'].join('\n')
    expect(mod.parseEmpiricalMetricsFromMarkdown(markdown, 1)).toEqual([])
  })

  test('每页上限 200 条防爆', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `| m${i} | ${i} |`).join('\n')
    const markdown = ['| 指标 | 数值 |', '| --- | --- |', rows].join('\n')
    const metrics = mod.parseEmpiricalMetricsFromMarkdown(markdown, 1)
    expect(metrics).toHaveLength(200)
  })
})

// ===== B. PNG 合法封装 =====

describe('encodePngFromRgba', () => {
  test('RGB：PNG 签名 + IHDR 宽高 + IDAT 可无损还原', () => {
    const png = mod.encodePngFromRgba(RAW_RGB, 2, 2, 3)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(8)).toBe(13)
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(2) // 宽
    expect(png.readUInt32BE(20)).toBe(2) // 高
    expect(png[24]).toBe(8) // 位深
    expect(png[25]).toBe(2) // colorType：RGB
    expect(png.includes(Buffer.from('IEND'))).toBe(true)

    const idatType = png.indexOf(Buffer.from('IDAT'))
    const idatLength = png.readUInt32BE(idatType - 4)
    const raw = inflateSync(png.subarray(idatType + 4, idatType + 4 + idatLength))
    // 滤波器 0 + 逐行像素，应逐字节还原
    expect([...raw]).toEqual([
      0, 255, 0, 0, 0, 255, 0,
      0, 0, 0, 255, 255, 255, 255,
    ])
  })

  test('RGBA：colorType 6 且可无损还原', () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const png = mod.encodePngFromRgba(pixels, 2, 1, 4)
    expect(png[25]).toBe(6)
    const idatType = png.indexOf(Buffer.from('IDAT'))
    const idatLength = png.readUInt32BE(idatType - 4)
    const raw = inflateSync(png.subarray(idatType + 4, idatType + 4 + idatLength))
    expect([...raw]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('像素长度与尺寸不符 / 通道非法时抛出', () => {
    expect(() => mod.encodePngFromRgba(RAW_RGB, 3, 3, 3)).toThrow()
    expect(() => mod.encodePngFromRgba(RAW_RGB, 2, 2, 4)).toThrow()
    expect(() => mod.encodePngFromRgba(RAW_RGB, 2, 2, 2 as unknown as 3)).toThrow()
    expect(() => mod.encodePngFromRgba(RAW_RGB, 0, 2, 3)).toThrow()
  })
})

// ===== C. PDF 原生图像流提取 =====

describe('extractPaperFigures', () => {
  test('JPEG 字节直存 .jpg、裸像素封装 .png，位置配对优先于顺序配对', async () => {
    // 绘制顺序：先底部 JPEG、后顶部裸像素；figureBlock 顺序相反
    const spec: FakePdfSpec = {
      numPages: 1,
      pages: {
        1: {
          height: 792,
          ops: [
            ...imageOps('paintJpegXObject', 'imgBottom', [50, 500, 100, 60]),
            ...imageOps('paintImageXObject', 'imgTop', [50, 700, 100, 60]),
          ],
          objs: {
            imgBottom: JPEG_BYTES,
            imgTop: { data: RAW_RGB, width: 2, height: 2, kind: 3 },
          },
        },
      },
    }
    const blocks: FigureBlock[] = [
      { pageNumber: 1, bbox: [40, 20, 160, 100], caption: '图 1 顶部' },
      { pageNumber: 1, bbox: [40, 220, 160, 300], caption: '图 2 底部' },
    ]

    const assets = await runExtract({ figureBlocks: blocks, pdfjsModule: makeFakePdfjs(spec) })
    expect(assets).toHaveLength(2)

    // 位置包含判断：顶部块应配到后绘制的 fig_p1_2.png，而不是顺序上的 fig_p1_1.jpg
    expect(assets[0]?.caption).toBe('图 1 顶部')
    expect(assets[0]?.relPath).toBe(`attachments/${PAPER_SLUG}/fig_p1_2.png`)
    expect(assets[0]?.renderSource).toBe('image-xobject')
    expect(assets[0]?.bbox).toEqual([40, 20, 160, 100])
    expect(assets[1]?.caption).toBe('图 2 底部')
    expect(assets[1]?.relPath).toBe(`attachments/${PAPER_SLUG}/fig_p1_1.jpg`)

    // JPEG 直存：字节原样落盘
    const jpg = readFileSync(attachmentPath(`attachments/${PAPER_SLUG}/fig_p1_1.jpg`))
    expect([...jpg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(jpg.length).toBe(JPEG_BYTES.length)

    // 裸像素封装：合法 PNG 且像素可还原
    const png = readFileSync(attachmentPath(`attachments/${PAPER_SLUG}/fig_p1_2.png`))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const idatType = png.indexOf(Buffer.from('IDAT'))
    const idatLength = png.readUInt32BE(idatType - 4)
    const raw = inflateSync(png.subarray(idatType + 4, idatType + 4 + idatLength))
    // 滤波器 0 逐行剥离后应还原为原始像素
    const restored = Buffer.concat([raw.subarray(1, 7), raw.subarray(8, 14)])
    expect([...restored]).toEqual([...RAW_RGB])
  })

  test('figureBlock 未配对 → vector-unsampled；提取出但未配对的图像 → caption 空串', async () => {
    const spec: FakePdfSpec = {
      numPages: 3,
      pages: {
        2: { ops: [], objs: {} },
        3: {
          ops: imageOps('paintJpegXObject', 'lonely', [10, 10, 20, 20]),
          objs: { lonely: JPEG_BYTES },
        },
      },
    }
    const blocks: FigureBlock[] = [
      { pageNumber: 2, bbox: [40, 40, 300, 200], caption: '图 2 矢量图' },
    ]

    const assets = await runExtract({ figureBlocks: blocks, pdfjsModule: makeFakePdfjs(spec) })
    expect(assets).toHaveLength(2)

    const vectorAsset = assets.find((a) => a.caption === '图 2 矢量图')
    expect(vectorAsset?.renderSource).toBe('vector-unsampled')
    expect(vectorAsset?.relPath).toBeUndefined()
    expect(vectorAsset?.bbox).toEqual([40, 40, 300, 200])

    const lonelyImage = assets.find((a) => a.caption === '')
    expect(lonelyImage?.renderSource).toBe('image-xobject')
    expect(lonelyImage?.relPath).toBe(`attachments/${PAPER_SLUG}/fig_p3_1.jpg`)
    expect(existsSync(attachmentPath(lonelyImage!.relPath!))).toBe(true)
  })

  test('无位置信息时按同页绘制顺序配对', async () => {
    const spec: FakePdfSpec = {
      numPages: 1,
      pages: {
        1: {
          ops: imageOps('paintJpegXObject', 'only'),
          objs: { only: JPEG_BYTES },
        },
      },
    }
    const blocks: FigureBlock[] = [
      { pageNumber: 1, bbox: [0, 0, 600, 800], caption: '图 1' },
    ]

    const assets = await runExtract({ figureBlocks: blocks, pdfjsModule: makeFakePdfjs(spec) })
    expect(assets).toHaveLength(1)
    expect(assets[0]?.caption).toBe('图 1')
    expect(assets[0]?.relPath).toBe(`attachments/${PAPER_SLUG}/fig_p1_1.jpg`)
    expect(assets[0]?.renderSource).toBe('image-xobject')
  })

  test('容错红线：getDocument 失败 / objs.get 抛错 / 未知图像格式均不抛出', async () => {
    const blocks: FigureBlock[] = [
      { pageNumber: 1, bbox: [10, 10, 100, 100], caption: '图 1' },
    ]

    // 1) pdfjs 打开失败：回填矢量占位
    const failAssets = await runExtract({
      figureBlocks: blocks,
      pdfjsModule: makeFakePdfjs({ numPages: 1, pages: {}, failGetDocument: true }),
    })
    expect(failAssets).toHaveLength(1)
    expect(failAssets[0]?.renderSource).toBe('vector-unsampled')

    // 2) objs.get 抛错 + 图像格式不明：只跳过坏项，好项照常落盘
    const spec: FakePdfSpec = {
      numPages: 1,
      pages: {
        1: {
          ops: [
            ...imageOps('paintImageXObject', 'broken', [0, 0, 10, 10]),
            ...imageOps('paintImageXObject', 'weird', [0, 20, 10, 10]),
            ...imageOps('paintJpegXObject', 'good', [0, 40, 10, 10]),
          ],
          objs: {
            weird: { data: new Uint8Array(7), width: 2, height: 2 },
            good: JPEG_BYTES,
          },
        },
      },
      throwObjIds: ['broken'],
    }
    const assets = await runExtract({ figureBlocks: [], pdfjsModule: makeFakePdfjs(spec) })
    expect(assets).toHaveLength(1)
    expect(assets[0]?.caption).toBe('')
    expect(assets[0]?.relPath).toBe(`attachments/${PAPER_SLUG}/fig_p1_1.jpg`)

    // 3) 算子表读取失败：整页跳过但不抛出
    const skipAssets = await runExtract({
      figureBlocks: [{ pageNumber: 1, bbox: [0, 0, 10, 10], caption: '图 A' }],
      pdfjsModule: makeFakePdfjs({
        numPages: 1,
        pages: { 1: { ops: [], objs: {}, failOperatorList: true } },
      }),
    })
    expect(skipAssets).toHaveLength(1)
    expect(skipAssets[0]?.renderSource).toBe('vector-unsampled')
  })
})
