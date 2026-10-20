/**
 * GeneralSettings - 通用设置页
 *
 * 包含个人资料（头像与显示名称）以及系统级与环境配置：工作流入口（语言、快捷任务、界面引导）
 * 和系统环境（启动方式、Shell、新标签页）。
 * 使用中的高频开关（通知与声音、对话浏览、输入体验）已拆分至 UsageSettings（使用偏好）。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Camera, ImagePlus } from 'lucide-react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
} from './primitives'
import { Popover, PopoverTrigger, PopoverContent } from '@profer/ui/primitives/popover'
import { UserAvatar } from '@/components/shared/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { replayIntroOpenAtom } from '@/atoms/intro-atoms'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'

interface EmojiMartEmoji {
  id: string
  name: string
  native: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function GeneralSettings(): React.ReactElement {
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setCoachTourOpen = useSetAtom(coachTourOpenAtom)
  const setReplayIntroOpen = useSetAtom(replayIntroOpenAtom)
  const replayPendingRef = React.useRef(false)
  const replayIntroPendingRef = React.useRef(false)
  const [autoLaunch, setAutoLaunch] = React.useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = React.useState(true)
  const [browserHomeUrl, setBrowserHomeUrl] = React.useState('')
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const [isEditingName, setIsEditingName] = React.useState(false)
  const [nameInput, setNameInput] = React.useState(userProfile.userName)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // 加载设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setBrowserHomeUrl(settings.browserHomeUrl ?? '')
    }).catch(console.error)

    // 登录项以系统实际状态为准，不使用可能过期的配置缓存。
    let cancelled = false
    window.electronAPI.getAutoLaunch().then((enabled) => {
      if (!cancelled) setAutoLaunch(enabled)
    }).catch((error) => {
      console.error('[通用设置] 读取开机自启动状态失败:', error)
      if (!cancelled) toast.error('读取开机自启动状态失败')
    }).finally(() => {
      if (!cancelled) setAutoLaunchBusy(false)
    })
    return () => { cancelled = true }
  }, [])

  /** 切换开机自启动 */
  const handleAutoLaunchChange = async (enabled: boolean): Promise<void> => {
    setAutoLaunchBusy(true)
    setAutoLaunch(enabled)
    try {
      await window.electronAPI.setAutoLaunch(enabled)
      setAutoLaunch(await window.electronAPI.getAutoLaunch())
    } catch (error) {
      console.error('[通用设置] 设置开机自启动失败:', error)
      setAutoLaunch(!enabled) // 回滚
      toast.error('设置开机自启动失败')
    } finally {
      setAutoLaunchBusy(false)
    }
  }

  /** 保存新标签页默认首页（失焦时落盘）。 */
  const handleBrowserHomeUrlBlur = async (): Promise<void> => {
    try {
      const api = (window.electronAPI as Partial<typeof window.electronAPI>)
      if (typeof api.updateBrowserHomeUrl === 'function') {
        await api.updateBrowserHomeUrl(browserHomeUrl)
      } else {
        await window.electronAPI.updateSettings({ browserHomeUrl: browserHomeUrl.trim() })
      }
    } catch (error) {
      console.error('[通用设置] 更新默认首页失败:', error)
    }
  }

  /** 更新头像（emoji 或自定义图片 dataURL）。 */
  const handleAvatarChange = async (avatar: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateUserProfile({ avatar })
      setUserProfile(updated)
      setShowEmojiPicker(false)
    } catch (error) {
      console.error('[通用设置] 更新头像失败:', error)
    }
  }

  /** 读取本地上传的图片并转成 dataURL 更新头像。 */
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      await handleAvatarChange(dataUrl)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  /** 保存显示名称。 */
  const handleSaveName = async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed) return

    try {
      const updated = await window.electronAPI.updateUserProfile({ userName: trimmed })
      setUserProfile(updated)
      setIsEditingName(false)
    } catch (error) {
      console.error('[通用设置] 更新用户名失败:', error)
    }
  }

  const handleNameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      void handleSaveName()
    } else if (e.key === 'Escape') {
      setNameInput(userProfile.userName)
      setIsEditingName(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="个人资料" description="设置头像和显示名称，这些信息只保存在本机">
        <SettingsCard>
          <div className="flex items-center gap-5 px-4 py-4">
            {/* modal：头像选择器嵌在模态设置弹窗内，需以模态 Popover 接管焦点栈，避免被外层 Dialog 焦点陷阱抢占而闪现即关 */}
            <Popover modal open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <div className="relative group/avatar cursor-pointer">
                  <UserAvatar avatar={userProfile.avatar} size={64} />
                  <div className={cn(
                    'absolute inset-0 rounded-[20%] flex items-center justify-center',
                    'bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity'
                  )}>
                    <Camera className="size-5 text-white" />
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent side="right" align="start" sideOffset={12} className="w-auto p-0 border-none shadow-xl">
                <Picker
                  data={data}
                  onEmojiSelect={(emoji: EmojiMartEmoji) => void handleAvatarChange(emoji.native)}
                  locale="zh"
                  theme="auto"
                  previewPosition="none"
                  skinTonePosition="search"
                  perLine={8}
                />
                <div className="px-3 p-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px]',
                      'text-foreground/60 hover:text-foreground hover:bg-foreground/[0.06] transition-colors'
                    )}
                  >
                    <ImagePlus className="size-4" />
                    上传自定义图片
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
              </PopoverContent>
            </Popover>

            <div className="flex-1 min-w-0">
              {isEditingName ? (
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={() => void handleSaveName()}
                  onKeyDown={handleNameKeyDown}
                  maxLength={30}
                  autoFocus
                  className={cn(
                    'text-lg font-semibold text-foreground bg-transparent border-b-2 border-primary',
                    'outline-none w-full max-w-[200px] pb-0.5'
                  )}
                />
              ) : (
                <button
                  onClick={() => {
                    setNameInput(userProfile.userName)
                    setIsEditingName(true)
                  }}
                  className="text-lg font-semibold text-foreground hover:text-primary transition-colors text-left"
                >
                  {userProfile.userName}
                </button>
              )}
              <p className="text-[12px] text-foreground/40 mt-0.5">点击头像更换，点击名字编辑</p>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="工作流与引导"
        description="控制任务入口和界面引导"
      >
        <SettingsCard>
          <SettingsRow
            label="语言"
            description="更多语言支持即将推出"
          >
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
          <SettingsRow
            label="界面引导"
            description="重新播放首次进入时的界面蒙层引导（Esc 可随时退出）"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (replayPendingRef.current) return
                replayPendingRef.current = true
                // 先关设置再开播：引导遮罩在主界面上方取景，避免盖住设置对话框
                setSettingsOpen(false)
                window.setTimeout(() => {
                  setCoachTourOpen(true)
                  window.setTimeout(() => { replayPendingRef.current = false }, 500)
                }, 200)
              }}
            >
              重新播放
            </Button>
          </SettingsRow>
          <SettingsRow
            label="首次欢迎导览"
            description="重放开屏水波纹与首次欢迎导览（欢迎 / 功能导览 / 导入数据 / 欢迎页），不改变已完成的引导状态"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (replayIntroPendingRef.current) return
                replayIntroPendingRef.current = true
                // 先关设置：全屏欢迎导览会接管整屏，避免结束后设置对话框突兀弹出
                setSettingsOpen(false)
                window.setTimeout(() => {
                  setReplayIntroOpen(true)
                  window.setTimeout(() => { replayIntroPendingRef.current = false }, 500)
                }, 200)
              }}
            >
              重新播放
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="系统环境"
        description="配置 CDUT Studio 的启动方式、命令执行环境和新标签页"
      >
        <SettingsCard>
          <SettingsToggle
            label="开机自启动"
            description="系统启动时自动运行 CDUT Studio"
            checked={autoLaunch}
            disabled={autoLaunchBusy}
            onCheckedChange={handleAutoLaunchChange}
          />

          <SettingsInput
            label="新标签页默认首页"
            description="留空时新建标签页显示起始页（书签与最近访问）；填入 URL 后新建标签页直接打开该地址"
            value={browserHomeUrl}
            onChange={setBrowserHomeUrl}
            onBlur={handleBrowserHomeUrlBlur}
            placeholder="例如 https://example.com"
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
