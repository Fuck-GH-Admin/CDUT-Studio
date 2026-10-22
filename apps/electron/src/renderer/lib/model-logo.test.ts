import { describe, expect, test } from 'bun:test'
import { getChannelLogo, getModelLogo } from './model-logo'

function channel(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai' as const,
    baseUrl: 'https://api.profer.cn/v1',
    models: [],
    ...overrides,
  }
}

describe('渠道 Logo 解析', () => {
  test('OpenAI-compatible Kimi 模型池按模型品牌显示 Kimi Logo', async () => {
    const kimiLogo = await import('@/assets/models/moonshot.png')
    expect(getChannelLogo(channel({
      models: [{ id: 'kimi-k3' }],
    }))).toBe(kimiLogo.default)
  })

  test('模型别名不含品牌名时按 familyId 继承 Kimi Logo', async () => {
    const kimiLogo = await import('@/assets/models/moonshot.png')
    expect(getChannelLogo(channel({
      name: 'Kimi',
      familyId: 'kimi',
      models: [{ id: 'k3' }],
    }))).toBe(kimiLogo.default)
  })

  test('没有可识别模型时仍按明确 provider 显示 Logo', async () => {
    const openaiLogo = await import('@/assets/models/openai.png')
    expect(getChannelLogo(channel())).toBe(openaiLogo.default)
  })
})

describe('深色主题 Logo 解析', () => {
  test('Claude 模型深色下使用反色图标', async () => {
    const claudeDark = await import('@/assets/models/claude_dark.png')
    expect(getModelLogo('claude-3-opus-20240229', 'anthropic', true)).toBe(claudeDark.default)
  })

  test('GPT 模型深色下使用反色图标', async () => {
    const gptDark = await import('@/assets/models/gpt_dark.png')
    expect(getModelLogo('gpt-4o', 'openai', true)).toBe(gptDark.default)
  })

  test('没有暗色资源的品牌深色下回退亮色图标', async () => {
    const kimiLogo = await import('@/assets/models/moonshot.png')
    expect(getModelLogo('kimi-k3', 'kimi-api', true)).toBe(kimiLogo.default)
  })
})
