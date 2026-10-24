/**
 * SKLGP 演示实验室附加内容构建器
 *
 * 纯函数：只生成确定性的论文 docJson、演示 PDF、JSON Canvas、研究日志与过程线 PNG，
 * 不触碰 Electron / SQLite，便于 Bun 单测直接校验。
 */

import { PNG } from 'pngjs'
import type {
  CsLabCanvasDocument,
  CsLabCanvasEdge,
  CsLabCanvasNode,
} from '@profer/shared'
import { buildSkLgpDemoPaperPdf, buildTextPdf } from './cslab-demo-pdf'

export const SKLGP_THESIS_TITLE =
  '汶家沟沟道泥石流临界降雨阈值与动力过程模拟（演示初稿 · 未完成）'
export const SKLGP_CANVAS_TITLE = '汶家沟泥石流推演'
export const SKLGP_NOTE_TITLE = '研究日志 · 汶家沟'
export const SKLGP_NOTE_REL_PATH = 'vault/notes/研究日志-汶家沟.md'
export const SKLGP_HYDROGRAPH_FILE = 'wenjia_gully_hydrographs.png'

/** 批注固定时间，保证 docx 导出字节稳定可测。 */
const THESIS_COMMENT_CREATED_AT = Date.parse('2026-10-20T09:00:00+08:00')

const DEMO_DISCLAIMER =
  '本稿为 CSLab 演示数据自动生成的未完成示例，研究区描述与数值均为合成演示，不代表真实汶家沟观测，不得用于工程判断。'

export interface DemoPaperFile {
  fileName: string
  buffer: Buffer
}

export interface ThesisCapsuleSeed {
  id: string
  label: string
  value: string
  unit: string
  tableUri: string
  column: string
  rowIndex: number
  revisionAtBind: number
}

type InlineNode = Record<string, unknown>
type BlockNode = Record<string, unknown>
type Mark = Record<string, unknown>

function text(value: string, marks?: Mark[]): InlineNode {
  return {
    type: 'text',
    text: value,
    ...(marks && marks.length > 0 ? { marks } : {}),
  }
}

