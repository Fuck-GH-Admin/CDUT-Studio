/**
 * CSLab 活体数据胶囊 → Canvas Content Control
 *
 * 无障碍设计：
 * - 正常态：⚗️ + 皇家深蓝文字 + 冰蓝底；
 * - 陈旧态：⚠️ [陈旧] + 深琥珀文字 + 浅琥珀底（非颜色线索可独立辨识）；
 * - orphan（无数据表绑定）：灰色中性样式。
 *
 * 注意：canvas-editor 不支持逐控件 borderColor / backgroundColor / 虚线边框，
 * 因此样式只使用官方 IControl 支持的 existValueBackgroundColor / activeBackgroundColor。
 */

import type { IControl, IElement } from '@hufe921/canvas-editor'
import {
  CsCanvasControlComponent,
  CsCanvasControlType,
  CsCanvasElementType,
} from './cslab-canvas-enums'
import type { CsLabCapsuleAttrs } from './cslab-canvas-types'

export const CAPSULE_EXTENSION_KIND = 'cslab-capsule'

export interface CsLabCapsuleExtension {
  kind: typeof CAPSULE_EXTENSION_KIND
  capsuleId: string
  label: string
  value: string
  unit: string
  tableUri: string
  column: string
  rowIndex: number
  revisionAtBind: number
  status: 'fresh' | 'stale' | 'orphan'
}

export interface CsLabCapsuleControlPatch {
  conceptId: string
  properties: Partial<Omit<IControl, 'value'>>
}

export function capsuleElementId(capsuleId: string): string {
  return `cslab-capsule-${capsuleId}`
}

export function capsuleConceptId(capsuleId: string): string {
  return `cslab_capsule_${capsuleId}`
}

export function capsuleDisplayText(attrs: CsLabCapsuleAttrs): string {
  return [attrs.label || '数据', attrs.value, attrs.unit].filter(Boolean).join(' ')
}

export function capsuleExtensionOf(element: unknown): CsLabCapsuleExtension | null {
  if (!element || typeof element !== 'object') return null
  const control = (element as IElement).control
  const extension = control?.extension as Partial<CsLabCapsuleExtension> | undefined
  if (!extension || extension.kind !== CAPSULE_EXTENSION_KIND || !extension.capsuleId) return null
  return extension as CsLabCapsuleExtension
}

export function buildCanvasCapsuleControl(
  attrs: CsLabCapsuleAttrs,
  isStale = false,
  isOrphan = false,
): IElement {
  const tone = isStale
    ? { prefix: '⚠️ [陈旧] ⟦', color: '#92400E', bg: '#FEF3C7', active: '#FDE68A' }
    : isOrphan
      ? { prefix: '⟦', color: '#52525B', bg: '#F4F4F5', active: '#E4E4E7' }
      : { prefix: '⚗️ ⟦', color: '#1E40AF', bg: '#DBEAFE', active: '#BFDBFE' }

  return {
    id: capsuleElementId(attrs.capsuleId),
    type: CsCanvasElementType.CONTROL as unknown as NonNullable<IElement['type']>,
    value: '',
    color: tone.color,
    control: {
      type: CsCanvasControlType.TEXT as unknown as IControl['type'],
      value: [{ value: capsuleDisplayText(attrs) }],
      conceptId: capsuleConceptId(attrs.capsuleId),
      placeholder: capsuleDisplayText(attrs),
      prefix: tone.prefix,
      postfix: '⟧',
      border: true,
      disabled: true, // 只读：禁止在控件内修改绑定值
      deletable: true, // 允许整块退格/Delete，避免不可删除的僵尸节点
      existValueBackgroundColor: tone.bg,
      activeBackgroundColor: tone.active,
      extension: {
        kind: CAPSULE_EXTENSION_KIND,
        capsuleId: attrs.capsuleId,
        label: attrs.label,
        value: attrs.value,
        unit: attrs.unit,
        tableUri: attrs.tableUri,
        column: attrs.column,
        rowIndex: attrs.rowIndex,
        revisionAtBind: attrs.revisionAtBind,
        status: isStale ? 'stale' : isOrphan ? 'orphan' : 'fresh',
      } satisfies CsLabCapsuleExtension,
    },
  }
}

/** 批量更新胶囊状态（stale / fresh / orphan）时复用的属性补丁。 */
export function capsuleControlPatch(
  attrs: CsLabCapsuleAttrs,
  isStale: boolean,
): CsLabCapsuleControlPatch {
  const next = buildCanvasCapsuleControl(attrs, isStale, attrs.status === 'orphan')
  return {
    conceptId: capsuleConceptId(attrs.capsuleId),
    properties: {
      prefix: next.control?.prefix,
      postfix: next.control?.postfix,
      existValueBackgroundColor: next.control?.existValueBackgroundColor,
      activeBackgroundColor: next.control?.activeBackgroundColor,
      extension: next.control?.extension,
    },
  }
}

/** 仅用于判断某元素是否代表胶囊显示值（避免 prefix/postfix 重复计入）。 */
export function isCapsuleValueElement(element: IElement): boolean {
  if (!capsuleExtensionOf(element)) return false
  return (
    element.controlComponent === undefined ||
    element.controlComponent === CsCanvasControlComponent.VALUE
  )
}
