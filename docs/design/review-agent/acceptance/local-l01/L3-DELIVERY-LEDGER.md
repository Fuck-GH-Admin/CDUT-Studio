### S4 真实 UI 旅程（PARTIAL）与一处产品缺陷修复

`flow-a15-s4` 全程经 DOM 点击/输入驱动，不使用后门 IPC 造事实。

**已真实走通**：
1. 首页 → 「内容合规审查」→ 「进入本地材料审核（无需校园账号）」→ 「案卷办理」；
2. 展开「打开其他案卷 / 从已发布模板新建」，选择已发布模板；
3. 填组织名称/负责人/使用人数(18)/使用日期/使用时段/用途 与案卷标题；
4. 点「创建一份案卷」→ 真实写入 `case-mvha4fj8`，界面显示「当前案卷：A15 S4 真实旅程」；
5. 点「按模板规则检查」→ 真实 Run `run-tpl-mvha6hm1-40f32fb2`，
   人数 `compliant`、材料 `awaiting-supplement`，界面展示状态与理由。

**断点（BLOCKED_BRIDGE:测试环境）**：材料导入只有两条真实路径——OS 文件对话框
（`dialog.showOpenDialog`）与 OS 拖拽（`webUtils.getPathForFile`）。本轮两种自动化都试过：

| 方式 | 结果 |
|---|---|
| CDP `Input.dispatchDragEvent` 携带 `files` | 无法注入真实 `File`，`webUtils.getPathForFile` 取不到路径 |
| 点槽位上传区 → `xdotool` 对 GTK 对话框 Ctrl+L + 输入路径 + 回车 | `wmctrl -l` 在 xvfb 下返回空（无窗口管理器），对话框无焦点管理，输入未投递 |

两次尝试后核对磁盘：`review-cases/case-mvhaf5e2/state.v2.json` 的 `documents` 仍为 `[]`，
即材料确实没有注册。

**截图定位到真正原因**（`evidence/s4-material-slot-guard.png`，加入 openbox 后抓取）：
1. 点击命中的是**未绑定槽位**的通用上传区，界面弹出
   「请先在上方「材料槽」下拉中选择要登记到哪个槽位」——槽位守卫按设计生效，**不是缺陷**；
2. 底部红字「该案卷不存在或已被删除，请刷新列表」：切到「审核工作台」后
   该栏没有选中本案卷，材料区因此拿不到案卷上下文；
3. 引导浮层「Agent 对话与任务 01/10」此时覆盖在界面上方，自动化点击会被它吞掉。

因此 S4 的下一步是**修脚本而不是修产品**：先关闭引导浮层 → 在审核工作台里真实打开本案卷
（点案卷列表项）→ 再点**槽位内**的上传区。这与产品缺陷无关。

**本轮修复的真实产品缺陷**：`V2CasePanel.createFromTemplate` 无条件提交 `subjectRows`，
而模板只有案例级字段时列表里仍有一个空白事项行，创建被
「申报事项名称不能为空」拒绝——整类案例无法建案。现只提交用户真正填写的事项行。

**发现但未改的 UX 问题**：模板的 `sections[].required=true` 会强制要求申报事项，
案例级纯规则分项若标 required 就无法建案。本轮通过模板声明 `required:false` 规避，
是否放宽属 T01 模板领域。

---
### A15 S2 真机四案例（`flow-a15-s2` + `flow-a15-s2-gate`）

模板：`a15-s2-lab@1`（organization，6 字段，`applicantCount` 无数值上限表单限制，
规则由负责人确认的 `field-number-limit{lte 20, unit 人}` 表达，材料槽 `lab-use-plan`）。