function paragraph(...content: InlineNode[]): BlockNode {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function heading(level: number, value: string): BlockNode {
  return { type: 'heading', attrs: { level }, content: [text(value)] }
}

function commentMark(
  suggestionId: string,
  personaType: string,
  authorName: string,
  commentText: string,
): Mark {
  return {
    type: 'comment',
    attrs: {
      suggestionId,
      personaType,
      authorName,
      commentText,
      createdAt: THESIS_COMMENT_CREATED_AT,
    },
  }
}

function capsuleNode(capsule: ThesisCapsuleSeed): InlineNode {
  return {
    type: 'scienceCapsule',
    attrs: {
      capsuleId: capsule.id,
      label: capsule.label,
      value: capsule.value,
      unit: capsule.unit,
      tableUri: capsule.tableUri,
      column: capsule.column,
      rowIndex: capsule.rowIndex,
      revisionAtBind: capsule.revisionAtBind,
      status: 'fresh',
    },
  }
}

function capsuleOrPlaceholder(
  capsules: Map<string, ThesisCapsuleSeed>,
  capsuleId: string,
  fallbackLabel: string,
): InlineNode {
  const capsule = capsules.get(capsuleId)
  return capsule ? capsuleNode(capsule) : text(`【待绑定：${fallbackLabel}】`)
}

/** 生成「写了一半」的中文论文 docJson。 */
export function buildSkLgpThesisDocJson(capsules: ThesisCapsuleSeed[]): unknown {
  const capsuleMap = new Map(capsules.map((capsule) => [capsule.id, capsule]))

  const introComment = commentMark(
    'sug-demo-lit-01',
    'Literature_Expert',
    '文献专家 (AI)',
    '引言仅比较了 2024-07-15 场次，建议补充 2023-08-11 场次，并引用文献 [2] 的 I-D 阈值结果。',
  )
  const methodComment = commentMark(
    'sug-demo-method-01',
    'Methodology_Reviewer',
    '方法论审稿人 (AI)',
    'μ 与 ξ 的量纲和取值依据未交代，请与 3.2 节的符号体系统一并补充参数来源。',
  )
  const dataComment = commentMark(
    'sug-demo-data-01',
    'Data_Analyst',
    '数据可靠性 (AI)',
    '峰值流量请使用正文中的数据胶囊绑定 debris_flow_timeseries.csv，避免手抄误差。',
  )
  const discussionComment = commentMark(
    'sug-demo-method-02',
    'Methodology_Reviewer',
    '方法论审稿人 (AI)',
    '讨论需明确模型未率定、不可直接外推的局限，避免给出工程结论。',
  )

  const content: BlockNode[] = [
    paragraph(text(DEMO_DISCLAIMER, [{ type: 'italic' }])),
    heading(1, SKLGP_THESIS_TITLE),
    paragraph(text('CSLab 演示课题组 · 成都理工大学地质灾害防治与地质环境保护国家重点实验室（合成演示）')),
    paragraph(
      text('写作状态：', [{ type: 'bold' }]),
      text('初稿完成度约 60%。第 1–3.1 节已基本完成；3.2–3.3 节待核对；第 4–6 节仅搭好框架。'),
    ),
    paragraph(
      text('文中【待补】标记处需要补充图件、参数与讨论；', [{ type: 'bold' }]),
      text('正文中的活体数据胶囊直接读取演示时程表，更新数据后点击胶囊即可同步。'),
    ),

    heading(2, '摘要'),
    paragraph(
      text(
        '针对汶川震区沟道泥石流起动与运移问题，本文以内置的 20 m 分辨率合成 DEM、小时降雨过程与出口断面时程为演示数据，构建了“地形分析—I-D 临界降雨—Voellmy 运动过程”的初步分析框架。地形分析采用 Horn 3×3 坡度与 D8 汇流累积提取主沟与源区；临界降雨采用幂律 I = αD^(-β) 描述；运动过程采用深度平均浅水方程与 Voellmy 底阻力。示例时程给出的峰值流量为 ',
      ),
      capsuleOrPlaceholder(capsuleMap, 'cap-demo-peak-discharge', '峰值流量'),
      text('，相应最大水深为 '),
      capsuleOrPlaceholder(capsuleMap, 'cap-demo-max-depth', '最大水深'),
      text('。本稿尚未完成参数率定、敏感性分析与危险性分区图，相关结论仅用于流程演示。'),
    ),
    paragraph(text('关键词：', [{ type: 'bold' }]), text('泥石流；临界降雨；I-D 阈值；Voellmy 模型；DEM；演示数据')),

    heading(2, '1 引言'),
    paragraph(
      text(
        '汶川地震后，龙门山山区沟道内松散物源显著增加，短历时强降雨诱发的泥石流对沟口城镇与基础设施构成持续威胁。降雨强度—历时（I-D）阈值因参数少、易业务化，被广泛用于泥石流预警；运动过程模拟则用于估计下游影响范围[1,2]。',
      ),
    ),
    paragraph(
      text('现有研究多分别讨论阈值与运移，缺少在同一套数据上贯通“降雨—起动—运移”的演示流程。'),
      text(
        '本文以内置合成数据为例，尝试把地形分析、I-D 阈值与 Voellmy 推演串成可复核的分析链，并明确各步骤的输入、假设与局限。',
        [introComment],
      ),
      text('全文不引用真实场次观测，所有数值仅用于功能演示。'),
    ),

    heading(2, '2 研究区与数据'),
    heading(3, '2.1 研究区概况'),
    paragraph(
      text(
        '演示沟谷为一条主沟加两条支沟的合成流域，网格尺寸 20 m，相对高差约 420 m。主沟纵比降较大，两侧坡面陡峻。上述描述仅用于生成合成 DEM，不代表真实汶家沟。',
      ),
    ),
    heading(3, '2.2 数据来源'),
    paragraph(text('基础数据全部来自演示实验室内置资产：')),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [paragraph(text('20 m 分辨率 DEM（ESRI ASCII Grid），用于坡度、坡向与 D8 汇流分析；'))],
        },
        {
          type: 'listItem',
          content: [paragraph(text('24 h 小时降雨过程（mm/h），用于说明降雨输入形式；'))],
        },
        {
          type: 'listItem',
          content: [paragraph(text('出口断面 0–600 s 的流量、水深与流速时程（15 s 步长）。'))],
        },
      ],
    },

    heading(2, '3 方法'),
    heading(3, '3.1 地形因子提取'),
    paragraph(
      text(
        '采用 Horn 3×3 算子计算坡度与坡向，按 D8 方向进行汇流累积，并以最大汇流累积单元作为建议源区。坡度单位为度，汇流累积以网格数计。',
      ),
    ),
    heading(3, '3.2 临界降雨阈值'),
    paragraph(
      text(
        '采用幂律形式描述临界降雨：I = α·D^(-β)，其中 I 为平均雨强（mm/h），D 为历时（min）。对历史临界点取对数后进行最小二乘拟合；无实测点时使用区域示例参数 α=30、β=0.6，并在结果中标注为经验外推。',
      ),
    ),
    heading(3, '3.3 Voellmy 运动过程'),
    paragraph(
      text('深度平均浅水方程的底阻力采用 Voellmy 模型：S = μ g cosθ + g|u|²/(ξ h)，'),
      text(
        '其中 μ 为摩擦系数，ξ 为湍流阻力系数。演示取 μ=0.20、ξ=400 m/s²，源区释放体积 2.0×10^5 m³，计算时长 300 s。',
        [methodComment],
      ),
      text(
        '但尚未完成参数敏感性分析，',
        [{ type: 'bold' }],
      ),
    ),

    heading(2, '4 结果与分析'),
    heading(3, '4.1 地形特征'),
    paragraph(
      text(
        '地形分析给出平均坡度、最大坡度与主沟汇流路径。具体数值待从 cslab_geohazard_analyze_dem 结果回填；在三维 DEM 查看器中可切换 2D 正交俯视核对主沟与支沟形态。',
      ),
    ),
    heading(3, '4.2 临界降雨阈值'),
    paragraph(
      text('按示例参数生成的 I-D 曲线见图 1（'),
      text('【待补】', [{ type: 'bold' }]),
      text('）。在 60 min 历时下，示例临界雨强约为 '),
      text('【待补数值】', [{ type: 'bold' }]),
      text(' mm/h；该值仅由示例参数外推得到，需本地实测校核。'),
    ),
    heading(3, '4.3 运动过程'),
    paragraph(
      text('出口断面的峰值流量为 '),
      capsuleOrPlaceholder(capsuleMap, 'cap-demo-peak-discharge', '峰值流量'),
      text('，相应最大水深为 '),
      capsuleOrPlaceholder(capsuleMap, 'cap-demo-max-depth', '最大水深'),
      text('。流量过程在 300 s 附近达到峰值，随后快速衰减。', [dataComment]),
    ),
    paragraph(
      text('【待补：危险性分区图与最大水深栅格图，待运行 cslab_geohazard_debris_flow_simulation 与 cslab_geohazard_render_hazard_map 后插入。】', [
        { type: 'bold' },
      ]),
    ),

    heading(2, '5 讨论'),
    paragraph(text('（本节尚未撰写）', [discussionComment])),
    heading(2, '6 结论'),
    paragraph(text('【待补】', [{ type: 'bold' }])),

    heading(2, '参考文献'),
    paragraph(text('[1] CSLab Demo Group. Rainfall Thresholds and Debris-Flow Dynamics in Wenjia Gully: A Demonstration Study. 2026.')),
    paragraph(text('[2] CSLab Demo Group. Intensity–Duration Thresholds for Debris Flows in the Wenchuan Earthquake Area. 2026.')),
    paragraph(text('[3] CSLab Demo Group. A Voellmy-Based Runout Model for Channelized Debris Flows. 2026.')),
  ]

  return { type: 'doc', content }
}

