/**
 * 双轨定位锚点语法单一事实源。
 *
 * 主进程系统提示词与渲染进程的胶囊解析共用同一模式串，
 * 避免提示词契约与前端口径各自演进导致静默漂移。
 *
 * 形态：`#f1:p1-b11` / `#f2-p3-b4` / `#f1:p2-tbl1` / `#f3:p1-cB4` / `#f3:p3-cA10:B10`
 *      / `#f3:p1-B4:E10`（无 c 前缀范围）/ `#f3:p3-r10` / `#p1-b11` / `#p2`（纯页面）。
 *
 * 注意：可选量词 `?` 必须挂在块后缀组 `(?:-(?:...))?` 上而非外层 `(p...)` 组，
 * 否则纯页面锚点（`#f1:p2`）会整体失配、全部退化为死链接。
 */
export const DOCUMENT_ANCHOR_PATTERN =
  '^#(?:([a-zA-Z]+\\d+)[:\\-])?(p(\\d+)(?:-(?:b\\d+|tbl\\d+|r\\d+|c[a-zA-Z]+\\d+(?::[a-zA-Z]+\\d+)?|[a-zA-Z]+\\d+:[a-zA-Z]+\\d+))?)$'

/** 文内锚点扫描模式（非锚定，供裸锚点提取）；捕获组口径与 DOCUMENT_ANCHOR_PATTERN 一致。 */
export const DOCUMENT_ANCHOR_IN_TEXT_PATTERN =
  '#(?:([a-zA-Z]+\\d+)[:\\-])?p\\d+(?:-(?:b\\d+|tbl\\d+|r\\d+|c[a-zA-Z]+\\d+(?::[a-zA-Z]+\\d+)?|[a-zA-Z]+\\d+:[a-zA-Z]+\\d+))?'

/** 锚点正则统一使用的匹配标志。 */
export const DOCUMENT_ANCHOR_PATTERN_FLAGS = 'i'