| 案例 | Run | 人数检查 | 材料检查 |
|---|---|---|---|
| 18 人 | `run-tpl-mvh95ah3-4a507413` | **compliant**「全部值符合上限」 | compliant |
| 21 人 | `run-tpl-mvh95al2-44ca0bf2` | **non-compliant**「超出上限」 | compliant |
| 人数未知 | `run-tpl-mvh95aof-399abba0` | **awaiting-confirmation**「比较数值/单位未知」 | compliant |
| 缺计划书 | `run-tpl-mvh95aqp-c5fcc637` | compliant | **awaiting-supplement**「缺少必交材料」 |

四个 Run 各自冻结不同 `planFingerprint`（`045997fd…` / `7ff93a37…` / `77dd5c21…` / `4074ae49…`），
说明指纹确实随目标快照变化，不是常量。

**门禁真机验证（`flow-a15-s2-gate`）**：
- 21 人案卷 `stage-pass` **被拒**：`存在未解释的非合规项：t04:[...]`；
- 21 人案卷 `return-for-supplement` **允许**（拒绝/退回不是通过）；
- 18 人案卷 `stage-pass` **通过**，能力投影同时开放
  `stage-pass / final-reject / return-for-supplement / return-to-previous-stage`。

**实现归属**：`review-v3-main-template-run.ts`（Main 安装与 Run 写入）+ IPC
`TEMPLATE_RULE_RUN_V3`。计划编译复用 `review-v3-main-template-plan-bridge`，
检查计算复用 T04 既有 `evaluateT04Plan`/`toT04CheckResult`，Run 写入复用
`run-store-v2`。**未新建 PlanStore/RunStore/规则引擎**。

**S2 UI 入口**：`ReviewV3TemplateRuleRun` 已挂到案卷办理区（按钮「按模板规则检查」），
点击后由 Main 编译、计算并写入真实 Run，界面只展示结果。

**仍未闭环**：`gte` 下限算子与 `policyVersionId` 身份仍待 T01/T04 Owner；
S4 的完整用户旅程（真实点击 + 报告 + 冷重启）尚未一次性跑通。

---
## 架构收口 R01 第二轮：T01–T04 续作接收与 S2 规则桥接

**依据**：`LOCAL-L-T01-T04-INTEGRATION-A15-R01`（`408d86984`）
**开工 main**：`9ebfb0f0f`（含 36cb1dcd1 的 D2/D3 与 A15 S3-02 实机）

### 接收（四份独立三方合并，零冲突）

| PR | 来源固定 SHA | 合并 | 说明 |
|---|---|---|---|
| #181 T02 | `ee0b787d8` | 独立 merge | OCR 来源几何 / PPTX 媒体关系 / 页面 bbox（5 文件增量） |
| #183 T01 | `f5ae8bb1e` | 独立 merge | `ReviewV3T01NumberRuleEditor` + `deterministicConstraint` 作者态 |
| #182 T04 | `e39cbbd26` | 独立 merge | `compilePublishedTemplateReviewPlan` + `material-min-count` |
| #184 T03 | `1f3e2ce15` | 独立 merge | `assessT03RunAction` / `selectT03CurrentRun` 纯领域模块 |

四份均与主线改动**零文件交叠**，无覆盖性冲突。

### CI 共同故障修复（共享测试缺陷）

主线与三个 PR 的 CI 都因 `review-v3-t05-business-mode.test.ts` 两处
`TS2339: Property 'caseV2' does not exist on type 'never'` 失败。根因是夹具
`aggregate()` 用 `as never` 返回，属性访问被推断为 never。改为真实类型
（`ReviewCaseV2` / `CaseAggregateV2` / `ReviewRunV2`），断言与语义未变。

### T03 模块自身缺陷（PR 内 CI 本就 FAILURE）

修完类型后 T03 仍有 3 项自测失败，根因两类，均属其自身不一致：
1. 原件校验消息不含「原件」字样，与测试期望不符 → 改为
   「Run 输入已过期：当前原件版本或内容哈希与运行快照不一致」；
2. 测试用 `gate(..., undefined)` 表达「没有 Run/证据」，但默认参数会把显式
   `undefined` 换成默认值 → 改为直接调用 `assessT03RunAction`，保持原意。