/** 读取演示时程 CSV，返回峰值流量 / 最大水深所在的数据行（0-based）。 */
export function resolveThesisCapsuleRows(csv: string): {
  peakDischargeRow: number
  maxDepthRow: number
} {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  const rows = lines.slice(1).map((line) => line.split(',').map((token) => Number(token.trim())))
  const numericRows = rows.filter(
    (row) => row.length >= 3 && row.slice(0, 3).every((value) => Number.isFinite(value)),
  )
  if (numericRows.length === 0) return { peakDischargeRow: 0, maxDepthRow: 0 }

  let peakDischargeRow = 0
  let maxDepthRow = 0
  numericRows.forEach((row, index) => {
    if (row[1]! > numericRows[peakDischargeRow]![1]!) peakDischargeRow = index
    if (row[2]! > numericRows[maxDepthRow]![2]!) maxDepthRow = index
  })
  return { peakDischargeRow, maxDepthRow }
}

/** 3 篇英文演示 PDF：复用现有主论文，新增 I-D 阈值与 Voellmy 运移两篇。 */
export function buildSkLgpDemoPapers(): DemoPaperFile[] {
  return [
    {
      fileName: 'sklgp-demo-paper.pdf',
      buffer: buildSkLgpDemoPaperPdf(),
    },
    {
      fileName: 'wenjia-id-thresholds-demo.pdf',
      buffer: buildTextPdf(buildIdThresholdPages()),
    },
    {
      fileName: 'voellmy-runout-demo.pdf',
      buffer: buildTextPdf(buildVoellmyPages()),
    },
  ]
}

