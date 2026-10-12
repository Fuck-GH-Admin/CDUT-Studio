/**
 * Microsoft Office (DOCX / XLSX / PPTX) 双平面确定性排版重排引擎 — 类型定义
 *
 * 严格遵循 ECMA-376 标准与双平面平行拓扑（Dual-Plane Parallel Topology）契约：
 * - 平面 1（几何 AST）：携带真实页码 / 幻灯片序号 / 工作表序号与归一化物理边界框 `bbox: [x0, y0, x1, y1]`；
 * - 平面 2（高保真学术 Markdown）：在块前注入 `<span id="p{page}-b{idx}" ...></span>` 与
 *   `<!-- anchor: p{page}-b{idx} [x0,y0,x1,y1] loc="..." sheet="..." cell="..." -->` 双轨定位锚点。
 */

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

export type OfficeBlockType =
  | 'heading'
  | 'paragraph'
  | 'table'
  | 'list'
  | 'figure'
  | 'formula'
  | 'caption'
  | 'header'
  | 'footer'

export interface OfficeLayoutBlock {
  /** 块级锚点 ID（格式：`p{page}-b{idx}`，例如 `p1-b1`） */
  id: string
  /** 1-based 页码：DOCX 物理页码、PPTX 幻灯片序号、XLSX 工作表序号 */
  pageNumber: number
  /** 块语义类型 */
  type: OfficeBlockType
  /** 纯文本内容（供摘要、大纲、检索消费） */
  text: string
  /** 块级高保真 Markdown 表达（含标题 `#`、GFM 表格、LaTeX 公式 `$...$`/`$$...$$`、列表等） */
  markdown: string
  /** 归一化物理边界框 `[x0, y0, x1, y1]`，取值范围 `[0, 1]`，原点为左上角 */
  bbox: [number, number, number, number]
  /** 人类可读位置标签（例如 `"第2页·研究方法"`、`"幻灯片3·架构图"`、`"Sheet1·A1:F20"`） */
  locLabel: string
  /** 页内/全文确定性阅读顺序序号（从 0 递增） */
  readingOrder: number
  /** XLSX 专属：所属工作表名称 */
  sheetName?: string
  /** XLSX 专属：单元格或区域坐标引用（如 `"A1:F20"` 或 `"B4"`） */
  cellRef?: string
  /** 标题层级（1~6，仅 `type === 'heading'` 时有效） */
  headingLevel?: number
  /** 表格行数（仅 `type === 'table'` 时可选提供） */
  rowCount?: number
  /** 表格列数（仅 `type === 'table'` 时可选提供） */
  columnCount?: number
  /** 公式依赖引用列表（XLSX `calcChain` / 公式单元格语义绑定） */
  formulaDeps?: string[]
}

export interface OfficePageLayout {
  /** 1-based 页码 / 幻灯片号 / 工作表序号 */
  pageNumber: number
  /** 页面/画布物理宽度（Points, 1 pt = 1/72 inch） */
  widthPt: number
  /** 页面/画布物理高度（Points, 1 pt = 1/72 inch） */
  heightPt: number
  /** 本页/本幻灯片/本工作表主标题 */
  title?: string
  /** XLSX 工作表名称 */
  sheetName?: string
  /** 本页按阅读顺序排列的结构化版面块 */
  blocks: OfficeLayoutBlock[]
  /** PPTX 连接线拓扑生成的 Mermaid 流程图集合 */
  mermaidDiagrams?: string[]
}

export interface OfficeDocumentLayoutAST {
  /** 文档格式 */
  format: OfficeFormat
  /** 总页数 / 总幻灯片数 / 总工作表数 */
  pageCount: number
  /** 逐页/逐幻灯片/逐工作表版面树 */
  pages: OfficePageLayout[]
  /** 文档级元数据 */
  metadata: {
    title?: string
    author?: string
    sheetNames?: string[]
  }
}

export interface OfficeParseOptions {
  /** 文件名（用于辅助推断标题与格式） */
  fileName?: string
  /** 最大解析页/表数（默认不限制） */
  maxPages?: number
  /** XLSX 单个表格块最大行数（超出时自动带表头分块，默认 40） */
  maxRowsPerBlock?: number
  /** 是否在 markdown 字段中注入 HTML 拓扑锚点（默认 true） */
  includeAnchors?: boolean
}

export interface OfficeParseResult {
  /** 检测到的 Office 文档格式 */
  format: OfficeFormat
  /** 结构化几何与拓扑 AST */
  ast: OfficeDocumentLayoutAST
  /** 含双轨拓扑锚点（`<span>` + `<!-- anchor: ... -->`）的高保真学术 Markdown */
  markdown: string
  /** 剥离 HTML 定位锚点后的纯净版 Markdown */
  cleanMarkdown: string
}

