/**
 * 一次性资产脚本：裁切校徽反白版并校验几何重合。
 *
 * 用法（在 apps/electron 下执行）：
 *   bun run scripts/crop-cdut-white-logo.ts "<反白版源图.png>" [输出路径]
 *
 * 背景：反白版与现有 CDUT-CE.png 有效内容完全一致，仅因 A4 画幅垂直居中
 * 多出上下留白；裁掉 Y=300 起的 1681 行即可得到同尺寸产物。
 * 裁切后必须命中同一 BBox，否则说明偏移量不是 300，需先修正再落盘。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const SRC = process.argv[2]
const OUT = process.argv[3] ?? '../../assets/CDUT/CDUT-CE-white.png'

/** 与 assets/CDUT/CDUT-CE.png 完全一致的裁切窗口 */
const CROP = { x: 0, y: 300, width: 3509, height: 1681 }
/** 原版有效内容包围盒（像素坐标，含端点） */
const EXPECTED_BBOX = { minX: 956, minY: 271, maxX: 2496, maxY: 1460 }

if (!SRC) {
  console.error('缺少源图路径。用法：bun run scripts/crop-cdut-white-logo.ts <源图.png> [输出.png]')
  process.exit(1)
}

/** 扫描 alpha > 0 的像素，求有效内容包围盒 */
function measureBBox(png: PNG): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

const src = PNG.sync.read(readFileSync(SRC))
if (src.width < CROP.x + CROP.width || src.height < CROP.y + CROP.height) {
  throw new Error(`源图尺寸不足：${src.width}x${src.height}，期望至少 ${CROP.x + CROP.width}x${CROP.y + CROP.height}`)
}

const out = new PNG({ width: CROP.width, height: CROP.height })
PNG.bitblt(src, out, CROP.x, CROP.y, CROP.width, CROP.height, 0, 0)
writeFileSync(OUT, PNG.sync.write(out))

const box = measureBBox(out)
console.log(`[裁切校验] 输出 ${OUT} (${out.width}x${out.height})`, box)

const mismatched = (Object.keys(EXPECTED_BBOX) as Array<keyof typeof EXPECTED_BBOX>)
  .filter((key) => box[key] !== EXPECTED_BBOX[key])
if (mismatched.length > 0) {
  throw new Error(
    `裁切后 BBox 与原版不一致（${mismatched.join(', ')}），请检查垂直偏移（应为 ${CROP.y}）`,
  )
}
console.log('[裁切校验] 通过：与原版 BBox 完全重合')
