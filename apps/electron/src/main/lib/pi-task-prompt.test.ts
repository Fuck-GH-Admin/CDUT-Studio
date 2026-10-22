import { describe, expect, test } from 'bun:test'
import { buildPiTaskPrompt } from './pi-task-prompt'

const BASE_PROMPT = `# Core

## SubAgent Delegation Policy
COLLABORATION_RULES

## Pi Agent Runtime
CORE_PI_RULES

### Pi Runtime & File Memory
PI_MEMORY_RULES

## User Info
USER

## Team Shared Knowledge Memory
TEAM_MEMORY_RULES

## Uncertainty Handling
UNCERTAINTY

## CDUT Studio Knowledge Maintenance Architecture
KNOWLEDGE_GOVERNANCE_RULES

## Task Completion Criteria
DELIVERY_CORE

## Interaction Norms
COMMON_INTERACTION

7. **Scheduled tasks (Automation)**
AUTOMATION_RULES

8. **Sending existing local images**
LOCAL_IMAGE_RULES
9. **AI image generation**
IMAGE_GENERATION_RULES
10. **PPT visual delivery gate**
PPT_VISUAL_GATE

## CDUT Studio Managed Browser
BROWSER_RULES`

const ALL_TOOLS = [
  'BrowserObserve',
  'mcp__automation__create_automation',
  'mcp__collaboration__delegate_agent',
  'mcp__memory-archive__search_memory',
  'mcp__team-memory__search_team_memories',
  'send_local_image',
  'generate_image',
  'create_skin',
  'plan_ppt_visuals',
  'audit_ppt_delivery',
  'open_file_preview',
  'inspect_file_preview',
]