**Main 未接入 T03 模块**：`36cb1dcd1` 的 D3 已覆盖同等能力，按 R01 §4.4
「新旧等价则复用旧 Main，不为接入新模块增加重复抽象」，T03 仅作源码并入。

### S2 规则桥接（Local-L Main 实现）

新增 `review-v3-main-template-plan-bridge.ts`：

- `adaptT01ConstraintsToT04`：只把负责人**已确认**的 `field-number-limit{lte}`
  无损映射为 T04 既有 `field-maximum`；`gte` 无对应算子 → `unresolved`，不猜语义；
  字段必须真实存在于该模板版本，不硬编码任何字段名；`policyVersionId` 统一采用
  `resolveEffectiveRules` 的 `template:<id>@<version>`，`template-owner:` 仅作发布证据。
- `buildT04TargetFromCase`：字段值、当前有效原件版本、材料槽状态全部来自真实案卷；
  缺失来源即空数组，**不虚构 SourceRef**；`confirmed` 反映是否人工确认。
- `compileTemplatePlanForCase`：存在未映射约束时**不返回可执行计划**（宁可
  BLOCKED_OWNER，也不拿不完整计划跑审核）。

**单位一致性**：T04 的 `value-limit` 要求字段值与规则单位一致，否则判为比较依据
未知。桥接把负责人确认约束里的单位写入目标字段值，使 18/21 能真实比较。

### S2 四案例定向测试（`review-v3-main-template-plan-bridge.test.ts`）

| 案例 | 结果 |
|---|---|
| 18 人 | **compliant**（"全部值符合上限"） |
| 21 人 | **non-compliant** |
| 人数未知 | **awaiting-confirmation**（不当作 0） |
| 缺计划书 | 材料检查非 compliant，`sourceVersionIds` 为空 |
| `gte` 下限 | `unresolved`，不冒充上限 |
| 未确认约束 | `unresolved`，不进入正式计划 |

**尚未做的**：把编译结果安装进正式案卷并写真实 `ReviewRunV2`（下一步）；
四项用例目前经 `evaluateT04Plan` 得出，尚未走 Electron 真机。

**验证**：typecheck 通过；`bun test --isolate` **4857 pass / 0 fail / 5 skip**。

---
## 架构收口 R01（Main 侧第一阶段）

**裁决依据**：`docs/design/review-agent/acceptance/v3-core-architecture-closure-r01/V3-CORE-ARCHITECTURE-CLOSURE-R01.md`（提交 `078318058`）
**范围**：只做不依赖 T01/T04 新合同的 Main 工作；未实现 `compilePublishedTemplateReviewPlan`（云端 Owner 负责）。

### C3 / D3：Run 有效性统一（真实缺陷）

`currentT05Run` 原先读 `run.inputManifest.documents`——**该字段不存在**，真实字段是
`documentVersions`。结果是「更换原件后仍可能选中过期 Run」。

修复：`currentT05Run` 改为遍历 `listRunsV2` 并复用既有权威判定 `isWorkspaceRunStaleV2`
（按 `inputManifest.hash`、`documentVersions` 顺序回退、补件回复后失效计算），
同时核对 `caseId` / `templateId` / 状态。不再自造「当前 Run」的竞争判断。

### D3：按动作适格判定（替代单一 readiness）

新增 `t05ActionEligibility(aggregate, run)`，分开回答四个动作：

| 动作 | 条件 |
|---|---|
| `stage-pass` | Run 有效 + 计划覆盖完整 + 无待确认/待补件/执行失败/未执行 + 无未解释非合规 |
| `final-reject` | Run 有效即可（拒绝不等于通过） |
| `return-for-supplement` | 无 Run 也可（缺件本就该补件） |
| `return-to-previous-stage` | Run 有效即可 |

