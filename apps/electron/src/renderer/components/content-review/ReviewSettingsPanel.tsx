/** 审核专区设置：只选择审核 Agent 使用的全局渠道/模型，不编辑全局渠道凭证。 */
import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { REVIEW_MODEL_PROVIDERS, type Channel, type ReviewModuleSettingsV2 } from '@profer/shared'
import { useAtomValue } from 'jotai'
import { channelsAtom } from '@/atoms/conversation-atoms'

interface ReviewSettingsPanelProps {
  onSaved: () => void
}

function enabledReviewModels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.enabled === true
    && (REVIEW_MODEL_PROVIDERS as readonly string[]).includes(channel.provider)
    && channel.models.some((model) => model.enabled !== false))
}

function selectionValue(selection: ReviewModuleSettingsV2['agentModelSelection']): string {
  return selection ? JSON.stringify(selection) : ''
}

export function ReviewSettingsPanel({ onSaved }: ReviewSettingsPanelProps): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const availableChannels = React.useMemo(() => enabledReviewModels(channels), [channels])
  const [selection, setSelection] = React.useState<ReviewModuleSettingsV2['agentModelSelection']>(null)
  const [savedSelection, setSavedSelection] = React.useState<ReviewModuleSettingsV2['agentModelSelection']>(null)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    void window.reviewAPI.getModuleSettingsV2().then((settings) => {
      if (!active) return
      setSelection(settings.agentModelSelection)
      setSavedSelection(settings.agentModelSelection)
      setSaved(true)
    }).catch((error) => {
      if (active) toast.error(`读取审核设置失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const value = selectionValue(selection)
  const hasUnavailableSelection = Boolean(savedSelection
    && !availableChannels.some((channel) => channel.id === savedSelection.channelId
      && channel.models.some((model) => model.id === savedSelection.modelId && model.enabled !== false)))
  const dirty = value !== selectionValue(savedSelection)

  const save = async (): Promise<void> => {
    const settings = await window.reviewAPI.saveModuleSettingsV2({ agentModelSelection: selection })
    setSelection(settings.agentModelSelection)
    setSavedSelection(settings.agentModelSelection)
    setSaved(true)
    onSaved()
    toast.success(settings.agentModelSelection ? '已保存审核专属模型' : '审核模型已恢复跟随全局 Agent')
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try { await save() }
    catch (error) { toast.error(`保存审核设置失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-8">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">审核专属设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">这些选项只影响材料审核模块。应用原有的渠道设置仍负责维护密钥与连接信息。</p>
      </div>

      <section aria-labelledby="review-agent-model-heading" className="rounded-lg border bg-card p-4">
        <h2 id="review-agent-model-heading" className="text-sm font-semibold">审核 Agent 模型</h2>
        <p className="mb-3 mt-1 text-xs leading-5 text-muted-foreground">为审核 Agent 单独选择模型。辅助审核的 Pi Agent 和审核模型网关都会使用它；选择跟随全局时沿用应用原有模型设置。</p>
        <label htmlFor="review-agent-model" className="mb-1.5 block text-sm font-medium">使用模型</label>
        <select
          id="review-agent-model"
          aria-label="审核 Agent 模型"
          disabled={loading || saving}
          value={value}
          onChange={(event) => {
            if (!event.target.value) { setSelection(null); return }
            try { setSelection(JSON.parse(event.target.value) as { channelId: string; modelId: string }) }
            catch { setSelection(null) }
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">跟随全局 Agent 默认模型</option>
          {hasUnavailableSelection && <option value={selectionValue(savedSelection)}>当前选择不可用，请重新选择</option>}
          {availableChannels.map((channel) => (
            <optgroup key={channel.id} label={channel.name}>
              {channel.models.filter((model) => model.enabled !== false).map((model) => (
                <option key={`${channel.id}:${model.id}`} value={selectionValue({ channelId: channel.id, modelId: model.id })}>
                  {model.name || model.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {availableChannels.length > 0
            ? '可用模型来自应用已启用的兼容渠道；此处不会修改普通 Agent 的默认模型或渠道密钥。'
            : '目前没有已启用的兼容渠道。请先在应用原有的渠道设置中配置模型，再回到这里选择审核专用模型。'}
        </p>
        {loading && <p className="mt-2 text-xs text-muted-foreground">正在读取审核设置…</p>}
        {!loading && saved && !dirty && <p className="mt-2 text-xs text-muted-foreground">当前：{savedSelection ? `${availableChannels.find((channel) => channel.id === savedSelection.channelId)?.name ?? '不可用渠道'} · ${savedSelection.modelId}` : '跟随全局 Agent 默认模型'}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
          <Button type="button" variant="outline" disabled={loading || saving || (!savedSelection && !selection)} onClick={() => setSelection(null)}>恢复跟随全局</Button>
          <Button type="button" disabled={loading || saving || !dirty} onClick={() => void handleSave()}>{saving ? '保存中…' : '保存审核设置'}</Button>
        </div>
      </section>
    </div>
  )
}
