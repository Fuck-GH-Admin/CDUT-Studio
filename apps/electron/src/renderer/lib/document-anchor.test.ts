import { describe, expect, test } from 'bun:test'
import { DOCUMENT_ANCHOR_PATTERN } from '@profer/shared'
import { DOCUMENT_ANCHOR_RE } from './document-anchor'

describe('对话流双轨定位胶囊解析', () => {
  test('渲染层正则与 shared 单一事实源一致', () => {
    expect(DOCUMENT_ANCHOR_RE.source).toBe(DOCUMENT_ANCHOR_PATTERN)
  })

  const validCases = [
    '#f1:p2-b3',
    '#f2:p10-b1',
    '#f3:p1-cC4',
    '#f3:p1-B4:E10',
    '#f3:p1-tbl1',
    '#f4:p5-r12',
    '#p3-b2',
    '#p10',
  ]
  for (const anchor of validCases) {
    test(`接受合法锚点：${anchor}`, () => {
      expect(DOCUMENT_ANCHOR_RE.test(anchor)).toBe(true)
    })
  }

  const invalidCases = [
    '#f1:page2-block3',
    '<bubble anchor="#f1">',
    '#f1:p2-b3#extra',
    'plain_text_anchor',
  ]
  for (const invalid of invalidCases) {
    test(`拒绝非法锚点：${invalid}`, () => {
      expect(DOCUMENT_ANCHOR_RE.test(invalid)).toBe(false)
    })
  }
})