具体处理：
- **业务 `non-compliant`（如 21 人 >20）不再可无条件 stage-pass**，只有具名 `waived` 或人工更正为合规才解除；
- `execution-failed` / `not-executed` 阻断通过，但**不算不合规**，仍可拒绝或退回；
- **计划覆盖**：Run 若记录 `inputManifest.effectiveRuleIds`，逐条核对是否都产出 Check，缺失即 `coverage.missing`；
- 人工处置必须绑定当前 Run，换输入后旧处置自然失效。

### D2：可信业务模式解析（修正错误业务分类）

原 `isLocalBusinessCase` 对 `aggregate.canonicalPlan` 一律 `return false`——若未来补足 C1，
合法的本地业务案卷会被误判为技术预审。改为 `resolveT05BusinessMode`：

1. 有 `d2RuntimePlan` → `technical-pre-review`（永远不能形成正式业务决定）；
2. 有 `canonicalPlan` → **只有存在 Main 侧本地业务确认且计划指纹、模板版本均相符**才是
   `local-business`，否则 fail closed 为技术预审；
3. 无任何计划 → 模板绑定的本地业务案卷（A15 S1 现状）。

新增 `registerT05LocalBusinessConfirmation`（仅接受 `local-organizer`；学校授权模式返回
`INVALID_TRANSITION`，本地无此能力）。确认按计划指纹与模板版本绑定，升版后自动失效。

**未做**：`compilePublishedTemplateReviewPlan` / `TemplateCriterionSpec` 结构化约束 / T04 typed clause
——按 R01 归 T01/T04 Owner，本地不自行实现、不猜语义。

### 定向测试

`review-v3-t05-business-mode.test.ts`（11 项）：D2 五情形（无计划/D2/未确认计划/已确认/指纹变化）
+ D3 六情形（无 Run/全合规/21 人超限/具名例外/覆盖不足/执行失败与未执行）。
测试持久化真实 Run 并用 `computeRunInputHash` 生成真实输入哈希，而非伪造内存对象。

**验证**：typecheck 通过；`bun test --isolate` **4818 pass / 0 fail / 5 skip**。

---
## Local-L04 R02（五份续作 + A15 素材）

**origin/main 开工**：`b5ea0d9e3`（R01 收尾）→ 本轮完成后见文末 SHA。
**说明**：R01 的 B1/B2/B3 十线已合入，本轮只接收 PR #174/#176/#177/#175/#179 与素材 #178，未重合旧十线。

### 接收与合并

| 本轮 | 来源固定 SHA | 合并/桥接提交 | 状态 |
|---|---|---|---|
| T02 #174 | `b346c1dad` | 批次 1 合并 | **MERGED**（视觉 OCR/PPTX 媒体与页来源；OCR 依赖外部引擎，缺资源只能 partial） |
| T01 #176 | `362713730` | 批次 1 合并 | **MERGED**（需求→草稿、模型端口、六样例包）；模型端口尚未注入可信 invoke |
| T06 #177 | `07ed0a25e` | 批次 1 合并 | **MERGED**（folder/ZIP 分组、预览、逐原件入库）；物理选择器与批次回执未接 Main |
| T08 #175 | `82d543771` | 批次 1 合并 | **MERGED**（图片页 PDF、建议审阅）；非 text 字段保存仍禁用（缺 TemplateVersion 共享修复） |
| T05 #179 | `0c2a382a2` | `ede84af37` + 桥接 `63c59d488` | **WIRED**（见下） |
| A15 #178 | `a6d342405` | 本轮合并 | 测试素材，非功能；已生成 5 份真实 DOCX + 4 组预期 |

### T05 可信阶段事务（CR-T05-04，L 线实现）

`review-v3-t05-main-service.ts`：
- 只读 `T05StageCapability`：Main 从真实任务指派与有效 Run 派生；渲染层只声明 `reviewer`/`teacher`，非法值降级
- 写入 `recordT05StageDecision`：重核模板已发布、`expectedRevision`、真实任务与有权角色、当前 Run、决策准备度，
  再调用 T05 纯领域 `planT05LocalStageAction` + `applyT05LocalStageProposal`，由 `submitCommand` 在唯一 CaseAggregate 事务原子落盘