function buildIdThresholdPages(): string[][] {
  return [
    [
      'Intensity-Duration Thresholds for Debris Flows in the Wenchuan Earthquake Area',
      '',
      'SYNTHETIC DEMONSTRATION PAPER - NOT REAL OBSERVATIONS',
      '',
      'Abstract',
      'We assemble a synthetic catalogue of rainfall events to illustrate how an',
      'intensity-duration (I-D) threshold can be fitted and applied in the CDUT Science',
      'demo laboratory. The catalogue, the fitted parameters and the reported values are',
      'all synthetic. No field observation from Wenjia Gully or any other site is used.',
      '',
      'Keywords: debris flow; I-D threshold; Wenchuan; early warning; synthetic data',
      '',
      '1 Introduction',
      'Post-earthquake gullies in the Longmen Mountains deliver abundant sediment during',
      'short, intense rainstorms. Empirical I-D envelopes remain a practical first filter',
      'for early warning because they require only rainfall duration and mean intensity.',
      'This note demonstrates the fitting workflow and its uncertainty, not a regional',
      'hazard assessment.',
      '',
      '2 Synthetic Catalogue',
      'The demonstration catalogue contains twelve synthetic events with durations from',
      '15 to 240 min. Six events are labelled as triggering and six as non-triggering.',
      'The labels were assigned by the demo generator and carry no field meaning.',
      '',
      '3 Method',
      'The threshold is written as',
      'I = alpha * D^(-beta)   (1)',
      'where I is mean intensity in mm/h and D is duration in minutes. Taking logarithms',
      'gives a linear least-squares problem. The demo parameters are alpha = 13.8 and',
      'beta = 0.42, explicitly marked as an empirical extrapolation.',
      '',
      '4 Results',
      'Table 1 lists the synthetic fit. The coefficient of determination is reported for',
      'the synthetic points only and must not be transferred to real catchments.',
      '',
      'Table 1. Synthetic threshold parameters.',
      'Parameter | Value',
      'alpha | 13.8',
      'beta | 0.42',
      'R-squared | 0.96',
      'Minimum duration | 15 min',
      'Maximum duration | 240 min',
      '',
      '5 Limitations',
      'The catalogue is small, balanced by construction, and lacks antecedent moisture,',
      'spatial rainfall variability and sediment supply. A regional threshold requires',
      'quality-controlled records, independent validation and explicit uncertainty.',
      '',
      'References',
      '[1] CSLab Demo Group (2026) Rainfall thresholds and debris-flow dynamics in a',
      'synthetic Wenjia-like gully. Demonstration paper.',
      '[2] CSLab Demo Group (2026) A Voellmy-based runout model for channelized debris',
      'flows. Demonstration paper.',
      '[3] Caine, N. (1980) The rainfall intensity-duration control of shallow landslides',
      'and debris flows. Geografiska Annaler.',
    ],
  ]
}

