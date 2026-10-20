/**
 * CSLab Track Changes 与 OOXML 双向转换测试
 */

import { describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import {
  assertCommentsParts,
  exportManuscriptToDocx,
  importDocx,
  suggestionIdToWordId,
  type OoxmlImportInline,
} from './cslab-ooxml'
import { planSuggestionApplication, type CsLabDocBlock } from '@profer/shared'

const NOW = Date.parse('2026-10-20T08:00:00.000Z')

const TRACKED_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '原始结论',
          marks: [
            {
              type: 'deletion',
              attrs: {
                suggestionId: 'suggest-del',
                authorName: '方法论审稿人',
                personaType: 'Methodology_Reviewer',
                createdAt: NOW,
              },
            },
          ],
        },
        {
          type: 'text',
          text: '修正后的结论',
          marks: [
            {
              type: 'insertion',
              attrs: {
                suggestionId: 'suggest-del',
                authorName: '方法论审稿人',
                personaType: 'Methodology_Reviewer',
                createdAt: NOW,
              },
            },
          ],
        },
        {
          type: 'text',
          text: '需要补充引用',
          marks: [
            {
              type: 'comment',
              attrs: {
                suggestionId: 'comment-1',
                commentText: '此处应引用 2024 年 Nature 论文',
                authorName: '文献专家',
                personaType: 'Literature_Expert',
                createdAt: NOW,
              },
            },
          ],
        },
      ],
    },
  ],
}

async function loadParts(buffer: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const parts = new Map<string, string>()
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]?.dir) continue
    parts.set(name, (await zip.file(name)?.async('string')) ?? '')
  }
  return parts
}

describe('suggestion id 稳定映射', () => {
  test('同一字符串稳定、为正整数、不同字符串不同', () => {
    const a = suggestionIdToWordId('suggest-del')
    expect(a).toBe(suggestionIdToWordId('suggest-del'))
    expect(a).toBeGreaterThan(0)
    expect(Number.isInteger(a)).toBe(true)
    expect(suggestionIdToWordId('suggest-other')).not.toBe(a)
  })
})

describe('OOXML 导出：修订与批注', () => {
  test('生成 w:ins / w:del(delText) / comments 三件套', async () => {
    const buffer = await exportManuscriptToDocx({
      title: '修订测试',
      docJson: TRACKED_DOC,
      capsules: [],
    })
    const parts = await loadParts(buffer)
    const documentXml = parts.get('word/document.xml') ?? ''

    expect(documentXml).toContain('<w:ins ')
    expect(documentXml).toContain('w:author="方法论审稿人"')
    expect(documentXml).toContain('<w:del ')
    expect(documentXml).toContain('<w:delText xml:space="preserve">原始结论</w:delText>')
    // 删除内容绝不能出现在普通 w:t 中。
    expect(documentXml).not.toContain('<w:t xml:space="preserve">原始结论</w:t>')
    expect(documentXml).toContain('<w:commentRangeStart ')
    expect(documentXml).toContain('<w:commentRangeEnd ')
    expect(documentXml).toContain('<w:commentReference ')

    const commentsXml = parts.get('word/comments.xml') ?? ''
    expect(commentsXml).toContain('<w:comments')
    expect(commentsXml).toContain('此处应引用 2024 年 Nature 论文')
    expect(commentsXml).toContain('w:author="文献专家"')

    const rels = parts.get('word/_rels/document.xml.rels') ?? ''
    expect(rels).toContain('relationships/comments')
    expect(rels).toContain('Target="comments.xml"')

    const contentTypes = parts.get('[Content_Types].xml') ?? ''
    expect(contentTypes).toContain('PartName="/word/comments.xml"')
    expect(contentTypes).toContain('wordprocessingml.comments+xml')
  })

  test('同一 suggestion 的两段文本共享整数 id', async () => {
    const buffer = await exportManuscriptToDocx({
      title: 'id 一致性',
      docJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'AB',
                marks: [{ type: 'insertion', attrs: { suggestionId: 'same', authorName: 'AI', createdAt: NOW } }],
              },
              {
                type: 'text',
                text: 'CD',
                marks: [{ type: 'insertion', attrs: { suggestionId: 'same', authorName: 'AI', createdAt: NOW } }],
              },
            ],
          },
        ],
      },
      capsules: [],
    })
    const documentXml = (await loadParts(buffer)).get('word/document.xml') ?? ''
    const ids = [...documentXml.matchAll(/<w:ins w:id="(\d+)"/g)].map((match) => match[1])
    expect(ids.length).toBe(2)
    expect(ids[0]).toBe(ids[1])
  })

  test('无评论时不生成 comments 部件', async () => {
    const buffer = await exportManuscriptToDocx({
      title: '无评论',
      docJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '纯文本' }] }],
      },
      capsules: [],
    })
    const parts = await loadParts(buffer)
    expect(parts.has('word/comments.xml')).toBe(false)
    expect(parts.get('[Content_Types].xml') ?? '').not.toContain('/word/comments.xml')
  })

  test('assertCommentsParts 对缺项明确抛错', () => {
    expect(() =>
      assertCommentsParts({
        hasComments: true,
        commentsXml: undefined,
        documentRels: 'relationships/comments',
        contentTypes: 'PartName="/word/comments.xml"',
      }),
    ).toThrow()
    expect(() =>
      assertCommentsParts({
        hasComments: true,
        commentsXml: '<w:comments/>',
        documentRels: 'no-rel-here',
        contentTypes: 'PartName="/word/comments.xml"',
      }),
    ).toThrow()
    expect(() =>
      assertCommentsParts({
        hasComments: true,
        commentsXml: '<w:comments/>',
        documentRels: 'relationships/comments',
        contentTypes: 'nothing',
      }),
    ).toThrow()
    expect(() =>
      assertCommentsParts({
        hasComments: false,
        documentRels: '',
        contentTypes: '',
      }),
    ).not.toThrow()
  })
})

