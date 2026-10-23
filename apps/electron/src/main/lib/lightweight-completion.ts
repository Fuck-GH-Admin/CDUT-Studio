/**
 * 轻量非流式补全服务
 *
 * 面向「极简一次性判定」类需求（长期记忆写入前审核等）：只发送一条隔离的
 * system + user 提示词，取回纯文本，不启动 Pi Harness、不装配工具与工作区上下文。
 *
 * 红线：
 *   - 任何失败（无渠道 / 无凭据 / OAuth 渠道 / 超时 / 网络异常）都返回 null，绝不抛异常；
 *   - 默认 10 秒超时，通过 AbortController 真正中断底层请求；
 *   - 复用 `buildTitleRequest` + `fetchTitle` 这条成熟非流式通道，不新增协议实现。
 */

import { resolveXaiCredentialMode, strip1MContextSuffix } from '@profer/shared'
import { fetchTitle, getAdapter } from '@profer/core'
import { decryptApiKey, isCommercialMode, listChannels } from './channel-manager'
import { getTeamAuthWithRefresh } from './auth-service'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { isCommercialBuild } from './build-target'
import { isOfficialManagedChannel } from './official-channel'

/** 默认超时：10 秒 */
const DEFAULT_TIMEOUT_MS = 10_000
/** Anthropic 走专属代理路径，其余协议走通用 chat 代理 */
const ANTHROPIC_PROXY_PROVIDERS = new Set(['anthropic'])

export interface LightweightCompletionInput {
  channelId: string
  modelId: string
  systemPrompt?: string
  userPrompt: string
  /** 输出 token 上限，缺省沿用适配器默认值 */
  maxTokens?: number
  /** 请求超时，缺省 10 秒 */
  timeoutMs?: number
}

/**
 * 执行一次轻量非流式补全。
 * 返回模型可见文本（已 trim），任何不可用情形返回 null。
 */
export async function runLightweightCompletion(input: LightweightCompletionInput): Promise<string | null> {
  const channelId = input.channelId?.trim()
  const modelId = strip1MContextSuffix(input.modelId ?? '')
  if (!channelId || !modelId || !input.userPrompt.trim()) return null

  try {
    const channel = listChannels().find((item) => item.id === channelId)
    if (!channel) {
      console.warn('[轻量补全] 渠道不存在:', channelId)
      return null
    }

    // ChatGPT OAuth 走 Pi 专属传输，不适配通用 API Key 通道
    if (channel.provider === 'openai-codex') return null

    let storedSecret = ''
    try {
      storedSecret = decryptApiKey(channelId)
    } catch {
      console.warn('[轻量补全] 解密 API Key 失败:', channelId)
      return null
    }

    if (channel.provider === 'xai' && resolveXaiCredentialMode(channel.credentialMode, storedSecret) === 'oauth') {
      return null
    }

    let apiKey = storedSecret
    let proxyBaseUrl = ''
    const shouldUseCommercialProxy = (isCommercialBuild() || isCommercialMode())
      && isOfficialManagedChannel(channel)
      && channel.directDataPlane !== true

    if (shouldUseCommercialProxy) {
      const auth = await getTeamAuthWithRefresh()
      if (!auth) {
        console.warn('[轻量补全] 团队账号登录已过期，跳过请求')
        return null
      }
      const proxyPath = ANTHROPIC_PROXY_PROVIDERS.has(channel.provider) ? '/v1/proxy/messages' : '/v1/proxy/chat'
      proxyBaseUrl = `${auth.baseUrl}${proxyPath}`
      apiKey = auth.proxyToken || auth.token
    }

    const adapter = getAdapter(channel.provider)
    const request = adapter.buildTitleRequest({
      baseUrl: proxyBaseUrl || channel.baseUrl,
      apiKey,
      modelId,
      prompt: input.userPrompt,
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens,
    })
    if (proxyBaseUrl) request.url = proxyBaseUrl

    const proxyUrl = await getEffectiveProxyUrl()
    const baseFetch = getFetchFn(proxyUrl)
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs))
    timer.unref?.()

    const timedFetch = ((resource: Parameters<typeof baseFetch>[0], init?: Parameters<typeof baseFetch>[1]) =>
      baseFetch(resource, { ...init, signal: controller.signal })) as typeof baseFetch

    try {
      const text = await fetchTitle(request, adapter, timedFetch)
      return text?.trim() || null
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    console.warn('[轻量补全] 请求失败（已隔离）:', error)
    return null
  }
}
