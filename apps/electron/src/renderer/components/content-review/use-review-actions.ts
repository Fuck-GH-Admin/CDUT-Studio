/**
 * use-review-actions — 内容审核专区三栏共用的 IPC 动作手（hook）
 *
 * M0/H05：编排逻辑全部移入 review-actions-controller.ts（可注入假 IPC 单测），
 * 本 hook 只负责把 Jotai Store 与 window.reviewAPI 接进控制器。
 * 并发语义见控制器文件头注释（选择代次 / 按案写入 / 操作代次 / 同案互斥）。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { useSetAtom } from 'jotai'
import type { ReviewRunV2 } from '@profer/shared'
import { agentChannelIdAtom, agentModelIdAtom, agentSessionsAtom, agentStreamingStatesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { channelsAtom, channelsLoadedAtom } from '@/atoms/conversation-atoms'
import {
  reviewErrorAtom,
  reviewExecutionByCaseAtom,
  reviewCaseAtom,
  reviewWorkspaceAggregatesByCaseAtom,
  reviewWorkspaceExtractedObservationsByCaseAtom,
  reviewWorkspaceRunStaleByCaseAtom,
  reviewWorkspaceRunsByCaseAtom,
  reviewWorkspaceTemplatesByCaseAtom,
} from '@/atoms/review-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { createReviewActionsController, type ReviewRunMode } from './review-actions-controller'

/** 动作集合类型（消费方此前从本文件导入，保持导出名不变） */
export type ReviewActions = ReturnType<typeof createReviewActionsController>
export type { CreateCaseInput } from './review-actions-controller'
export { REVIEW_DOCUMENT_ROLE_LABELS } from './review-actions-controller'