describe('buildPiTaskPrompt', () => {
  test('Tier 0（无产品工具）只保留核心规则与常驻知识治理', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '帮我检查这个 TypeScript 文件的类型错误。',
      toolNames: [],
    })

    expect(prompt).toContain('CORE_PI_RULES')
    expect(prompt).toContain('UNCERTAINTY')
    expect(prompt).toContain('DELIVERY_CORE')
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    expect(prompt).not.toContain('PI_MEMORY_RULES')
    expect(prompt).not.toContain('TEAM_MEMORY_RULES')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('LOCAL_IMAGE_RULES')
    expect(prompt).not.toContain('IMAGE_GENERATION_RULES')
    expect(prompt).not.toContain('PPT_VISUAL_GATE')
    expect(prompt).not.toContain('BROWSER_RULES')
  })

  // 回归：第 8/9/10 条按图像能力动态生成，第 8 条缺席时裁剪链不能静默失效。
  test('Given 图像能力未挂载导致第 8 条缺失 When 没有自动化工具 Then 定时任务 SOP 仍被裁剪', () => {
    const promptWithoutLocalImage = `<guidelines>
## Interaction Norms
7. **Scheduled tasks (Automation)**
AUTOMATION_RULES

9. **AI image generation**
IMAGE_GENERATION_RULES
10. **Creating CDUT Studio skins**
SKIN_RULES

## CDUT Studio Managed Browser
BROWSER_RULES
</guidelines>`

    const prompt = buildPiTaskPrompt({
      basePrompt: promptWithoutLocalImage,
      userMessage: '任意',
      toolNames: ['generate_image', 'create_skin', 'BrowserObserve'],
    })

    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).toContain('IMAGE_GENERATION_RULES')
    expect(prompt).toContain('SKIN_RULES')
    expect(prompt).toContain('BROWSER_RULES')
  })

  test('Given 图像能力完全缺席且仅剩关闭标签 When 没有自动化工具 Then 第 7 条被裁剪且标签完整', () => {
    const minimalPrompt = `<guidelines>
## Interaction Norms
7. **Scheduled tasks (Automation)**
AUTOMATION_RULES
</guidelines>`

    const prompt = buildPiTaskPrompt({
      basePrompt: minimalPrompt,
      userMessage: '任意',
      toolNames: [],
    })

    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).toContain('</guidelines>')
  })

  // Context Sandwich：同一会话（工具集合不变）内 systemPrompt 必须字节级稳定，
  // 不随用户提问文本变化，否则前缀缓存全部失效、每轮按 1.25 倍价重写。
  test('输出只随工具集合变化，不随用户文本变化（前缀缓存友好）', () => {
    const a = buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '普通任务', toolNames: ALL_TOOLS })
    const b = buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '完全不同的提问：打开网页并做 PPT、再开子 Agent', toolNames: ALL_TOOLS })
    expect(b).toBe(a)
  })

  test('挂载对应工具时恢复各自的低频 SOP', () => {
    const prompt = buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: ALL_TOOLS })
    expect(prompt).toContain('COLLABORATION_RULES')
    expect(prompt).toContain('PI_MEMORY_RULES')
    expect(prompt).toContain('TEAM_MEMORY_RULES')
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
    expect(prompt).toContain('AUTOMATION_RULES')
    expect(prompt).toContain('LOCAL_IMAGE_RULES')
    expect(prompt).toContain('BROWSER_RULES')
  })

  test('仅挂载浏览器工具时只恢复浏览器 SOP', () => {
    const prompt = buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: ['BrowserObserve'] })
    expect(prompt).toContain('BROWSER_RULES')
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('LOCAL_IMAGE_RULES')
    expect(prompt).not.toContain('PI_MEMORY_RULES')
  })

  test('裁剪浏览器 SOP 时不吞掉后续能力边界与其他常驻段落', () => {
    const basePrompt = `${BASE_PROMPT}

### 浏览器补充规则
NESTED_BROWSER_RULES

## 当前预设已关闭的能力
DISABLED_CAPABILITY_RULES

## 其他常驻规则
ALWAYS_PRESENT_RULES`

    const withoutBrowser = buildPiTaskPrompt({ basePrompt, userMessage: '任意', toolNames: [] })
    expect(withoutBrowser).toContain('DISABLED_CAPABILITY_RULES')
    expect(withoutBrowser).toContain('ALWAYS_PRESENT_RULES')
    expect(withoutBrowser).not.toContain('## CDUT Studio Managed Browser')
    expect(withoutBrowser).not.toContain('NESTED_BROWSER_RULES')

    const withBrowser = buildPiTaskPrompt({ basePrompt, userMessage: '任意', toolNames: ['BrowserObserve'] })
    expect(withBrowser).toContain('## CDUT Studio Managed Browser')
    expect(withBrowser).toContain('NESTED_BROWSER_RULES')
    expect(withBrowser).toContain('DISABLED_CAPABILITY_RULES')
  })

  test('PPT 能力未激活时不恢复 PPT SOP，即使工具名称存在', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '任意',
      toolNames: ['plan_ppt_visuals', 'audit_ppt_delivery'],
      pptCapabilityActive: false,
    })
    expect(prompt).not.toContain('PPT_VISUAL_GATE')
  })

  test('PPT 能力激活且交付工具齐备时恢复 PPT SOP', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '任意',
      toolNames: ['plan_ppt_visuals', 'audit_ppt_delivery', 'open_file_preview', 'inspect_file_preview'],
      pptCapabilityActive: true,
    })
    expect(prompt).toContain('PPT_VISUAL_GATE')
  })

  test('图片/皮肤/发送工具注册时恢复对应交付 SOP', () => {
    expect(buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: ['generate_image'] })).toContain('IMAGE_GENERATION_RULES')
    expect(buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: ['create_skin'] })).toContain('IMAGE_GENERATION_RULES')
    expect(buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: ['send_local_image'] })).toContain('LOCAL_IMAGE_RULES')
    expect(buildPiTaskPrompt({ basePrompt: BASE_PROMPT, userMessage: '任意', toolNames: [] })).not.toContain('IMAGE_GENERATION_RULES')
  })

  test('自动任务运行上下文强制保留 automation SOP', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '任意',
      toolNames: [],
      forceAutomation: true,
    })
    expect(prompt).toContain('AUTOMATION_RULES')
  })

  test('无任何产品工具时不注入任何会暗示不存在工具的 SOP', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '请访问网页，每天自动检查并开多个子 Agent。',
      toolNames: [],
    })

    expect(prompt).not.toContain('BROWSER_RULES')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    // 知识治理属于常驻行为规则，避免普通任务完全跳过收尾检查。
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
  })

  // 回归：低频 SOP 被切出后重新追加到文档末尾，会让 <subagents>/<guidelines> 悬空。
  // 裁剪必须只做原位删除，保留时仍留在父级 XML 标签内。
  test('裁剪不搬移段落，XML 拓扑与近因提醒位置保持不变', () => {
    const TAGGED_PROMPT = `<subagents>
## SubAgent Delegation Policy
COLLABORATION_RULES
</subagents>

<guidelines>
### Pi Runtime & File Memory
PI_MEMORY_RULES

## Team Shared Knowledge Memory
TEAM_MEMORY_RULES

## Uncertainty Handling
UNCERTAINTY

## CDUT Studio Knowledge Maintenance Architecture
KNOWLEDGE_GOVERNANCE_RULES

## Task Completion Criteria
DELIVERY_CORE

7. **Scheduled tasks (Automation)**
AUTOMATION_RULES

8. **Sending existing local images**
LOCAL_IMAGE_RULES
9. **AI image generation**
IMAGE_GENERATION_RULES
10. **PPT visual delivery gate**
PPT_VISUAL_GATE

## CDUT Studio Managed Browser
BROWSER_RULES
</guidelines>

> **CRITICAL EXECUTION REMINDER**: think in English, answer in the user's language.`

    const prompt = buildPiTaskPrompt({
      basePrompt: TAGGED_PROMPT,
      userMessage: '任意',
      toolNames: ALL_TOOLS,
      pptCapabilityActive: true,
    })

    const count = (text: string, token: string) => text.split(token).length - 1
    expect(count(prompt, '<subagents>')).toBe(1)
    expect(count(prompt, '</subagents>')).toBe(1)
    expect(count(prompt, '<guidelines>')).toBe(1)
    expect(count(prompt, '</guidelines>')).toBe(1)

    // 保留的低频 SOP 仍位于各自父级标签内
    expect(prompt.indexOf('COLLABORATION_RULES')).toBeLessThan(prompt.indexOf('</subagents>'))
    expect(prompt.indexOf('KNOWLEDGE_GOVERNANCE_RULES')).toBeLessThan(prompt.indexOf('</guidelines>'))
    expect(prompt.indexOf('BROWSER_RULES')).toBeLessThan(prompt.indexOf('</guidelines>'))

    // 近因提醒恒为最后一段
    expect(prompt.trimEnd().endsWith('> **CRITICAL EXECUTION REMINDER**: think in English, answer in the user\'s language.')).toBe(true)
  })
})
