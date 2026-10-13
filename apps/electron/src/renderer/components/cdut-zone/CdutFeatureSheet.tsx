/**
 * CdutFeatureSheet — CDUT 专区底部拉起的顶层抽屉卡片
 *
 * 基于 @profer/ui 的 Radix Bottom Sheet，点击底部任一高频场景按钮即自底部平滑拉起：
 * 顶部依次为居中把手条、当前功能标题与副标、右上角标准关闭叉号；
 * 抽屉内部为优雅的占位留白区域，静候后续业务域可视化界面填充。
 */

import * as React from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@profer/ui/primitives/sheet'
import type { CdutQuickFeature } from './CdutQuickBar'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'

interface CdutFeatureSheetProps {
  feature: CdutQuickFeature | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CdutFeatureSheet({
  feature,
  open,
  onOpenChange,
}: CdutFeatureSheetProps): React.ReactElement {
  // 全局模态叠加登记：抽屉拉起时，智联万站原生视口必须让位
  useGlobalOverlay(open)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[600px] max-h-[75vh] flex-col rounded-t-2xl"
      >
        {/* 居中把手条 */}
        <div className="mx-auto h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/25" />

        <SheetHeader className="mt-3 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            {feature ? <feature.icon size={16} className="text-primary" /> : null}
            <span>{feature?.title ?? '功能模块'}</span>
          </SheetTitle>
          <SheetDescription>
            {feature?.desc ?? '该业务域模块正在接入中，后续将呈现完整可视化界面。'}
          </SheetDescription>
        </SheetHeader>

        {/* 预留业务域占位留白区 */}
        <div className="mt-4 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-surface-border/70 bg-muted/20 p-6 text-center">
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            该业务域模块正在接入中，后续将呈现完整可视化界面。
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
