/**
 * AgentSettings - Agent 配置页
 *
 * Skills 与 MCP 的管理已迁移到独立的「Agent 技能」全屏视图
 * （左侧栏入口，components/agent-skills/AgentSkillsView），
 * Agent 预设管理也已迁移到该视图的「预设」tab。
 * 此页仅保留推理档位与内置工具的只读概览。
 * 展示类偏好（自动预览修改中文件、输出完保持展开）已迁至「使用偏好」。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { agentContextIndexGlobalAtom, agentEffortAtom } from '@/atoms/agent-atoms'
import { longTermMemoryViewOpenAtom } from '@/atoms/longterm-memory-atoms'
import { SettingsSection, SettingsCard, SettingsSegmentedControl, SettingsToggle } from './primitives'
import type { AgentEffort } from '@profer/shared'

const EFFORT_OPTIONS: { value: AgentEffort; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export function AgentSettings(): React.ReactElement {
  const [effort, setEffort] = useAtom(agentEffortAtom)
  const [globalIndexEnabled, setGlobalIndexEnabled] = useAtom(agentContextIndexGlobalAtom)
  const setMemoryViewOpen = useSetAtom(longTermMemoryViewOpenAtom)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    void window.electronAPI
      .getSettings()
      .then((settings) => setGlobalIndexEnabled(settings.agentContextIndexGlobal === true))
      .catch(() => {
        // 读取失败保持默认关闭，不影响其它设置项
      })
  }, [setGlobalIndexEnabled])

  const handleEffortChange = React.useCallback((value: string) => {
    const v = value as AgentEffort
    setEffort(v)
    window.electronAPI.updateSettings({ agentEffort: v }).catch(console.error)
  }, [setEffort])

  const handleGlobalIndexChange = async (enabled: boolean): Promise<void> => {
    const previous = globalIndexEnabled
    setGlobalIndexEnabled(enabled)
    setSaving(true)
    try {
      const settings = await window.electronAPI.updateSettings({ agentContextIndexGlobal: enabled })
      setGlobalIndexEnabled(settings.agentContextIndexGlobal === true)
      toast.success(enabled ? '全部会话已切换为索引模式' : '已关闭全部会话索引，恢复会话级上下文模式')
    } catch (error) {
      setGlobalIndexEnabled(previous)
      toast.error('上下文模式设置保存失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Agent 配置" description="调整 Agent 的推理行为和资源限制">
        <SettingsCard>
          <SettingsSegmentedControl
            label="思考强度"
            description="控制 Agent 推理深度。低强度响应更快，高强度更适合复杂任务"
            value={effort ?? 'high'}
            onValueChange={handleEffortChange}
            options={EFFORT_OPTIONS}
          />
          <SettingsToggle
            label="全部会话使用索引模式"
            description="开启后所有会话默认只检索相关历史，不上传完整前序对话。可在输入栏点击「经典」随时退出。"
            checked={globalIndexEnabled}
            onCheckedChange={(enabled) => { void handleGlobalIndexChange(enabled) }}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="长期记忆"
        description="AI 在每轮对话结束后静默反思，持续沉淀您的编码偏好、解法范式与高频工具习惯；内置 Classic RAG 毫秒级召回并自适应注入。"
      >
        <SettingsCard>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">长期记忆与个性化偏好图谱</p>
              <p className="text-xs text-muted-foreground">
                全部数据仅保存在本机 ~/.cdutai/user-habit-graph.json，可随时查看、编辑或删除。
              </p>
            </div>
            <Button size="sm" className="shrink-0" onClick={() => setMemoryViewOpen(true)}>
              探索记忆星图
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
