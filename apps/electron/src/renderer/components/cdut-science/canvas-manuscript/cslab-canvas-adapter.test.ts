/**
 * Canvas 适配层单测（纯函数，不加载 Canvas 引擎运行时）
 */

import { describe, expect, test } from 'bun:test'
import type { IElement } from '@hufe921/canvas-editor'
import {
  canvasToTipTapDoc,
  extractCanvasCapsules,
  extractCanvasText,
  findTextRange,
  legacyTipTapToCanvas,
  legacyTipTapToCanvasWithComments,
} from './cslab-canvas-adapter'
import {
  buildCanvasCapsuleControl,
  capsuleExtensionOf,
  type CsLabCapsuleExtension,
} from './cslab-canvas-capsule'
import {
  CsCanvasControlComponent,
  CsCanvasControlType,
  CsCanvasElementType,
  CsCanvasListStyle,
  CsCanvasListType,
  CsCanvasTitleLevel,
  CsCanvasZone,
} from './cslab-canvas-enums'
import type { CsLabCapsuleAttrs } from './cslab-canvas-types'

const CAPSULE_ATTRS: CsLabCapsuleAttrs = {
  capsuleId: 'cap-1',
  label: 'Yield',
  value: '80',
  unit: '%',
  tableUri: 'cdut://lab-1/table/t-1',
  column: 'yield',
  rowIndex: 0,
  revisionAtBind: 3,
  status: 'fresh',
}

function capsuleValueElement(extension: CsLabCapsuleExtension): IElement {
  return {
    value: '8',
    controlComponent: CsCanvasControlComponent.VALUE as never,
    control: {
      type: CsCanvasControlType.TEXT as never,
      value: null,
      extension,
    },
  }
}

describe('Canvas 枚举常量与官方值对齐', () => {
  test('关键字面量逐项一致', () => {
    expect(CsCanvasElementType.TEXT).toBe('text')
    expect(CsCanvasElementType.CONTROL).toBe('control')
    expect(CsCanvasElementType.TITLE).toBe('title')
    expect(CsCanvasElementType.LIST).toBe('list')
    expect(CsCanvasElementType.PAGE_BREAK).toBe('pageBreak')
    expect(CsCanvasControlType.TEXT).toBe('text')
    expect(CsCanvasControlComponent.VALUE).toBe('value')
    expect(CsCanvasTitleLevel.FIRST).toBe('first')
    expect(CsCanvasListType.UL).toBe('ul')
    expect(CsCanvasListStyle.DECIMAL).toBe('decimal')
    expect(CsCanvasZone.MAIN).toBe('main')
  })
})

describe('旧 TipTap → Canvas', () => {
  test('标题、加粗、胶囊与换行结构正确', () => {
    const converted = legacyTipTapToCanvas({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '结果' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '转化率 ', marks: [{ type: 'bold' }] },
            {
              type: 'scienceCapsule',
              attrs: {
                capsuleId: 'cap-1',
                label: 'Yield',
                value: '80',
                unit: '%',
                tableUri: 'cdut://lab-1/table/t-1',
                column: 'yield',
                rowIndex: 0,
                revisionAtBind: 3,
                status: 'fresh',
              },
            },
            { type: 'text', text: ' 达标' },
          ],
        },
      ],
    })

    const main = converted.main as IElement[]
    expect(main[0]).toMatchObject({ type: 'title', level: 'second' })
    const capsule = main.find((element) => capsuleExtensionOf(element))
    expect(capsule).toBeTruthy()
    expect(capsule?.control?.extension).toMatchObject({
      kind: 'cslab-capsule',
      capsuleId: 'cap-1',
      value: '80',
    })
    // 只读但可整块删除，防止僵尸节点。
    expect(capsule?.control?.disabled).toBe(true)
    expect(capsule?.control?.deletable).toBe(true)
    expect(main.some((element) => element.bold)).toBe(true)
    expect(main[main.length - 1]?.value).toBe('\n')
  })

  test('旧插入/删除/批注 marks 统一转成原生批注', () => {
    const converted = legacyTipTapToCanvasWithComments({
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
                    suggestionId: 'del-1',
                    personaType: 'Methodology_Reviewer',
                    createdAt: 1700000000000,
                  },
                },
              ],
            },
            {
              type: 'text',
              text: '补充引用',
              marks: [
                {
                  type: 'comment',
                  attrs: {
                    suggestionId: 'cmt-1',
                    commentText: '请引用 2024 Nature 论文',
                    personaType: 'Literature_Expert',
                    createdAt: 1700000000000,
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    expect(converted.comments).toHaveLength(2)
    const deletion = converted.comments.find((item) => item.id === 'legacy-del-1')
    expect(deletion?.content).toContain('建议删除')
    expect(deletion?.content).toContain('方法论审稿人')
    const comment = converted.comments.find((item) => item.id === 'legacy-cmt-1')
    expect(comment?.content).toContain('2024 Nature')
    expect(comment?.user).toBe('CDUT Science')

    const main = converted.canvasData.main as IElement[]
    const anchored = main.filter((element) => element.groupIds?.includes('legacy-del-1'))
    expect(anchored.length).toBeGreaterThan(0)
  })
})

