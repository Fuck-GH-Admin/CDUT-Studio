/**
 * 下一代非自回归高精 PDF 解析引擎 - 公开入口
 *
 * 对外仅暴露 `parsePdfDocument` 及可独立复用的算法/端口模块。
 */

export * from './types.ts'
export * from './trapdoc-guard.ts'
export * from './pdf-stream-extractor.ts'
export * from './native-segmenter.ts'
export * from './source-preserving-aligner.ts'
export * from './max-regret-router.ts'
export * from './table-decomposer.ts'
export * from './academic-enricher.ts'
export * from './ocr-bridge.ts'
export * from './onnx-adapter.ts'
export * from './document-serializer.ts'
export * from './pdf-engine.ts'