- `docs/deployment`：技术预审（`d2RuntimePlan`）与 `canonicalPlan` 案卷一律拒绝业务阶段办理
- 决策准备度：待确认/待补件/执行失败/未结束补件任一存在即 `blocked`；**不把「Run 已完成」当成「检查全通过」**
- 未使用 `stage-workflow` 的合成 `run@rev` 证据

### L 线本轮新增桥接

| 提交 | 模块 | 内容 |
|---|---|---|
| `63c59d488` | T05 | 可信阶段事务：能力投影 + `recordT05StageDecision`（重核身份/模板/修订/任务/当前 Run/准备度后原子落盘） |
| `b3311ab51` | T08 共享修复 | `UPDATE_FIELDS_V2` 读已发布模板 FieldSpec；`toFieldValueV2` 与建案同源，消除 date/boolean/enum 被降级为 text 的类型漂移 |
| `bea8df92f` | T06 | 物理入库：真实 OS 选择器只下发不透明 entryId；指纹校验 + requestId 幂等 + 部分失败保留但与批次隔离 |
| `969cb1cb4` | T01 | 受控模型起草：Main 解析既有审核网关渠道并调用，凭据不出 Main；返回原文与真实模型标识 |

**T06 真机未运行**：`pickT06PhysicalSource` 需真实 OS 弹窗，当前自动化环境（xvfb）无法驱动原生对话框；
枚举/指纹/幂等/部分失败由 `review-v3-t06-main-service.test.ts` 用真实目录覆盖。UI 侧 BatchPanel 已按端口存在性降级。

**T01 模型端口真机 PASS**：`flow-t01-model` 真实调用 `mimo-v2.6-flash` 返回 `{"ok":true}`，渠道名与模型标识正确回传。

### A15 分阶段（S0–S4）

| Gate | 结果 | 证据 / 真实断点 |
|---|---|---|
| **S0** | **PASS**（历史） | `flow-t01-bind`：旧样例发布/绑案、无学年。**不是完整 A15** |
| **S1** | **PASS** | `flow-a15-s1`：`objectType=organization`；6 字段（organizationName/responsiblePerson/applicantCount(max=20)/usageDate/usageTime/purpose）；材料槽 `lab-use-plan`；阶段 `initial-review:reviewer → final-review:teacher`；**无 academicYear 字段**；复用建 2 案均 `academicYear=""` |
| **S2** | **PASS（四案例真机）** | 见下节。已发布模板 + 负责人确认 `lte 20` → `compilePublishedTemplateReviewPlan` → 冻结 `planFingerprint` → T04 `evaluateT04Plan` → **真实 `ReviewRunV2`**（`run-tpl-*`）。18 人 `compliant`、21 人 `non-compliant`、人数未知 `awaiting-confirmation`、缺计划书 `awaiting-supplement`。Run 内经 `inputManifest` 冻结 `planFingerprint` / `effectiveRuleIds` / `documentVersions` |
| **S3** | **PASS（S3-02 两段阶段）** | `flow-a15-s3`：无 Run 时 `stage-pass` 被 `T05_CURRENT_REAL_RUN_REQUIRED` 拒绝、补件可在无 Run 时创建（decisions=0）。`flow-a15-s3-run`（真实 Run）：A15 案卷填字段 18 人 → 按槽位导入真实 DOCX → Pi 审核 `completed`，**2 checks 全 compliant，`effectiveRuleIds` 两条规则各产出 1 项（覆盖完整）** → 初审 `stage-pass` 成功（stage=reviewing，`finality=stage`，`basedOnRunId=run-pi-mvh7e7rl-k76ff`）→ 生成 teacher 终审任务。`flow-a15-s3-final`：**reviewer 冒充终审被 `T05_ACTOR_NOT_ASSIGNED_TO_STAGE` 拒绝**；teacher（本地模拟，非学校身份）终审通过 → stage=`decided`、`finality=final`，两段决定均绑定同一真实 Run。**冷重启后 stage/decisions/Run 完整保留** |
| **S3-01（补件两轮）** | **PASS** | `flow-a15-s3-01`：缺计划书 → 首轮 Run `partially-completed`（材料 `awaiting-supplement`）→ 开补件 → 第一次 `insufficient`（stage=`awaiting-supplement`，1 份原件）→ 第二次 `satisfied`（stage=`reviewing`，2 份原件，新增 `doc-2-mvh99etc-v1`）→ **新 Run `run-tpl-mvh99ev4-823ca317` completed**，旧 Run `run-tpl-mvh99eos-b75dffe5` 保留且状态仍为 `partially-completed`（未被改写） |
| **S4** | **PARTIAL** | `flow-a15-s4` 真实 UI 驱动：导航「内容合规审查 → 进入本地材料审核 → 案卷办理」→ 展开「从已发布模板新建」→ 选择模板 → 填 6 个案例级字段 → **点「创建一份案卷」成功**（`case-mvha4fj8`）→ **点「按模板规则检查」产出真实 Run** `run-tpl-mvha6hm1-40f32fb2`（人数 compliant、材料 awaiting-supplement）。**断点**：材料导入需 OS 级文件拖拽或原生文件对话框，CDP `Input.dispatchDragEvent` 无法把本地文件投递给 `webUtils.getPathForFile`，headless 环境无法合成；因此提交与初审未能经 UI 走到。材料与后续阶段的真实证据来自 S2/S3（IPC 触发、走同一 Main writer）。 |