export function useReviewActions() {
  const store = useStore()
  const openSession = useOpenSession()
  const setAgentSessions = useSetAtom(agentSessionsAtom)

  const startPiReview = React.useCallback(async (caseId: string, mode: ReviewRunMode = 'update'): Promise<ReviewRunV2> => {
    const moduleSettings = await window.reviewAPI.getModuleSettingsV2()
    const explicitSelection = moduleSettings.agentModelSelection
    const channelId = explicitSelection?.channelId ?? store.get(agentChannelIdAtom)
    if (!channelId) throw new Error('请在审核专属设置中选择审核模型，或先配置全局 Agent 渠道')
    const modelId = explicitSelection?.modelId ?? store.get(agentModelIdAtom) ?? undefined
    if (explicitSelection && store.get(channelsLoadedAtom)) {
      const selectedChannel = store.get(channelsAtom).find((channel) => channel.id === explicitSelection.channelId)
      if (selectedChannel?.enabled !== true || !selectedChannel.models.some((model) => model.id === explicitSelection.modelId && model.enabled !== false)) {
        throw new Error('审核专属模型已停用或被删除，请打开审核专属设置重新选择')
      }
    }
    const workspaceId = store.get(currentAgentWorkspaceIdAtom) || undefined
    const active = store.get(agentStreamingStatesAtom)
    let sessionId = mode === 'restart' ? null : await window.reviewAPI.getPiReviewSessionV2(caseId)
    let session = sessionId ? await window.electronAPI.getAgentSessionMeta(sessionId) : null
    const sessionModelChanged = session && (session.channelId !== channelId || (session.modelId ?? null) !== (modelId ?? null))
    const canReuseSession = !!session && !session.archived && (!session.agentRuntime || session.agentRuntime === 'pi') && !active.get(session.id)?.running && !sessionModelChanged
    if (!canReuseSession) {
      session = await window.electronAPI.createAgentSession(
        `审核：${store.get(reviewCaseAtom)?.title ?? caseId}${mode === 'restart' ? '（从头重新审核）' : ''}`,
        channelId,
        workspaceId,
        modelId,
        'review-operator',
      )
      sessionId = session.id
      setAgentSessions((previous) => [session!, ...previous.filter((item) => item.id !== session!.id)])
    } else {
      setAgentSessions((previous) => previous.some((item) => item.id === session!.id) ? previous : [session!, ...previous])
    }

    if (!sessionId || !session) throw new Error('无法准备项目 Pi 会话')
    const turnId = window.crypto?.randomUUID?.() ?? `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const previousRun = mode === 'update' ? store.get(reviewWorkspaceRunsByCaseAtom)[caseId] : null
    const resumeRunId = previousRun?.status === 'partially-completed'
      && previousRun.checks.some((check) => check.status === 'execution-failed')
      && store.get(reviewWorkspaceRunStaleByCaseAtom)[caseId] === false
      ? previousRun.id
      : undefined
    const prepared = await window.reviewAPI.preparePiReviewV2({
      caseId,
      sessionId,
      turnId,
      ...(resumeRunId ? { resumeRunId } : {}),
      ...(mode === 'update' ? { inheritReadReceipts: true } : {}),
    })
    try {
      await window.electronAPI.attachDirectory({ sessionId, directoryPath: prepared.caseDirectory })
      // 等待 agentSessionsAtom 更新，避免打开新工作区会话时被可见性筛选误判。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      openSession('agent', sessionId, session.title)
      store.set(reviewErrorAtom, null)
      store.set(reviewExecutionByCaseAtom, {
        ...store.get(reviewExecutionByCaseAtom),
        [caseId]: { status: 'running', stage: 'checks', message: '项目 Pi Agent 正在审核材料' },
      })
      const userMessage = prepared.continuedRun
        ? `${prepared.userMessage}\n\n【本次续审】请在同一运行中补齐上面列出的检查，保留已保存的有效结果。若出处被拒，按上次拒绝原因修正引用后再次调用提交工具；只有返回 rejected 和 missingChecks 均为空时才完成。`
        : mode === 'update' && canReuseSession
        ? `${prepared.userMessage}\n\n【本次续审】请结合本会话此前的审核过程与当前案卷材料，重新核验受材料变更或补充影响的事实和检查结论；此前结论只能作为线索，仍须依据当前材料确认。保留仍有充分依据的结论，修正或撤回已不成立的结论，并提交覆盖当前案卷的完整结果。`
        : `${prepared.userMessage}\n\n【本次从头审核】请把本次案卷材料和审核依据作为唯一判断依据，完整重新核对并提交当前结果；不要沿用其他审核会话或历史结论。`
      const send = window.electronAPI.sendAgentMessage({
        sessionId,
        userMessage,
        channelId: session.channelId ?? channelId,
        modelId: session.modelId ?? modelId,
        workspaceId: session.workspaceId,
        agentRuntime: 'pi',
        triggeredBy: 'user',
        uuid: turnId,
      })
      void send.catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        await window.reviewAPI.abortPiReviewV2({ caseId, sessionId: sessionId!, assignmentId: prepared.assignmentId, runId: prepared.runId }).catch(() => false)
        store.set(reviewErrorAtom, `项目 Pi 审核启动失败：${message}`)
      })

      let run: ReviewRunV2 | undefined
      while (true) {
        run = await window.reviewAPI.getRunV2(caseId, prepared.runId)
        if (!run) throw new Error('Pi 审核运行记录丢失')
        store.set(reviewWorkspaceRunsByCaseAtom, { ...store.get(reviewWorkspaceRunsByCaseAtom), [caseId]: run })
        if (run.status !== 'running') break
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1500))
      }
      const [aggregate, template, observations, stale] = await Promise.all([
        window.reviewAPI.getAggregateV2(caseId),
        run ? window.reviewAPI.getTemplateV2(run.templateId, run.templateVersion) : Promise.resolve(undefined),
        window.reviewAPI.getRunObservationsV2(caseId),
        window.reviewAPI.getWorkspaceRunValidityV2({ caseId, runId: prepared.runId }),
      ])
      store.set(reviewWorkspaceAggregatesByCaseAtom, { ...store.get(reviewWorkspaceAggregatesByCaseAtom), [caseId]: aggregate ?? null })
      store.set(reviewWorkspaceTemplatesByCaseAtom, { ...store.get(reviewWorkspaceTemplatesByCaseAtom), [caseId]: template ?? null })
      store.set(reviewWorkspaceExtractedObservationsByCaseAtom, { ...store.get(reviewWorkspaceExtractedObservationsByCaseAtom), [caseId]: observations })
      store.set(reviewWorkspaceRunStaleByCaseAtom, { ...store.get(reviewWorkspaceRunStaleByCaseAtom), [caseId]: stale })
      if (run.status === 'failed') throw new Error(run.error ?? '项目 Pi 审核失败')
      return run
    } catch (error) {
      await window.reviewAPI.abortPiReviewV2({ caseId, sessionId, assignmentId: prepared.assignmentId, runId: prepared.runId }).catch(() => false)
      throw error
    }
  }, [openSession, setAgentSessions, store])

  return React.useMemo(() => createReviewActionsController(store, window.reviewAPI, startPiReview), [store, startPiReview])
}
