import { describe, expect, test } from 'bun:test'
import {
  DOCUMENT_ANCHOR_IN_TEXT_PATTERN,
  DOCUMENT_ANCHOR_PATTERN,
  DOCUMENT_ANCHOR_PATTERN_FLAGS,
} from './document-anchor'

const anchorRe = new RegExp(DOCUMENT_ANCHOR_PATTERN, DOCUMENT_ANCHOR_PATTERN_FLAGS)
const inTextRe = new RegExp(DOCUMENT_ANCHOR_IN_TEXT_PATTERN, DOCUMENT_ANCHOR_PATTERN_FLAGS)

describe('双轨定位锚点语法（单一事实源）', () => {
  const validCases = [
    '#f1:p2-b3',
    '#f2:p10-b1',
    '#f3:p1-cC4',
    '#f3:p1-B4:E10',
    '#f3:p1-tbl1',
    '#f4:p5-r12',
    '#f3:p3-cA10:B10',
    '#p3-b2',
    '#p10',
  ]
  for (const anchor of validCases) {
    test(`接受合法锚点：${anchor}`, () => {
      expect(anchorRe.test(anchor)).toBe(true)
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
      expect(anchorRe.test(invalid)).toBe(false)
    })
  }

  test('文内扫描可提取嵌入正文的裸锚点', () => {
    const match = inTextRe.exec('参见第2页 #f1:p2-b3 的推导')
    expect(match?.[0]).toBe('#f1:p2-b3')
  })
})
