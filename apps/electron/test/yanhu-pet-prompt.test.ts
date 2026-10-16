/**
 * 「砚小龙」系统提示词 ↔ 工具清单一致性回归测试
 *
 * 锁死历史故障：提示词无条件宣传了 `yanhu_eval_script`（开发者级）与视觉类工具，
 * 而运行时又按开关把它们从工具清单中过滤掉，模型「看得见、调不到」，只能凭猜测
 * 拼参数（例如用 `script` 代替 `expression`），最终被运行时判为「未知工具」。
 *
 * 核心不变式：提示词中出现的**每一个工具名**都必须是当次真实挂载的工具。
 */

import { describe, expect, it } from 'bun:test'
import {
  buildMountedToolsSection,
  buildYanhuPetSystemPrompt,
  YANHU_PET_SYSTEM_PROMPT,
  type YanhuPromptTool,
} from '../src/main/lib/cdut/yanhu/yanhu-pet-prompt'

/** 始终挂载的门禁工具（不随开关关闭） */
const ALWAYS_MOUNTED = [
  'yanhu_read_page',
  'yanhu_click',
  'yanhu_fill',
  'yanhu_select',
  'yanhu_scroll',
  'yanhu_navigate',
  'yanhu_tab_actions',
] as const

/** 受开关门控的工具（开发者级 / 视觉类） */
const GATED_TOOLS = [
  'yanhu_eval_script',
  'yanhu_inspect_element',
  'yanhu_get_network_logs',
  'yanhu_get_console_logs',
  'yanhu_capture_visual',
  'yanhu_click_visual',
] as const

function tool(name: string, description = `${name} 的说明`): YanhuPromptTool {
  return { definition: { name, description } }
}

function mounted(...names: string[]): YanhuPromptTool[] {
  return names.map((name) => tool(name))
}

/** 提取文本中出现的全部 yanhu_* 工具名 */
function extractToolNames(text: string): Set<string> {
  return new Set(text.match(/yanhu_[a-z0-9_]+/g) ?? [])
}

describe('buildMountedToolsSection（BDD-YANHU-PROMPT-01）', () => {
  it('Given 一批工具 When 生成清单 Then 逐个列出且标注数量正确', () => {
    const section = buildMountedToolsSection(mounted(...ALWAYS_MOUNTED))
    expect(section).toContain(`## Mounted Gate Tools (${ALWAYS_MOUNTED.length})`)
    for (const name of ALWAYS_MOUNTED) {
      expect(section).toContain(`\`${name}\``)
    }
  })

  it('Given 空清单 When 生成清单 Then 数量为 0 且不抛异常', () => {
    expect(buildMountedToolsSection([])).toContain('## Mounted Gate Tools (0)')
  })

  it('Given 描述含换行 When 生成清单 Then 压缩为单行避免破坏清单结构', () => {
    const section = buildMountedToolsSection([
      tool('yanhu_read_page', '第一行\n   第二行   第三行'),
    ])
    expect(section).toContain('第一行 第二行 第三行')
    expect(section.split('\n').filter((line) => line.includes('第一行')).length).toBe(1)
  })
})

describe('基础人设与门控工具解耦（BDD-YANHU-PROMPT-02）', () => {
  it('Given 基础人设提示词 When 扫描工具名 Then 不得出现任何受门控工具', () => {
    for (const name of GATED_TOOLS) {
      expect(YANHU_PET_SYSTEM_PROMPT).not.toContain(name)
    }
  })

  it('Given 基础人设提示词 When 扫描工具名 Then 出现的工具全部属于「始终挂载」集合', () => {
    for (const name of extractToolNames(YANHU_PET_SYSTEM_PROMPT)) {
      expect(ALWAYS_MOUNTED as readonly string[]).toContain(name)
    }
  })

  it('Given 基础人设提示词 When 检查访问范围 Then 明确放开任意 http/https 站点、仅拦截非网页协议', () => {
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('<web_scope>')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('NOT restricted to the campus intranet')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('`mailto:`')
  })

  it('Given 基础人设提示词 When 检查操作流纪律 Then 约束冗余重读与盲目编造 URL 路径', () => {
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Do NOT call `yanhu_read_page` again after a successful')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('instead of hand-crafting URL paths')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Bid Self-Healing (STRICT)')
  })
})