### S2 最小缺失（交回 Owner）

1. `B1AuthorDocument.modules[].checks[]` 缺 `RuleSpec` 四要素（`execution` / `policyVersionId` / `targetScope` / `confirmation`），
   或
2. 需要 `compileTemplateToCanonicalPlan(template: TemplateVersion): { plan: CanonicalPlan; rules: RuleSpec[] }` 的领域定义，
   明确 `sections[].criteria[].requirement`（自然语言）如何映射为可执行 `RuleSpec`、`PlanBinding.checkKey` 与来源版本。
3. 明确 A15 的四项语义：人数≤20（`value-limit`）、计划书必交（材料槽）、两级阶段、无学年/无分数。

**L 线承诺**：合同落地后负责把成熟 `RuleSpec/PlanBinding` 绑到唯一正式 Case/Run，`asOfDate` 由调用方显式传入，
结果经既有 Run writer 持久化并展示真实 `CheckResult`/`SourceRef`。不猜规则、不特判「实验室」。

---
# L3｜主线接收台账

**主线基线**：`main` @ `566ea893f`
**集成工作树**：`/home/miku/Bot/CDUTStudio/wt/integration-l01`（分支 `integration/local-l01`）

## 本线已完成（Local-L01）

| 提交 | 内容 | 验证 |
|---|---|---|
| `30f8597ff` | 通用建案解除全局学年强制（按领域判定） | 单元 4 项 + 真机 `verify-academic-year` |
| `88566f00f` | 看门狗首字节只认内容事件；失败原因透出到界面 | 针对性 35 项 |
| `4cbab30f7` | 切换领域到按学年组织评审业务时校验学年一致性 | 单元 2 项 |
| `5fc6dd846` | L0 基线核验结论 | — |
| `681a7df54` | L2 十条线共享入口现状与缺口 | — |
| `81565b33e` | E2E 新增学年解耦真机场景 | 真机 3 项 + flow-core 无回归 |
| `4cbab30f7` | 切换领域到按学年组织评审业务时校验学年一致性 | 单元 2 项 |
| `566ea893f` | 提示词事前告知合法 FieldSpec（从历史定向移植字段契约） | 单元 3 项 + 真机确认已进入下发 prompt |

## 十条线接收记录（Local-L04）