describe('Canvas → 派生 TipTap', () => {
  test('批注分组边界不合并，mark 作者为 CDUT Science', () => {
    const doc = canvasToTipTapDoc(
      {
        main: [
          { value: 'A', groupIds: ['g1'] },
          { value: 'B' },
          { value: '\n' },
        ] as IElement[],
      },
      [
        {
          id: 'g1',
          content: '【数据可靠性】复核三次平行实验',
          createdAt: '2024-01-01T00:00:00.000Z',
          user: 'CDUT Science',
        },
      ],
    ) as { content: Array<{ type: string; content?: Array<Record<string, unknown>> }> }

    const paragraph = doc.content[0]
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.content).toHaveLength(2)
    expect(paragraph?.content?.[0]).toMatchObject({ type: 'text', text: 'A' })
    expect(paragraph?.content?.[1]).toMatchObject({ type: 'text', text: 'B' })
    const marks = paragraph?.content?.[0]?.marks as Array<Record<string, unknown>>
    expect(marks[0]).toMatchObject({
      type: 'comment',
      attrs: { authorName: 'CDUT Science', authorId: 'CDUT Science' },
    })

    const secondMarks = paragraph?.content?.[1]?.marks
    expect(secondMarks).toBeUndefined()
  })

  test('同一胶囊的多个 value 元素只输出一次', () => {
    const control = buildCanvasCapsuleControl(CAPSULE_ATTRS)
    const extension = capsuleExtensionOf(control)!
    const doc = canvasToTipTapDoc(
      {
        main: [
          capsuleValueElement(extension),
          capsuleValueElement(extension),
          capsuleValueElement(extension),
          { value: 'X' },
          { value: '\n' },
        ] as IElement[],
      },
      [],
    ) as { content: Array<{ content?: Array<Record<string, unknown>> }> }

    const nodes = doc.content[0]?.content ?? []
    expect(nodes.filter((node) => node.type === 'scienceCapsule')).toHaveLength(1)
    expect(nodes.find((node) => node.type === 'scienceCapsule')?.attrs).toMatchObject({
      capsuleId: 'cap-1',
      value: '80',
    })
  })
})

describe('胶囊提取与文本定位', () => {
  test('extractCanvasCapsules 去重并保留状态', () => {
    const control = buildCanvasCapsuleControl(CAPSULE_ATTRS, true)
    const extension = capsuleExtensionOf(control)!
    const capsules = extractCanvasCapsules(
      {
        main: [
          control,
          capsuleValueElement(extension),
          capsuleValueElement(extension),
        ] as IElement[],
      },
      'lab-1',
    )
    expect(capsules).toHaveLength(1)
    expect(capsules[0]).toMatchObject({
      id: 'cap-1',
      value: '80',
      unit: '%',
      status: 'stale',
      labId: 'lab-1',
    })
  })

  test('findTextRange 跨元素命中并跳过胶囊控件', () => {
    const control = buildCanvasCapsuleControl(CAPSULE_ATTRS)
    const main = [
      { value: '实' },
      { value: '验' },
      { value: '数' },
      { value: '据' },
      control,
      { value: '\n' },
    ] as IElement[]

    expect(findTextRange(main, '验数')).toEqual({ start: 1, end: 2 })
    expect(findTextRange(main, 'Yie')).toBeNull()
  })

  test('extractCanvasText 输出可读正文且胶囊只计一次', () => {
    const main = [
      { value: '转' },
      { value: '化' },
      { value: '率' },
      { value: '\n' },
    ] as IElement[]
    expect(extractCanvasText({ main })).toBe('转化率\n')

    const extension = capsuleExtensionOf(buildCanvasCapsuleControl(CAPSULE_ATTRS))!
    expect(
      extractCanvasText({
        main: [
          capsuleValueElement(extension),
          capsuleValueElement(extension),
          capsuleValueElement(extension),
        ] as IElement[],
      }),
    ).toBe('Yield 80 %')
  })
})
