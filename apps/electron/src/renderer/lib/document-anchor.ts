/**
 * document-anchor —— 双轨定位胶囊共享口径（对话流 message.tsx 与速课堂 StudySourceTrace.tsx 单一来源）
 *
 * 锚点模式串收敛在 @profer/shared/constants/document-anchor，与主进程系统提示词共用，
 * 杜绝提示词契约与前端解析各自演进导致的口径漂移；此处仅保留渲染层图标推断。
 */
import {
  DOCUMENT_ANCHOR_IN_TEXT_PATTERN,
  DOCUMENT_ANCHOR_PATTERN,
  DOCUMENT_ANCHOR_PATTERN_FLAGS,
} from '@profer/shared'
import { ImageIcon, MapPin, Sigma, Table2 } from 'lucide-react'

/**
 * 完整锚点匹配（锚定 ^...$，供 href 精确校验）。
 * 捕获组：1 = fileId（不含 `:`/`-` 分隔符），2 = 页码+块后缀，3 = 页码数字。
 */
export const DOCUMENT_ANCHOR_RE = new RegExp(DOCUMENT_ANCHOR_PATTERN, DOCUMENT_ANCHOR_PATTERN_FLAGS)

/** 文内锚点扫描（非锚定，供裸锚点提取）。捕获组口径与 DOCUMENT_ANCHOR_RE 完全一致。 */
export const DOCUMENT_ANCHOR_IN_TEXT_RE = new RegExp(DOCUMENT_ANCHOR_IN_TEXT_PATTERN, DOCUMENT_ANCHOR_PATTERN_FLAGS)

/**
 * 边界敏感的图标推断：要求复合词或「字+编号」形态，杜绝单字子串误伤
 * （如「发表/表现/列表」不再是表格、「意图/试图」不再是插图）。
 *
 * 词尾匹配采用「负向后顾 + 词边界」双约束：
 * - `(?<![发表代列手外水电气钟师])表(?![\u4e00-\u9fa5A-Za-z0-9])`
 *   命中「财务表/明细表/数据表」等词尾独立「表」，排除「发表/代表/列表/手表」等非表格词；
 * - 图侧同理命中「拓扑图/流程图/示意图」，排除「意图/企图/试图/蓝图」等非插图词。
 */
export function pickAnchorIcon(label: string): typeof MapPin {
  if (/公式|Equation/i.test(label)) return Sigma
  if (/表格|表\s*\d+|Sheet|工作表|表头|(?<![发表代列手外水电气钟师])表(?![\u4e00-\u9fa5A-Za-z0-9])/i.test(label)) {
    return Table2
  }
  if (/插图|图表|图\s*\d+|Figure|Fig\.|示意图|(?<![意企试版宏蓝雄])图(?![\u4e00-\u9fa5A-Za-z0-9])/i.test(label)) {
    return ImageIcon
  }
  return MapPin
}
