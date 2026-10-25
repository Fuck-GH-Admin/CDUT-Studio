/**
 * Canvas 字面量常量层（零 DOM / 零运行时依赖）
 *
 * 值逐项对齐 @hufe921/canvas-editor@1.0.6 的 dataset/enum/*.d.ts。
 * 纯转换层与单测只允许引用本文件，禁止 import Canvas 引擎运行时，
 * 否则 `bun test --isolate` 会在无 DOM 环境加载失败。
 */

export const CsCanvasElementType = {
  TEXT: 'text',
  IMAGE: 'image',
  TABLE: 'table',
  HYPERLINK: 'hyperlink',
  SUPERSCRIPT: 'superscript',
  SUBSCRIPT: 'subscript',
  SEPARATOR: 'separator',
  PAGE_BREAK: 'pageBreak',
  CONTROL: 'control',
  AREA: 'area',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  LATEX: 'latex',
  TAB: 'tab',
  DATE: 'date',
  BLOCK: 'block',
  TITLE: 'title',
  LIST: 'list',
  LABEL: 'label',
} as const

export const CsCanvasControlType = {
  TEXT: 'text',
  SELECT: 'select',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  DATE: 'date',
  NUMBER: 'number',
} as const

export const CsCanvasControlComponent = {
  PREFIX: 'prefix',
  POSTFIX: 'postfix',
  PRE_TEXT: 'preText',
  POST_TEXT: 'postText',
  PLACEHOLDER: 'placeholder',
  VALUE: 'value',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
} as const

export const CsCanvasTitleLevel = {
  FIRST: 'first',
  SECOND: 'second',
  THIRD: 'third',
  FOURTH: 'fourth',
  FIFTH: 'fifth',
  SIXTH: 'sixth',
} as const

export const CsCanvasListType = {
  UL: 'ul',
  OL: 'ol',
} as const

export const CsCanvasListStyle = {
  DISC: 'disc',
  CIRCLE: 'circle',
  SQUARE: 'square',
  DECIMAL: 'decimal',
  CHECKBOX: 'checkbox',
} as const

export const CsCanvasZone = {
  HEADER: 'header',
  MAIN: 'main',
  FOOTER: 'footer',
} as const

export const TITLE_LEVEL_TO_HEADING: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
}

export const HEADING_TO_TITLE_LEVEL: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  6: 'sixth',
}
