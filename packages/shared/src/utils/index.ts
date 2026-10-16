/**
 * Shared utility functions for proma
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export { parseGoalCommand, parseGoalContractInput, parseGoalLimitsInput, getGoalBudgetExhaustedReasons, stripGoalResultBlocks, GOAL_UPDATE_TOOL_NAME, isGoalIterationMessage, isGoalUpdateToolName } from './goal-contract'
export type { GoalLimitsInput } from './goal-contract'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  supports1MContext,
  supportsVerified1MContext,
  isNextGeneration1MContextModel,
  inferContextWindow,
  normalizeContextModelId,
  isDeepSeekV4Model,
  resolveAgentSdkModelId,
  strip1MContextSuffix,
  resolveOneMillionContextDecision,
  resolveAgentSdk1MSelection,
  inferAgentSdkContextWindow,
  resolveContextWindowFromModelUsage,
} from './context-window'
export type { OneMillionContextSource, OneMillionContextDecision, AgentSdk1MSelection } from './context-window'
export { calculateContextUsageRatio } from './context-usage'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export { normalizePathForCompare } from './normalize-path'
export {
  DEFAULT_IMAGE_ATTACHMENT_PROMPT,
  resolveAgentAttachmentPrompt,
  isImageAttachmentMediaType,
} from './agent-image-attachment'
export type { AgentAttachmentKind } from './agent-image-attachment'
export { supportsProviderPlanQuota } from './channel-plan-quota'
export { promoteMru, removeMruId, selectMruFallbackId } from './tab-mru'
// Pi 自动压缩阈值（SWE-Compressor 32k 封顶）
export {
  PI_AUTO_COMPACTION_MAX_TOKENS,
  PI_AUTO_COMPACTION_TRIGGER_TOKENS,
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
} from './pi-compaction'
// 定时任务触发时间展开（日历视图展示用，多值调度适配）
export {
  getAutomationOccurrencesByDay,
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
} from './automation-schedule'
export type {
  AutomationScheduleFields,
  AutomationOccurrenceDay,
} from './automation-schedule'
export { pruneToolOutputByEntropy } from './context-entropy-pruner'
export type { EntropyPruneOptions } from './context-entropy-pruner'
// 思维导图引擎（径向整齐树布局 / 贝塞尔连线 / OPML 2.0 导出），主进程与渲染进程共用
export {
  layoutMindMap,
  estimateMindMapNodeSize,
  buildBezierPath,
  computeAnchorZoomPan,
  flattenMindMap,
  buildNodeStudyPrompt,
  mindMapToOpml,
  parseMindMapText,
  stripMermaidNodeLabel,
} from './mindmap-engine'
export type { MindMapPoint, MindMapLayoutOptions } from './mindmap-engine'
// FIM 潜伏认知能力评级映射（测验与学情展示共用）
export { describeTheta } from './fim-engine'
