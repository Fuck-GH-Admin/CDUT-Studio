/**
 * Renderer IPC is an untrusted boundary. The local desktop reviewer is an
 * application-scoped role, NEVER a school/teacher/agent authentication.
 *
 * Until school role credentials are verified by a main-process SchoolPort,
 * privileged school/teacher decisions cannot be claimed through renderer IPC.
 */
import type { Actor } from '@profer/shared'

export const LOCAL_REVIEWER_ACTOR: Actor = Object.freeze({
  actorId: 'local-reviewer',
  actorSource: 'local',
  role: 'reviewer',
})

export function bindLocalReviewerCommand<T extends Record<string, unknown>>(command: T): T {
  const claim = command?.actor as Actor | undefined
  if (!claim || claim.actorSource !== 'local' || claim.role !== 'reviewer') {
    throw new Error('本地审核 IPC 仅允许 reviewer 操作；教师、校方、系统或 Agent 权限必须经过可信服务授权')
  }
  // Ignore the renderer-supplied identity: it is not authenticated.
  return { ...command, actor: LOCAL_REVIEWER_ACTOR }
}