function buildVoellmyPages(): string[][] {
  return [
    [
      'A Voellmy-Based Runout Model for Channelized Debris Flows',
      '',
      'SYNTHETIC DEMONSTRATION PAPER - NOT REAL OBSERVATIONS',
      '',
      'Abstract',
      'This demonstration paper describes a depth-averaged shallow-water solver with',
      'Voellmy basal resistance for a synthetic channelized debris flow. The purpose is',
      'to exercise the geohazard toolchain in CDUT Science, including DEM analysis,',
      'source selection, runout metrics and hazard mapping.',
      '',
      'Keywords: Voellmy; debris flow; runout; shallow water; DEM; synthetic data',
      '',
      '1 Introduction',
      'Runout models estimate how far a debris flow may travel and where deposition may',
      'occur. Simplified depth-averaged models are fast enough for interactive demos but',
      'remain sensitive to rheology, entrainment and channel geometry.',
      '',
      '2 Model',
      'The basal resistance combines a Coulomb term and a turbulent term:',
      'S = mu * g * cos(theta) + g * |u|^2 / (xi * h)   (1)',
      'where mu is the friction coefficient, xi is the turbulent resistance coefficient,',
      'h is flow depth and u is depth-averaged velocity. The demo uses mu = 0.20 and',
      'xi = 400 m/s^2 with a released volume of 2.0e5 m^3.',
      '',
      '3 Numerical Setup',
      'The DEM is a synthetic 20 m grid with one main gully and two tributaries. The',
      'source cell is the highest cell of the main channel network. Fluxes are advanced',
      'with a CFL-limited explicit scheme. Dry cells are treated with a thin-film',
      'threshold to avoid spurious oscillations.',
      '',
      '4 Demonstration Metrics',
      'Table 1 summarises the synthetic output. Values are generated for the demo and',
      'are not calibrated against any real event.',
      '',
      'Table 1. Demonstration runout metrics (synthetic).',
      'Metric | Value',
      'Released volume | 2.0e5 m3',
      'Peak discharge | about 1.1e2 m3/s',
      'Maximum depth | about 3.0 m',
      'Runout distance | order of 1 km',
      'Engine | TypeScript demo solver',
      '',
      '5 Limitations',
      'The solver neglects entrainment, bed erosion, woody debris, channel blockage and',
      'multi-phase effects. Parameter sensitivity is not completed. Results must not be',
      'used for engineering design or evacuation planning without calibration and a',
      'certified simulator.',
      '',
      'References',
      '[1] CSLab Demo Group (2026) Intensity-duration thresholds for debris flows in a',
      'synthetic earthquake-affected area. Demonstration paper.',
      '[2] Voellmy, A. (1955) On the mechanics of avalanches. Schweizerische Bauzeitung.',
      '[3] Iverson, R.M. (1997) The physics of debris flows. Reviews of Geophysics.',
    ],
  ]
}

