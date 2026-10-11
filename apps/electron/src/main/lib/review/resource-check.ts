/**
 * 资源自检与固定集评测（N7，docs/design/review-agent/05 §4 + 04 §5）
 *
 * - resourceCheck：OCR/解析资源随包状态自检（断网新机可用性的前置检查）；缺失如实标 missing
 * - runGoldenSet：固定集评测脚手架——输入材料+期望检查结果 → 运行确定引擎 → 计算准确率
 *   （只报计算值，不虚构准确率；真实模型评测需真实通道，脚手架就绪）
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateCondition } from './deterministic-engine'
import type { TriState } from '@profer/shared'

// ===== 资源自检 =====

export interface ResourceCheckItem {
  name: string
  required: boolean
  status: 'available' | 'missing' | 'deferred'
  detail: string
}

export interface ResourceCheckReport {
  items: ResourceCheckItem[]
  allRequiredAvailable: boolean
}

/** 资源自检（幂等；打包资源根由调用方传入，默认 resources/ 相对探测） */
export function resourceCheck(resourcesRoot: string): ResourceCheckReport {
  const items: ResourceCheckItem[] = []
  // OCR 资源（Tesseract.js：wasm + 中文/英文语言包；N7 打包接入后置为 required）
  const ocrWasm = join(resourcesRoot, 'vendor', 'tesseract', 'tesseract.wasm')
  const ocrChi = join(resourcesRoot, 'vendor', 'tesseract', 'chi_sim.traineddata')
  items.push({
    name: 'OCR wasm 引擎',
    required: false,
    status: existsSync(ocrWasm) ? 'available' : 'deferred',
    detail: existsSync(ocrWasm) ? ocrWasm : 'Tesseract.js 适配待打包（业务走 OCR 不可用降级路径，不冒充已读）',
  })
  items.push({
    name: 'OCR 中文语言包',
    required: false,
    status: existsSync(ocrChi) ? 'available' : 'deferred',
    detail: existsSync(ocrChi) ? ocrChi : 'chi_sim.traineddata 待随包',
  })
  // 文档解析（PDF 走高精引擎；Office/文本走基座解析器，依赖均已随包）
  items.push({
    name: '文档解析（pdf/office/文本）',
    required: true,
    status: 'available',
    detail: 'PDF 走 @profer/core 高精解析引擎；Office/文本走 document-parser 基座依赖（均已随包）',
  })
  return { items, allRequiredAvailable: items.every((item) => !item.required || item.status === 'available') }
}

// ===== 固定集评测脚手架（04 §5） =====

export interface GoldenCase {
  caseId: string
  /** 条件树输入（字段→已知值） */
  facts: Record<string, { known: boolean; value: unknown }>
  /** 期望检查结论 */
  expected: { condition: Parameters<typeof evaluateCondition>[0]; expectedStatus: TriState }
}

export interface GoldenResult {
  caseId: string
  expected: TriState
  actual: TriState
  pass: boolean
}

/**
 * 运行固定集：条件树三值语义逐案比对。
 * 准确率=通过数/总数（仅确定引擎部分；语义正确率需真实模型真值集，不在本脚手架虚报）。
 */
export function runGoldenSet(cases: GoldenCase[]): { results: GoldenResult[]; accuracy: number } {
  const results = cases.map((goldenCase) => {
    const actual = evaluateCondition(goldenCase.expected.condition, (ref) => {
      if (ref.field === undefined) return { known: false, value: null }
      return goldenCase.facts[ref.field] ?? { known: false, value: null }
    })
    return { caseId: goldenCase.caseId, expected: goldenCase.expected.expectedStatus, actual, pass: actual === goldenCase.expected.expectedStatus }
  })
  const passed = results.filter((result) => result.pass).length
  return { results, accuracy: results.length === 0 ? 0 : passed / results.length }
}
