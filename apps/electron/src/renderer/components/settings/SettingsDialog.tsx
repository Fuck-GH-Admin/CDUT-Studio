/**
 * SettingsDialog - 设置浮窗
 *
 * 以 Dialog 浮窗形式展示设置面板，不覆盖主内容区。
 * 使用低级 Dialog 原语实现轻遮罩 + 无默认关闭按钮（关闭按钮由 SettingsPanel 内部提供）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { settingsOpenAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from '@/atoms/settings-tab'
import { longTermMemoryViewOpenAtom } from '@/atoms/longterm-memory-atoms'
import { useGlobalOverlay } from '@/atoms/overlay-atoms'
import { Z_LAYER } from '@profer/ui'
import { SettingsPanel, type SettingsTabItem } from './SettingsPanel'
import { LongTermMemoryView } from './LongTermMemoryView'

export interface SettingsDialogProps {
  /** 受限环境（如外部嵌入入口）传入的 tab 白名单，透传给 SettingsPanel */
  tabsOverride?: SettingsTabItem[]
}

export function SettingsDialog({ tabsOverride }: SettingsDialogProps): React.ReactElement {
  const [open, setOpen] = useAtom(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const setMemoryViewOpen = useSetAtom(longTermMemoryViewOpenAtom)

  // 设置面板整体关闭时同步收起记忆星图，避免下次打开设置时直接弹出
  React.useEffect(() => {
    if (!open) setMemoryViewOpen(false)
  }, [open, setMemoryViewOpen])

  // 全局模态叠加登记：设置面板打开时，智联万站原生 WebContentsView 必须让位（避免硬遮挡）
  useGlobalOverlay(open)

  // 遮罩点击和 Esc 与面板关闭按钮共用未保存确认流程。
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && channelFormDirty) {
      setCloseRequested(true)
      return
    }
    setOpen(nextOpen)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        {/* 轻遮罩 — 与 Dialog primitive 统一使用 Surface Contract overlay。 */}
        <DialogPrimitive.Overlay
          className={`fixed inset-0 ${Z_LAYER.dialog} bg-overlay/40 backdrop-blur-sm titlebar-no-drag transition-opacity duration-100 data-[state=open]:opacity-100 data-[state=closed]:opacity-0`}
        />
        <DialogPrimitive.Content
          data-browser-blocking
          className={`settings-dialog fixed left-[50%] top-[50%] ${Z_LAYER.dialog} translate-x-[-50%] translate-y-[-50%] h-[88vh] w-[90vw] max-h-[820px] max-w-[1080px] overflow-hidden rounded-xl border border-surface-border/60 bg-dialog text-dialog-foreground shadow-2xl titlebar-no-drag transition-all duration-100 data-[state=open]:scale-100 data-[state=open]:opacity-100 data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0`}
        >
          <DialogPrimitive.Title className="sr-only">设置</DialogPrimitive.Title>
          <SettingsPanel onClose={() => setOpen(false)} tabsOverride={tabsOverride} />
          {/* 记忆星图铺满整个设置面板；渲染在 Dialog 内容层以保留 Radix 焦点陷阱与外部点击语义 */}
          <LongTermMemoryView />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
