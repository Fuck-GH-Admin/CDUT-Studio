/**
 * P03-MAIN-S01: Read-only Main/V2-backed direct Pi review business state.
 *
 * Never derive an 'accepted' ACK from V2.status='running': preparePiReviewRunV2
 * persists that status BEFORE the orchestrator owns the execution token.
 * Do not expose sessionId, assignmentId, SDK stream or internal transcripts.
 */
import type { ReviewBackgroundPiRunState, ReviewRunV2 } from '@profer/shared'
import { getCaseV2Aggregate } from './application-service'
import { isPiReviewRunAdmitted } from './review-pi-admission'
import { listRunsV2 } from './run-store-v2'

type RunSummary = Pick<ReviewRunV2, 'id' | 'caseId' | 'status' | 'completedAt'>

export function summarizeBackgroundPiReviewState(
  caseId: string,
  runs: readonly RunSummary[],
  admitted: (caseId: string, runId: string) => boolean,
): ReviewBackgroundPiRunState {
  // Existing direct Pi run IDs are created exclusively by buildRun() with
  // run-pi- prefix. Ordinary automated or historical V2 runs are not Pi ACKs.
  const latest = runs.find((run) => run.caseId === caseId && run.id.startsWith('run-pi-'))
  if (!latest) return { caseId, phase: 'not-started' }
  const base = {
    caseId,
    runId: latest.id,
    runStatus: latest.status,
    ...(latest.completedAt ? { completedAt: latest.completedAt } : {}),
  }
  switch (latest.status) {
    case 'queued':
    case 'running':
      return { ...base, phase: latest.status === 'running' && admitted(caseId, latest.id) ? 'accepted' : 'preparing' }
    case 'awaiting-input':
    case 'awaiting-decision':
      return { ...base, phase: 'needs-attention' }
    case 'completed':
      // Finished analysis is NOT business approval.
      return { ...base, phase: 'finished' }
    case 'paused':
    case 'partially-completed':
    case 'failed':
    case 'cancelled':
      return { ...base, phase: 'incomplete' }
  }
}

export function getBackgroundPiReviewState(caseId: string): ReviewBackgroundPiRunState {
  if (!getCaseV2Aggregate(caseId)) throw new Error('案卷不存在或尚未初始化')
  return summarizeBackgroundPiReviewState(caseId, listRunsV2(caseId), isPiReviewRunAdmitted)
}