describe('条件化能力指引注入（BDD-YANHU-PROMPT-03）', () => {
  it('Given 默认挂载（未开开发者/视觉）When 组装 Then 不含 developer_tools 与 visual_perception', () => {
    const prompt = buildYanhuPetSystemPrompt(YANHU_PET_SYSTEM_PROMPT, mounted(...ALWAYS_MOUNTED))
    expect(prompt).not.toContain('<developer_tools>')
    expect(prompt).not.toContain('<visual_perception>')
    expect(prompt).not.toContain('yanhu_eval_script')
  })

  it('Given 开发者模式开启挂载 yanhu_eval_script When 组装 Then 注入 developer 指引并明确参数名 expression', () => {
    const prompt = buildYanhuPetSystemPrompt(
      YANHU_PET_SYSTEM_PROMPT,
      mounted(...ALWAYS_MOUNTED, 'yanhu_eval_script'),
    )
    expect(prompt).toContain('<developer_tools>')
    expect(prompt).toContain('yanhu_eval_script(expression)')
  })

  it('Given 视觉工具成对挂载 When 组装 Then 注入 visual_perception 指引', () => {
    const prompt = buildYanhuPetSystemPrompt(
      YANHU_PET_SYSTEM_PROMPT,
      mounted(...ALWAYS_MOUNTED, 'yanhu_capture_visual', 'yanhu_click_visual'),
    )
    expect(prompt).toContain('<visual_perception>')
  })

  it('Given 视觉工具只挂载其中一个 When 组装 Then 不注入 visual_perception（避免宣传不可用工具）', () => {
    const prompt = buildYanhuPetSystemPrompt(
      YANHU_PET_SYSTEM_PROMPT,
      mounted(...ALWAYS_MOUNTED, 'yanhu_capture_visual'),
    )
    expect(prompt).not.toContain('<visual_perception>')
    expect(prompt).not.toContain('yanhu_click_visual')
  })
})

/**
 * 工具**行为**变了，提示词必须同步，否则模型会按过时的直觉行动：
 * 猜像素坐标、猜选项名、反复空读自证。这三条契约对应最近几轮的实现变更。
 */
describe('工具行为契约沉淀（BDD-YANHU-PROMPT-05）', () => {
  it('Given 基础人设 When 检查控件族映射 Then 明确「下拉用 select、单选组用 click、输入框用 fill」', () => {
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Control Family -> Tool Mapping')
    // 单选 / 复选组的每个选项都是独立 [BID]，用 yanhu_click 切换
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('radio "因私请假"')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Do NOT call `yanhu_select` for a single option')
    // 明确禁止对单选回退到猜像素坐标
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('never fall back to guessing pixel coordinates for it')
  })

  it('Given 基础人设 When 检查回执契约 Then 覆盖「值自证 / 选项清单 / 空面板含义」三件事', () => {
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('<result_contract>')
    // ① 任何 read_page（含「无变化」短路）都带当前值 → 用它自证，不要怀疑自己
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('including the "页面无变化 / no change" short-circuit')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Never doubt whether your earlier actions were applied')
    // ② select 失败回执自带已渲染选项清单 → 照抄重试，禁止连试同义词
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('the reply carries the RENDERED option list')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('NEVER fire several guessed synonyms')
    // ③ 面板无选项 = 未真正展开 / 上级级联未生效 → 先 click 打开再重试
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('rendered NO options')
  })

  it('Given 视觉工具成对挂载 When 组装提示词 Then 明确「模型看不到截图，只能用地标表」', () => {
    const prompt = buildYanhuPetSystemPrompt(
      YANHU_PET_SYSTEM_PROMPT,
      mounted(...ALWAYS_MOUNTED, 'yanhu_capture_visual', 'yanhu_click_visual'),
    )
    expect(prompt).toContain('You CANNOT see the screenshot itself')
    expect(prompt).toContain('the click lands exactly at the coordinate you gave')
  })

  it('Given 基础人设 When 检查新增控件语义 Then 覆盖浮层选项 [BID] 与只读控件填写通道', () => {
    // 浮层内的选项行现在有自己的 [BID]（role=option），模型可直接 click
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('role `option`')
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('Click such a row directly with `yanhu_click`')
    // 只读控件走 JS setter 并如实说明
    expect(YANHU_PET_SYSTEM_PROMPT).toContain("written through the page's JS value setter")
    // 台账的 value 覆盖自定义下拉 / 树选择 / 日期控件
    expect(YANHU_PET_SYSTEM_PROMPT).toContain('custom dropdowns, tree selectors and date pickers')
  })
})

describe('核心不变式：提示词工具名 ⊆ 实际挂载工具（BDD-YANHU-PROMPT-04）', () => {
  const scenarios: Array<{ label: string; tools: string[] }> = [
    { label: '默认挂载', tools: [...ALWAYS_MOUNTED] },
    { label: '默认 + 开发者级', tools: [...ALWAYS_MOUNTED, 'yanhu_eval_script', 'yanhu_inspect_element'] },
    { label: '默认 + 视觉对', tools: [...ALWAYS_MOUNTED, 'yanhu_capture_visual', 'yanhu_click_visual'] },
    {
      label: '全量挂载',
      tools: [...ALWAYS_MOUNTED, ...GATED_TOOLS],
    },
  ]

  for (const scenario of scenarios) {
    it(`Given ${scenario.label} When 组装 Then 提示词出现的工具名全部已挂载`, () => {
      const tools = mounted(...scenario.tools)
      const prompt = buildYanhuPetSystemPrompt(YANHU_PET_SYSTEM_PROMPT, tools)
      const mountedNames = new Set(scenario.tools)
      for (const name of extractToolNames(prompt)) {
        expect(mountedNames.has(name)).toBe(true)
      }
    })
  }
})
