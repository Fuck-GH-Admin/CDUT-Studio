/**
 * CdutFeatureSheet — CDUT 专区右侧滑出的业务域顶层抽屉（Drawer Sheet）
 *
 * 核心设计：
 *   - 遵循 @grill-me 架构决策，由侧边（side="right"）拉出右侧滑块抽屉（w-[680px]）；
 *   - 依据传入的 feature.id 动态装配对应的业务域完整交互组件：
 *       - today-schedule  -> ScheduleDomainSheet (今日课表与周次时间轴)
 *       - grade-gpa       -> GradesDomainSheet (成绩单、加权GPA与学分)
 *       - empty-classroom -> ClassroomDomainSheet (校区/教学楼/时段空教室自习雷达)
 *       - final-exam      -> ExamDomainSheet (期末考场日程、座位号与准考证)
 *   - 全局模态叠加登记（useGlobalOverlay），保证抽屉展开时原生 BrowserView / 页面视口安全避让。
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
import { ScheduleDomainSheet } from './sheets/ScheduleDomainSheet'
import { GradesDomainSheet } from './sheets/GradesDomainSheet'
import { ClassroomDomainSheet } from './sheets/ClassroomDomainSheet'
import { ExamDomainSheet } from './sheets/ExamDomainSheet'

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

  const renderContent = () => {
    if (!feature) return null

    switch (feature.id) {
      case 'today-schedule':
        return <ScheduleDomainSheet />
      case 'grade-gpa':
        return <GradesDomainSheet />
      case 'empty-classroom':
        return <ClassroomDomainSheet />
      case 'final-exam':
        return <ExamDomainSheet />
      default:
        return (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-surface-border/70 bg-muted/20 p-6 text-center">
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              该业务域模块正在接入中，后续将呈现完整可视化界面。
            </p>
          </div>
        )
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-6 sm:w-[680px] sm:max-w-2xl"
      >
        <SheetHeader className="mb-4 text-left">
          <SheetTitle className="flex items-center gap-2 text-lg font-bold">
            {feature ? <feature.icon size={20} className="text-primary" /> : null}
            <span>{feature?.title ?? '功能模块'}</span>
          </SheetTitle>
          <SheetDescription className="text-xs">
            {feature?.desc ?? 'CDUT 专区一站式教务与学习辅助平台'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1">{renderContent()}</div>
      </SheetContent>
    </Sheet>
  )
}