**集成基线**：`main` @ `4bf3d4404`（B1+B2+B3 全部合入后）
**来源固定 SHA 与分支头核对**：十条均同步，无追加提交。

| 线 | 来源固定 SHA | 合入方式 | 状态 | 生产消费者 / 缺口 |
|---|---|---|---|---|
| T01 | `ac2947fc6` | `ecc00e66b` | **WIRED** | `TemplateWizardPanel`（条件编辑、试跑、导入导出） |
| T02 | `36687a952` | `1babad8e7` + 桥接 `49576336c` | **JOURNEY_VERIFIED** | 复用 `review-v3-main-local-product-intake` 已由 Main 派生 B2 ctx 的生产链，新增只读 `T02_STAGED_INVENTORY_V3`；`V2CasePanel` → `ReviewV3T02CoverageSection` → 覆盖面板。真机 total 2 / parsed 1 / partial 1 / 块 6+9 |
| T03 | `28528b02b` | `fae977a17` + 接线 `4bf3d4404` | **WIRED** | `V2CasePanel` → `ReviewV3T03FactWorkbench`（与观察项面板同案卷上下文） |
| T04 | `54678e8ee` | `5df23c6da` | **BLOCKED_OWNER** | `evaluateT04Plan` 需要 `CanonicalPlan` + 每 binding 的 `RuleSpec`。但 A15 模板绑定路径（T01/T10）**不产生 CanonicalPlan**；B1 候选路径虽有 CanonicalPlan，其 `modules[].checks[]` 只有 `requirement` 而无 `RuleSpec`（无 execution/policyVersionId/targetScope）。缺的是 B1-check→RuleSpec 合同，属 Owner 决策，L 线不自行发明业务语义 |
| T05 | `41c3f2fa9` | B2 合入 | **WIRED** | `V2CasePanel` → `ReviewV3T05HumanWorkflow` + `RunDecision`（替换旧 `BusinessFlowSection`） |
| T06 | `9ac93052f` | B2 合入 | **WIRED** | `BatchPanel` → `ReviewV3T06BatchIntakePreview` |
| T07 | `37c6d3212` | B2 合入 + 桥接 `e4e4d50f3` | **JOURNEY_VERIFIED** | `BatchPanel` 区 → `ReviewV3T07Workbench` → `ReviewV3T07JudgePanel`；桥接新增 `review-v3-t07-state-store`（原子写 + revision 乐观锁）、`review-v3-t07-main-service`（Main 派生 actor / 投影 / 动作）、IPC `T07_GET_VIEW`/`T07_APPLY_ACTION`/`T07_INIT_STATE` |
| T08 | `d83b4be32` | B3 合入 | **WIRED** | `AssistantDrawer` → `ReviewV3T08ReportPanel` |
| T09 | `474cf5f84` | B2 合入 + 桥接 `8d7cd369f` + UI `47d3a4e95` | **WIRED** | `review-v3-t09-main-service`（签发落盘 / 回件校验 / actionId 幂等）+ 三个 IPC + `V2CasePanel` → `ReviewV3T09OfflineSection`（签发/复制/预览/导入）。附件先登记为 DocumentVersion 再答复补件。完整往返由单测覆盖（ready→accepted→duplicate）；真机仅验到「无补件时签发被拒」 |
| T10 | `3679cc4e3` | B3 合入 | **WIRED** | `ContentReviewView` → `ReviewV3T10WorkspaceOverview` |

**T05 × T10 交叠文件 `V2CasePanel.tsx`**：git 自动三方合并，已逐项核对双方内容均在——
T05 的 `ReviewV3T05HumanWorkflow`/`RunDecision` 在（4 处引用）、旧 `BusinessFlowSection` 已删；
T10 的 `onCaseOpened`（7 处）、「案卷办理」标题、折叠区、条件化姓名字段均在。未整文件覆盖。

## 真机验证

