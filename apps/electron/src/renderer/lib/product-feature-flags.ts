import type { AgentWorkspace } from '@profer/shared'

/**
 * 暂时隐藏团队工作区的产品开关。
 *
 * 这里只控制 renderer 的产品入口，不删除团队数据、IPC 或服务端能力；
 * 后续恢复时只需改回 true 并重新构建即可。
 */
export const TEAM_WORKSPACE_UI_ENABLED = false

/**
 * 判断工作区是否进入产品入口（侧边栏切换器、TabSwitcher、规划中心等）。
 *
 * 两种不可见：
 * - `archived`：用户主动收纳，纯本地状态，数据完整保留，可随时取出
 * - 团队工作区：被 `TEAM_WORKSPACE_UI_ENABLED` 统一隐藏
 */
export function isAgentWorkspaceVisible(
  workspace: Pick<AgentWorkspace, 'type'> & { slug?: string; archived?: boolean },
): boolean {
  if (workspace.archived) return false
  if (workspace.slug === 'default') return false
  return TEAM_WORKSPACE_UI_ENABLED || workspace.type !== 'team'
}

export function getVisibleAgentWorkspaces<
  T extends Pick<AgentWorkspace, 'type'> & { slug?: string; archived?: boolean },
>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => isAgentWorkspaceVisible(workspace))
}

export function isAgentWorkspaceIdVisible(
  workspaceId: string | null | undefined,
  workspaces: readonly (Pick<AgentWorkspace, 'id' | 'type'> & { slug?: string; archived?: boolean })[],
): boolean {
  if (!workspaceId) return true
  const workspace = workspaces.find((item) => item.id === workspaceId)
  if (workspace?.slug === 'default') return true
  return !workspace || isAgentWorkspaceVisible(workspace)
}
