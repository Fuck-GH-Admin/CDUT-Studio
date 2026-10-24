/**
 * CSLab 研讨会话门禁
 *
 * 唯一事实源：只有 AgentSessionMeta.cslabLabId 已绑定的会话才允许挂载 CSLab 工具链。
 * 绝不读取进程级 activeLabId，避免普通会话、速课堂会话被 CSLab 能力污染。
 */

import { getAgentSessionMeta } from '../agent-session-manager'
import { assertLabId } from './cslab-paths'

export function resolveCsLabSeminarLabId(sessionId: string): string | null {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.cslabLabId) return null
  try {
    return assertLabId(meta.cslabLabId)
  } catch {
    return null
  }
}