| 旅程 | 结果 | 证据 |
|---|---|---|
| A15 起点（T01 模板 → 无学年绑案） | **PASS** | `saveDraft` → `publish` → `createCase`（contract-review 领域、无学年）→ 学年为空、`templateBound=e2e-t01-lab-request` |
| A15 业务阶段（提交→初审→终审） | **PASS（止于终审）** | `flow-a15` 真机：T01 模板（人数上限 20 字段 + 必需材料槽 + 初审 reviewer/终审 teacher）→ 无学年建案 → 按槽位登记真实 PDF → `submitCaseV2` 成功（stage=submitted，生成初审任务）→ 初审 `stage-pass` 由本地审核员通过（stage=reviewing，decision actor=reviewer）→ **终审被 `INVALID_TRANSITION` 拒绝**（需 teacher，本地无此身份，正确安全边界）→ 报告导出成功 |
| A15 确定性规则计算 | **BLOCKED_OWNER** | 模板的 `deterministic` 判据需 T04 执行，但 T04 缺 B1-check→RuleSpec 合同；本轮 A15 只覆盖业务阶段链，不声称确定性检查已跑通 |
| A15 完整（初审/终审/决定/报告） | NOT_RUN | 依赖 T04 规则执行入口与 T05 阶段决定在真实案卷上的联调 |
| A09 补件闭环 | **PASS** | `flow-a09` 真机：建案(带字段模板) → 真实 PDF → 审核 `completed/12 checks` → 要求补件 → 导入真实 DOCX 新原件 → 答复 → 判定 satisfied → 阶段回到 `reviewing`、补件状态 `satisfied`、**旧 Run 仍 completed 且 runCount=1（未被改写）** |
| A09 申诉复审 | **BLOCKED_BY_DESIGN** | `resolveAppealV2` 要求 `actor.role === 'teacher'`（"申诉更正必须由经过授权的复核教师完成"），本地入口经 `bindLocalReviewerCommand` 固定为 reviewer。本地无法完成改判是**正确的安全边界**，不是缺口；T05 UI 在缺端口时如实提示「填写内容只保存在当前表单，不会假称已提交」 |
| A12+A14 批次/评委 | **PASS（评委链路）** | `flow-t07-judging` 真机：2 案 → 批次 → 轮次 rev1 → 4 次分配 rev5 → 双评委各 2 项评分 rev9 → 组织者排名（各 2 有效评委、total 5）→ 定稿 rev10 |
| 冷重启恢复（T07 状态） | **PASS** | `phase-t07-prepare`（新进程 A）建批次+轮次+4 分配+2 票 → `phase-t07-verify`（新进程 B）读回 revision 7、assignments 4、votes 2；缺评时 `rank=null`，门控未因重启失效 |
| 冷重启恢复（Case/Plan/D4） | **PASS** | 早前 `phase-prepare`/`phase-verify`：案卷、2 份材料、60 项 Plan、4 条回执链完整恢复 |
| 原基线不回归 | **PASS** | `bun test --isolate` 4747 pass / 0 fail / 5 skip；D4 50 套、学年解耦、看门狗用例均在 |

## 接收流程（每次）

1. 拿到固定 commit + 交付说明。
2. `git fetch` 后查重：新能力是否与 main 等价实现重复（用导出名 + 调用链比对，不整分支 diff）。
3. 复用其功能模块，只补共享 Main / IPC / Preload 桥接。
4. 解决类型冲突、调用错误、持久化不兼容。
5. **按修改范围选验证**：只改 Main 用针对性单元；改 IPC/持久化加 `verify-*` 真机场景；重要集成节点跑 `flow-full`。
6. 合入 main，并在上表记录「可操作程度」（如：可建案但无 UI / 可跑审核无报告）。
7. 若产物缺它自身的业务实现而无法运行 → 标 `WAITING_FOR_OWNER`，继续其他线。

## 回滚点

每个接收 commit 独立提交，回滚只需 revert 对应 sha；不 squash 多条线。