/** 生成 7 节点 / 6 边的 JSON Canvas 推演画布。 */
export function buildSkLgpCanvasDocument(input: {
  tableUri?: string
  demUri?: string
}): CsLabCanvasDocument {
  const nodes: CsLabCanvasNode[] = [
    {
      id: 'n-rain',
      type: 'text',
      x: 60,
      y: 60,
      width: 250,
      height: 120,
      color: '4',
      text: '## 降雨时程\n2024-07-15 演示小时降雨（合成）',
      cdut_science: {
        node_kind: 'premise',
        manual_status: 'verified',
        confidence_score: 1,
        ...(input.tableUri ? { cdut_uri: input.tableUri } : {}),
      },
    },
    {
      id: 'n-dem',
      type: 'text',
      x: 60,
      y: 240,
      width: 250,
      height: 120,
      color: '4',
      text: '## DEM 20 m\n合成主沟 + 两条支沟',
      cdut_science: {
        node_kind: 'premise',
        manual_status: 'verified',
        confidence_score: 1,
        ...(input.demUri ? { cdut_uri: input.demUri } : {}),
      },
    },
    {
      id: 'n-terrain',
      type: 'text',
      x: 390,
      y: 240,
      width: 250,
      height: 120,
      color: '4',
      text: '## 地形分析\nHorn 坡度 / D8 汇流 / 建议源区',
      cdut_science: {
        node_kind: 'inference',
        manual_status: 'verified',
        confidence_score: 0.95,
      },
    },
    {
      id: 'n-id',
      type: 'text',
      x: 390,
      y: 60,
      width: 250,
      height: 120,
      color: '2',
      text: '## I-D 临界降雨\nI = alpha * D^(-beta)，示例参数',
      cdut_science: {
        node_kind: 'hypothesis',
        manual_status: 'pending',
        confidence_score: 0.6,
      },
    },
    {
      id: 'n-dead',
      type: 'text',
      x: 390,
      y: 420,
      width: 250,
      height: 110,
      color: '1',
      text: '## 2023-08-11 场次（缺测）\n无完整出口时程，暂列死路',
      cdut_science: {
        node_kind: 'note',
        manual_status: 'dead_end',
        confidence_score: 0,
      },
    },
    {
      id: 'n-voellmy',
      type: 'text',
      x: 720,
      y: 240,
      width: 250,
      height: 120,
      color: '2',
      text: '## Voellmy 推演\nmu = 0.20, xi = 400 m/s^2',
      cdut_science: {
        node_kind: 'experiment',
        manual_status: 'pending',
        confidence_score: 0.6,
      },
    },
    {
      id: 'n-hazard',
      type: 'text',
      x: 720,
      y: 440,
      width: 260,
      height: 120,
      color: '2',
      text: '## 危险性分区\n高 / 中 / 低三级（待出图）',
      cdut_science: {
        node_kind: 'inference',
        manual_status: 'pending',
        confidence_score: 0.5,
        logical_operator: 'OR',
      },
    },
  ]

  const edges: CsLabCanvasEdge[] = [
    {
      id: 'e-rain-id',
      fromNode: 'n-rain',
      toNode: 'n-id',
      fromSide: 'right',
      toSide: 'left',
      label: '降雨输入',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-dem-terrain',
      fromNode: 'n-dem',
      toNode: 'n-terrain',
      fromSide: 'right',
      toSide: 'left',
      label: '地形提取',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-terrain-voellmy',
      fromNode: 'n-terrain',
      toNode: 'n-voellmy',
      fromSide: 'right',
      toSide: 'left',
      label: '源区与坡面',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-id-hazard',
      fromNode: 'n-id',
      toNode: 'n-hazard',
      fromSide: 'bottom',
      toSide: 'left',
      label: '降雨判据（OR）',
      cdut_science: { dependency_type: 'disjunctive' },
    },
    {
      id: 'e-voellmy-hazard',
      fromNode: 'n-voellmy',
      toNode: 'n-hazard',
      fromSide: 'bottom',
      toSide: 'top',
      label: '动力过程',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
    {
      id: 'e-dead-id',
      fromNode: 'n-dead',
      toNode: 'n-id',
      fromSide: 'top',
      toSide: 'bottom',
      label: '缺测（AND 剪枝）',
      cdut_science: { dependency_type: 'strict_conjunctive' },
    },
  ]

  return { nodes, edges }
}

/** 生成与画布/论文/数据互链的研究日志。 */
export function buildSkLgpResearchNote(input: {
  demUri?: string
  tableUri?: string
  thesisTitle: string
  canvasTitle: string
}): string {
  return [
    `# ${SKLGP_NOTE_TITLE}`,
    '',
    '> 本笔记由 CSLab 演示实验室自动生成，所有数据为合成演示，不代表真实汶家沟观测。',
    '',
    '## 数据与资产',
    '',
    '- DEM：`wenjia_gully_dem.asc`（20 m 网格）',
    '- 降雨：`rainfall_timeseries.csv`（24 h 小时雨量）',
    '- 出口时程：`debris_flow_timeseries.csv`（0–600 s，15 s 步长）',
    '- 文献：3 篇演示 PDF（主论文 / I-D 阈值 / Voellmy 运移）',
    `- 论文初稿：\`${input.thesisTitle}\``,
    '',
    '## 关键假设',
    '',
    '1. 源区取主沟汇流累积最大单元，未做人工校核。',
    '2. Voellmy 参数取 mu = 0.20、xi = 400 m/s^2，尚未率定。',
    '3. I-D 阈值使用示例参数 alpha = 30、beta = 0.6，仅作流程演示。',
    '',
    '## 当前进度',
    '',
    '- [x] DEM 入笼与三维/二维查看',
    '- [x] I-D 示例曲线与时程图版',
    '- [x] 出口时程数据胶囊绑定',
    '- [ ] 补 4.3 危险性分区图',
    '- [ ] 完成第 5 节讨论',
    '- [ ] 率定 mu / xi 并做敏感性分析',
    '',
    '## 相关画布',
    '',
    `[[${input.canvasTitle}]]`,
    '',
  ].join('\n')
}

// ===== 洪水过程线 PNG =====

const PNG_WIDTH = 900
const PNG_HEIGHT = 520
const PLOT_LEFT = 70
const PLOT_TOP = 30
const PLOT_RIGHT = 30
const PLOT_BOTTOM = 60

function setPixel(png: PNG, x: number, y: number, color: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= PNG_WIDTH || y >= PNG_HEIGHT) return
  const index = (PNG_WIDTH * y + x) << 2
  png.data[index] = color[0]
  png.data[index + 1] = color[1]
  png.data[index + 2] = color[2]
  png.data[index + 3] = 255
}