describe('OOXML 导入：Word 修订与批注回读', () => {
  test('ins / del / commentRange 转为结构化 inline', async () => {
    const buffer = await exportManuscriptToDocx({
      title: '往返测试',
      docJson: TRACKED_DOC,
      capsules: [],
    })
    const imported = await importDocx(buffer)
    const inlines = imported.blocks[0]?.inlines ?? []
    const texts = inlines.filter(
      (inline): inline is Extract<OoxmlImportInline, { kind: 'text' }> => inline.kind === 'text',
    )

    const deletion = texts.find((inline) => inline.text === '原始结论')
    expect(deletion?.track?.kind).toBe('deletion')
    expect(deletion?.track?.author).toBe('方法论审稿人')

    const insertion = texts.find((inline) => inline.text === '修正后的结论')
    expect(insertion?.track?.kind).toBe('insertion')

    const commented = texts.find((inline) => inline.text === '需要补充引用')
    expect(commented?.comments?.[0]?.text).toContain('Nature')
    expect(commented?.comments?.[0]?.author).toBe('文献专家')
  })

  test('往返后文本与修订集合稳定', async () => {
    const first = await exportManuscriptToDocx({ title: '往返', docJson: TRACKED_DOC, capsules: [] })
    const imported = await importDocx(first)
    const texts = imported.blocks.flatMap((block) =>
      block.inlines
        .filter((inline): inline is Extract<OoxmlImportInline, { kind: 'text' }> => inline.kind === 'text')
        .map((inline) => inline.text),
    )
    expect(texts.join('')).toContain('原始结论')
    expect(texts.join('')).toContain('修正后的结论')
    expect(texts.join('')).toContain('需要补充引用')
  })
})

describe('跨块切片计划', () => {
  const blocks: CsLabDocBlock[] = [
    { start: 1, text: '第一段结尾', blockType: 'paragraph' },
    { start: 10, text: '第二段开头与其余', blockType: 'paragraph' },
  ]

  test('单块唯一命中', () => {
    const plan = planSuggestionApplication(blocks, '第二段开头')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.slices).toHaveLength(1)
    expect(plan.slices[0]!.from).toBe(10)
    expect(plan.slices[0]!.to).toBe(10 + '第二段开头'.length)
  })

  test('跨块命中切成两段', () => {
    const plan = planSuggestionApplication(blocks, '结尾第二段')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.slices.length).toBe(2)
    expect(plan.slices[0]!.blockType).toBe('paragraph')
    expect(plan.slices[1]!.from).toBe(10)
  })

  test('多处歧义与未命中显式失败', () => {
    const ambiguous = planSuggestionApplication(
      [{ start: 1, text: '重复重复', blockType: 'paragraph' }],
      '重复',
    )
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.reason).toBe('quote-ambiguous')

    const missing = planSuggestionApplication(blocks, '不存在的句子')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('quote-not-found')

    const empty = planSuggestionApplication(blocks, '   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('quote-empty')
  })
})
