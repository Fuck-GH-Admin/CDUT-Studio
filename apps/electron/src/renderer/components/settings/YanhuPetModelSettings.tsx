/**
 * YanhuPetModelSettings - 智联万站「砚小龙」专属模型配置卡片
 *
 * 允许为桌宠单独指定渠道 / 模型；未配置时「砚小龙」将无缝继承全局默认激活渠道。
 * 配置持久化于 `~/.cdutai/yanhu-pet-history.json`，经主进程 `yanhuExpress.petSaveConfig` 写入。
 */

import * as React from 'react'
import type { Channel } from '@profer/shared'
import { PROVIDER_LABELS } from '@profer/shared'
import { SettingsSection, SettingsCard, SettingsRow, SettingsToggle } from './primitives'

export interface YanhuPetModelSettingsProps {
  channels: Channel[]
}

const SELECT_CLASS =
  'h-8 min-w-[180px] rounded-lg border border-border/60 bg-background/70 px-2 text-xs text-foreground outline-none transition-colors focus:border-primary/50 focus:bg-background disabled:opacity-50'

export function YanhuPetModelSettings({ channels }: YanhuPetModelSettingsProps): React.ReactElement {
  const api = window.electronAPI?.yanhuExpress
  const [channelId, setChannelId] = React.useState('')
  const [modelId, setModelId] = React.useState('')
  const [enableVision, setEnableVision] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    if (!api) {
      setLoaded(true)
      return
    }
    let alive = true
    void api
      .petGetConfig()
      .then((config) => {
        if (!alive) return
        setChannelId(config.selectedChannelId ?? '')
        setModelId(config.selectedModelId ?? '')
        setEnableVision(config.enableVision === true)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [api])

  const enabledChannels = React.useMemo(() => channels.filter((channel) => channel.enabled), [channels])
  const targetChannel = enabledChannels.find((channel) => channel.id === channelId)
  const models = React.useMemo(
    () => (targetChannel ? targetChannel.models.filter((model) => model.enabled) : []),
    [targetChannel],
  )

  const persist = React.useCallback(
    (nextChannelId: string, nextModelId: string): void => {
      if (!api) return
      void api
        .petSaveConfig({
          selectedChannelId: nextChannelId || undefined,
          selectedModelId: nextModelId || undefined,
        })
        .catch(() => {})
    },
    [api],
  )

  // 渠道/模型被停用或删除后回落为「继承全局默认渠道」，
  // 避免下拉因值不在候选中而显示空白、并连带把模型下拉禁用。
  React.useEffect(() => {
    if (!loaded) return
    if (channelId && !enabledChannels.some((channel) => channel.id === channelId)) {
      setChannelId('')
      setModelId('')
      persist('', '')
      return
    }
    if (modelId && !models.some((model) => model.id === modelId)) {
      setModelId('')
      persist(channelId, '')
    }
  }, [loaded, enabledChannels, models, channelId, modelId, persist])

  const handleChannelChange = (value: string): void => {
    setChannelId(value)
    setModelId('')
    persist(value, '')
  }

  const handleModelChange = (value: string): void => {
    setModelId(value)
    persist(channelId, value)
  }

  const handleVisionToggle = (checked: boolean): void => {
    setEnableVision(checked)
    if (!api) return
    void api.petSaveConfig({ enableVision: checked ? true : undefined }).catch(() => {})
  }

  return (
    <SettingsSection
      title="智联万站专属模型"
      description="为桌宠「砚小龙」单独指定模型渠道；未配置时无缝继承全局默认激活渠道。"
    >
      <SettingsCard>
        <SettingsRow label="对话渠道" description="选择砚小龙联网操作时使用的模型渠道">
          <select
            className={SELECT_CLASS}
            value={channelId}
            disabled={!loaded}
            onChange={(event) => handleChannelChange(event.target.value)}
          >
            <option value="">继承全局默认渠道</option>
            {enabledChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}（{PROVIDER_LABELS[channel.provider]}）
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label="对话模型" description="留空时使用渠道默认模型">
          <select
            className={SELECT_CLASS}
            value={modelId}
            disabled={!loaded || !targetChannel}
            onChange={(event) => handleModelChange(event.target.value)}
          >
            <option value="">渠道默认模型</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </SettingsRow>
        {/* 视觉截图辅助感知：页面信息不足时触发视口截图，交由多模态模型视觉认知 */}
        <SettingsToggle
          label="启用视觉截图辅助感知（Screenshot Recognition）"
          description="开启后在页面信息不足时将触发视口截图分析；请确保所选模型渠道支持多模态图像输入 (Vision/Multimodal)。"
          checked={enableVision}
          disabled={!loaded}
          onCheckedChange={handleVisionToggle}
        />
      </SettingsCard>
    </SettingsSection>
  )
}