function drawLine(
  png: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
  thickness = 1,
): void {
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  const radius = Math.floor(thickness / 2)
  for (let guard = 0; guard < 10000; guard += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        setPixel(png, x + offsetX, y + offsetY, color)
      }
    }
    if (x === x1 && y === y1) break
    const err2 = 2 * err
    if (err2 > -dy) {
      err -= dy
      x += sx
    }
    if (err2 < dx) {
      err += dx
      y += sy
    }
  }
}

function hydrographShape(t: number, peakAt: number): number {
  if (t <= 0) return 0
  const ratio = t / peakAt
  return Math.pow(ratio, 2.2) * Math.exp(2.2 * (1 - ratio))
}

/** 生成三场演示洪水过程线（不同颜色，供图表数字化取色分离）。 */
export function renderDemoHydrographPng(): Uint8Array {
  const png = new PNG({ width: PNG_WIDTH, height: PNG_HEIGHT })
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255
    png.data[index + 1] = 255
    png.data[index + 2] = 255
    png.data[index + 3] = 255
  }

  const plotWidth = PNG_WIDTH - PLOT_LEFT - PLOT_RIGHT
  const plotHeight = PNG_HEIGHT - PLOT_TOP - PLOT_BOTTOM
  const bottom = PNG_HEIGHT - PLOT_BOTTOM

  const grid: [number, number, number] = [226, 232, 240]
  const axis: [number, number, number] = [71, 85, 105]
  for (let step = 1; step < 5; step += 1) {
    const x = PLOT_LEFT + Math.round((plotWidth * step) / 5)
    const y = PLOT_TOP + Math.round((plotHeight * step) / 5)
    drawLine(png, x, PLOT_TOP, x, bottom, grid)
    drawLine(png, PLOT_LEFT, y, PLOT_LEFT + plotWidth, y, grid)
  }
  drawLine(png, PLOT_LEFT, PLOT_TOP, PLOT_LEFT, bottom, axis, 2)
  drawLine(png, PLOT_LEFT, bottom, PLOT_LEFT + plotWidth, bottom, axis, 2)
  drawLine(png, PLOT_LEFT + plotWidth, PLOT_TOP, PLOT_LEFT + plotWidth, bottom, grid)

  const events: Array<{
    color: [number, number, number]
    peakAt: number
    amplitude: number
    phase: number
  }> = [
    { color: [37, 99, 235], peakAt: 0.3, amplitude: 0.55, phase: 0.0 },
    { color: [220, 38, 38], peakAt: 0.48, amplitude: 0.78, phase: 1.2 },
    { color: [5, 150, 105], peakAt: 0.64, amplitude: 0.94, phase: 2.4 },
  ]

  for (const event of events) {
    let previousX = PLOT_LEFT
    let previousY = bottom
    for (let offset = 0; offset <= plotWidth; offset += 1) {
      const t = offset / plotWidth
      const shape = hydrographShape(t, event.peakAt)
      const ripple = 0.012 * Math.sin(t * Math.PI * 18 + event.phase)
      const y = bottom - Math.round((shape + ripple) * event.amplitude * plotHeight)
      const x = PLOT_LEFT + offset
      if (offset > 0) drawLine(png, previousX, previousY, x, y, event.color, 2)
      previousX = x
      previousY = y
    }
  }

  // 右上角图例色块（不栅格化文字，避免字体依赖）。
  const legendX = PNG_WIDTH - PLOT_RIGHT - 110
  events.forEach((event, index) => {
    const y = PLOT_TOP + 12 + index * 22
    for (let offsetY = 0; offsetY < 10; offsetY += 1) {
      for (let offsetX = 0; offsetX < 28; offsetX += 1) {
        setPixel(png, legendX + offsetX, y + offsetY, event.color)
      }
    }
    drawLine(png, legendX, y, legendX + 27, y, axis)
    drawLine(png, legendX, y + 9, legendX + 27, y + 9, axis)
  })

  return PNG.sync.write(png)
}
