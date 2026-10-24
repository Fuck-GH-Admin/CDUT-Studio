/**
 * CDUT 教务工具组门控
 *
 * 显式开关优先；仅当会话元数据缺省（旧会话）时才回退关键词探测。
 * 预设禁用拥有最终一票否决权。
 */

const CDUT_TOOL_GROUP = 'cdut-tools'

const CDUT_INTENT_PATTERN =
  /(?:课表|成绩|教室|自习|学分|选课|教务|考务|考试|培养方案|cdut|青果)/i

export interface CdutToolGateInput {
  /** 会话元数据或消息级显式开关；undefined 表示旧会话兼容。 */
  explicit?: boolean
  /** 当前已解析的能力组集合（会被就地增删）。 */
  groups: Set<string>
  text: string
  /** 预设禁用的能力组。 */
  disabled?: readonly string[]
}

export interface CdutToolGateResult {
  enabled: boolean
  source: 'explicit' | 'legacy-intent' | 'legacy-inherited' | 'preset-disabled'
  /** 是否需要把显式开关写回会话元数据。 */
  persistExplicit?: boolean
}

export function applyCdutToolGate(input: CdutToolGateInput): CdutToolGateResult {
  if (input.disabled?.includes(CDUT_TOOL_GROUP)) {
    input.groups.delete(CDUT_TOOL_GROUP)
    return { enabled: false, source: 'preset-disabled' }
  }

  if (input.explicit === true) {
    input.groups.add(CDUT_TOOL_GROUP)
    return { enabled: true, source: 'explicit', persistExplicit: true }
  }

  if (input.explicit === false) {
    input.groups.delete(CDUT_TOOL_GROUP)
    return { enabled: false, source: 'explicit', persistExplicit: true }
  }

  if (input.groups.has(CDUT_TOOL_GROUP)) {
    return { enabled: true, source: 'legacy-inherited' }
  }

  if (CDUT_INTENT_PATTERN.test(input.text)) {
    input.groups.add(CDUT_TOOL_GROUP)
    return { enabled: true, source: 'legacy-intent' }
  }

  return { enabled: false, source: 'legacy-intent' }
}

export const CDUT_TOOLS_GROUP_ID = CDUT_TOOL_GROUP
