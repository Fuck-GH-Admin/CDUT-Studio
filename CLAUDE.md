# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**重要提示（不可违背的红线原则）：**
- 当功能发生变化时，请保持此文件和 `README.md` 同步更新。请更新文档以反映当前状态，但是需要经过我的允许后再修改。
- 所有的注释和日志优先采用中文，保留必要的专业术语部分。
- 所有的依赖包的安装都要先进行搜索，综合判断依赖采用的版本，而不是默认采用某个版本。
- 状态管理上我们全部采用 Jotai 来实现。
- 这是个开源项目，本地存储优先，善用配置文件优于大部分默认采用 localstorage，不采用本地数据库方案。
- 保证充分的组件化以及人类的可读性，每次完成改动后都要思考这一点，保持简单直接不过度设计的风格。
- 在 UI 设计上采用更现代的方案，UI 组件推荐采用 ShadcnUI，在合适的情况下，用卡片和阴影取代边框，用符合主题的饱满色彩，设置界面要设置背景，为未来做不同主题留下空间。
- 采用 BDD 行为驱动开发的方案。
- 完成前端与渲染进程逻辑改动后、提交或打包前，必须至少执行 `bun run typecheck`（或 `bun run --filter='@profer/electron' typecheck`），严禁在存在 TypeScript 编译错误/缺少 import 的情况下进行打包构建。

> 本文件与 `AGENTS.md` 保持同一套项目约束；平台相关命令必须按当前宿主系统和运行时检测结果执行。

---

## 1. 项目概述与技术栈

CDUT Studio（成都理工大学定制 AI 智能体工作台）是一个集成通用 AI Agent 的下一代桌面人工智能软件，采用 Electron 桌面应用架构。核心运行时由 **Pi Coding Agent（`@earendil-works/pi-*`）作为唯一内核驱动**。

> **项目命名**：CDUT Studio（代码内部兼容包名前缀 `@profer/*`）。

### 核心技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **运行时** | Bun 1.2.5+（推荐 1.4.2+） | 统一使用 Bun 代替 Node.js/pnpm 执行脚本与测试 |
| **语言** | TypeScript 5.0.0+ | 严格模式，`"moduleResolution": "bundler"` |
| **桌面框架** | Electron ^43.2.0 | 主进程/Preload 由 esbuild 构建，渲染进程由 Vite 构建 |
| **前端框架** | React 18.3.1 | 现代化函数式组件 + Hooks |
| **状态管理** | Jotai ^2.17.1 | 全局与局部状态原子化管理 |
| **核心内核** | Pi Agent（`@earendil-works/pi-*` 0.86.1） | **唯一内核**，驱动代码编写、工具调用与任务执行 |
| **UI 体系** | Tailwind CSS + Radix UI + TipTap | 现代卡片阴影设计，支持深浅主题无缝切换 |
| **分发打包** | Electron Builder ^25.1.8 | 支持 Windows NSIS/Unpacked、macOS DMG/ZIP 分发 |

---

## 2. Monorepo 结构与常用命令

基于 Bun workspace 的 Monorepo 结构（6 个核心包 + Electron 应用 + CLI）：

```
CDUT-Studio/
├── packages/
│   ├── shared/        # 共享类型、IPC 通道常量、配置与工具函数 (@profer/shared v0.1.45)
│   ├── core/          # AI Provider 适配器、代码高亮、PDF 解析引擎 (@profer/core v0.2.12)
│   ├── session-core/  # headless session 读取/分组/搜索/渲染 (@profer/session-core v0.1.1)
│   ├── ui/            # 共享 UI 组件库 (@profer/ui v0.2.0)
│   ├── agent-fabric/  # Agent 编排契约与纯函数行为 (@profer/agent-fabric v0.1.0)
│   └── project-core/  # 项目级图构建、状态重放与查询 (@profer/project-core v0.1.0)
└── apps/
    ├── electron/      # Electron 桌面应用主体 (@profer/electron v0.15.89)
    │   └── src/
    │       ├── main/       # 主进程 + 服务层 (main/lib/)
    │       ├── preload/    # IPC 上下文桥接
    │       └── renderer/   # React UI (Vite + Tailwind + Radix UI)
    └── cli/           # 独立命令行脚手架 (@profer/cli v0.1.1，bin: profer)
```

**包命名规范**：`@profer/*` 作用域（`@profer/core`、`@profer/shared`、`@profer/ui`、`@profer/electron` 等）。

**依赖管理**：内部包使用 `workspace:*` 互相引用。优先使用 Bun 原生 API（`Bun.file` > `node:fs`）。

### 包职责详解

#### @profer/shared (v0.1.45)
- **导出模块**：`"."`、`./types`、`./config`、`./utils`
- **关键类型**：`AgentEvent`、`AgentMessage`、`AgentSessionMeta`、`Channel`、`PermissionRequest`、`FeishuConfig`、`WorkspaceCapabilities`
- **依赖**：无运行时依赖（仅 TypeScript）

#### @profer/core (v0.2.12)
- **导出模块**：`"."`、`./providers`、`./highlight`、`./pdf-engine`
- **关键功能**：Provider 适配器注册表、代码高亮（Shiki）、自研高精 PDF 解析引擎（基于 `pdfjs-dist` 的源保持文档 AST）
- **依赖**：`@profer/shared`、`highlight.js`、`pdfjs-dist`、`shiki`
- **Peer 依赖**：`@anthropic-ai/sdk >=0.70.0`、`@modelcontextprotocol/sdk >=1.0.0`

#### @profer/session-core (v0.1.1)
- **职责**：headless 核心——读取、分组、搜索、渲染 CDUT Studio Agent 会话。Electron 应用、`profer` CLI 和未来查询界面的单一事实来源
- **导出模块**：`"."`（`group`、`outline`、`read`、`search`、`select`、`transcript`、`render-markdown`、`thinking-tags`、`tokens`）、`./node`（文件系统读取 + session 列表）
- **依赖**：`@profer/shared`

#### @profer/ui (v0.2.0)
- **导出模块**：`"."`、`./primitives/*`、`./lib/*`、`./hooks/*`
- **关键组件**：共享 React UI 组件库（Radix 原语、Mermaid 渲染、Shiki 代码高亮、KaTeX 数学公式）
- **依赖**：`@profer/core`、`beautiful-mermaid`、`mermaid`、`shiki`、`lucide-react`、`cmdk`、`sonner` 等
- **Peer 依赖**：`react@^18.3.0`、`react-dom@^18.3.0`

#### @profer/agent-fabric (v0.1.0)
- **职责**：Agent Node / Task Protocol / Task Graph / Capability / Policy / Event / Artifact / Result 的统一 TypeScript 契约与纯函数行为（状态机、策略收窄、事件重放、审批绑定）。**不绑定 Electron、Claude SDK 或 Pi runtime**
- **导出模块**：`"."`
- **依赖**：无运行时依赖（仅 TypeScript）

#### @profer/project-core (v0.1.0)
- **职责**：Agent 项目编排的 headless 核心——图构建（Graph construction）、状态重放（state replay）与查询（query）。由 Electron 应用、CLI 与未来查询界面共享
- **导出模块**：`"."`
- **依赖**：`@profer/shared`

#### @profer/electron (v0.15.89)
- **职责**：Electron 桌面应用主体，集成所有包
- **关键依赖**：
  - `@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-ai`（0.86.1）- 唯一内核
  - `@anthropic-ai/sdk`、`@modelcontextprotocol/sdk` - 协议层
  - `@larksuiteoapi/node-sdk`、`dingtalk-stream-sdk-nodejs` - 飞书/钉钉集成
  - Radix UI、TipTap、Tailwind CSS
  - 文件解析：`pdfjs-dist`（PDF 经 `@profer/core/pdf-engine` 高精引擎解析）、`officeparser`、`word-extractor`、`mammoth`

#### @profer/cli (v0.1.1)
- **职责**：`profer` 命令行工具，面向有限上下文的 Agent 消费者，提供会话渐进式读取（list / info / outline / search / export）
- **bin**：`profer`
- **依赖**：`@profer/session-core`、`@profer/shared`

### 常用开发命令

```bash
# 开发模式（推荐 - Vite HMR；Electron 只启动一次）
bun run dev

# 构建全量产物
bun run electron:build

# 类型检查（全仓库所有工作区，共 6 包 + Electron + CLI，提交或打包前必跑）
bun run typecheck
cd apps/electron && bun run typecheck

# 单元测试
bun test

# 图标成品守卫（校验 resources/icon.png 为 1024x1024 正方形、icon.ico 为合法多图 ICO；
# 纯字节解析、零额外依赖，不需要 rsvg-convert，任意平台可运行）
cd apps/electron && bun test scripts/packaging-guards.test.ts

# 架构边界检查（根目录脚本）
bun run check:boundaries

# 依赖同步与 Pi 运行时校验（须在 apps/electron/ 下执行；verify 脚本仅 Windows）
cd apps/electron
bun run sync:runtime-deps
bun run verify:packaged-pi-runtime

# 打包分发（Windows x64 请在 Windows 主机执行）
cd apps/electron
bun run dist:fast     # 当前架构快速打包 (win-unpacked)
bun run dist:win      # Windows x64 正式安装包
bun run dist:mac      # macOS 产物打包
```

> 说明：renderer 修改即时由 Vite HMR 生效；main/preload 仍会持续构建到 dist，但默认不会自动重启 Electron。修改 main/preload 后需手动重新执行 `bun run dev` 才加载新代码。

### Electron 构建脚本（`apps/electron/` 目录下）

```bash
bun run build:main        # esbuild → dist/main.cjs（注入 __PROFER_BUILD_TARGET__）
bun run build:preload     # esbuild → dist/preload.cjs
bun run build:renderer    # Vite → dist/renderer/
bun run build:cli         # 构建内置 CLI
bun run build:resources   # 复制 resources/ 到 dist/
bun run generate:icons    # 生成应用图标
bun run verify:build-target:oss          # 校验构建目标注入为 oss
bun run verify:build-target:commercial   # 校验构建目标注入为 commercial
bun run check:skin-token-sync            # 皮肤 token 同步检查
bun run check:skin-contract              # 皮肤 surface 契约检查
```

---

## 3. 运行时环境

使用 Bun 代替 Node.js/npm/pnpm：

- `bun install` 安装依赖，`bun run <script>` 运行脚本
- `bun test` 运行测试（内置测试运行器，`import { test, expect } from "bun:test"`）
- Bun 自动加载 .env 文件（无需 dotenv）
- 优先使用 Bun 原生 API：`Bun.file` > `node:fs`，`Bun.$\`command\`` > `execa`

---

## 4. 核心架构与设计模式

### 4.1 IPC 通信模式（核心架构模式）

类型定义 → 主进程处理 → Preload 桥接 → 渲染进程调用：

1. **类型 & 常量**：`@profer/shared` 集中定义 IPC 通道常量及强类型请求/响应；
2. **主进程处理**：`main/ipc.ts` 集中注册 `ipcMain.handle()`，统一调度 `main/lib/` 服务；
3. **Preload 桥接**：`preload/index.ts` 通过 `contextBridge.exposeInMainWorld` 暴露安全 API（`window.electronAPI.*`）；
4. **渲染进程**：通过 Jotai Atoms 或专用 Hooks 封装通信调用，不在 UI 组件内散落原生通信。

添加新 IPC 通道时，需要同步修改这四个位置。

主要通道组：`AGENT_IPC_CHANNELS`、`CHANNEL_IPC_CHANNELS`、`REVIEW_IPC_CHANNELS`、`FEISHU_IPC_CHANNELS`、`ENVIRONMENT_IPC_CHANNELS`、`PROXY_IPC_CHANNELS`、`AUTOMATION_IPC_CHANNELS`、`PLANNING_IPC_CHANNELS`、`SKIN_IPC_CHANNELS`、`SKILL_MASTER_IPC_CHANNELS` 等。

### 4.2 Pi Agent 运行与执行环境（关键约束）

- **内核驱动**：以 `@earendil-works/pi-coding-agent` 为唯一执行内核，内部协议通过适配器（`main/lib/adapters/pi-*`）与界面事件解耦。`agent-orchestrator.ts` 在运行期动态 `import('@earendil-works/pi-coding-agent')`。
- **版本锁定**：根 `package.json` 通过 `overrides` 将 `pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 全部锁定为 `0.86.1`，并对 `pi-ai@0.86.1`、`pi-coding-agent@0.86.1` 施加 `patchedDependencies` 补丁（`patches/`）。升级 Pi 版本必须同时评估补丁与 native addon 兼容性。
- **Windows 零配置开箱即用**：
  - Windows 执行环境实行**静默自动降级策略**：`Git Bash（若已装） > 内置 BusyBox Bash > WSL > 原生 PowerShell`。
  - 用户无感知、界面无切换开关，确保全新纯净 Win10/Win11 机器无需预装 Git 或配置 WSL 即可直接运行。
  - **内置 MinGit 零配置检查点**：针对无 Git 的 Windows 设备，系统优先探测本机 Git，缺失时无缝切换至应用内置的精简版 MinGit（`resources/bin/git/cmd/git.exe`），保证增量检查点毫秒级快照开箱即用。
- **沙箱隔离与全能力同构（防特权缺失与串扰）**：
  - **无工作区模式沙箱隔离**：未指定工作区时，统一使用默认工作区提供会话隔离沙箱（`~/.cdutai/agent-workspaces/default/{sessionId}`），**严禁将用户宿主个人主目录（`homedir`）或盘符根目录作为 Agent 工作空间**。
  - **独立会话能力 100% 同构**：无工作区会话在编排时自动绑定有效沙箱工作区引用（`const effectiveWorkspaceId = workspaceId ?? workspace?.id`，见 `agent-orchestrator.ts`），**严禁因未指定工程工作区而关闭子智能体委派（`collaboration`）、任务图（`task-graph`）与记忆库能力**。
- **快照拒止与主进程防冻结（防卡死红线）**：
  - **快照拒止与熔断机制**：`pi-file-checkpoint.ts` 对敏感目录（主目录与盘符根目录）绝对拒止执行快照；物理复制降级引擎强制执行 `MAX_SNAPSHOT_FILE_COUNT = 500` 文件硬熔断，严禁同步复制几十万文件阻塞 Electron 主线程事件循环。
  - **非阻塞式快照回收与会话删除**：
    - 快照垃圾回收（`gcShadowRepo`）必须在独立子进程后台静默异步执行并去重，**严禁在主事件循环同步调用 `git gc` 阻塞 UI**（测试环境保持同步以防临时目录占用）；
    - 会话删除（`deleteAgentSession`）实行"索引瞬时摘除 + 物理磁盘后台异步离线清理"，保证 UI 毫秒级反馈。
- **思考链 (Thinking) 流式体验**：
  - 支持思考的模型（如 DeepSeek/Claude）思考块必须正常渲染并支持折叠收纳；
  - 无工具调用时正文必须直接外置流式输出，**严禁将纯回复误收纳进折叠过程组**导致界面出现假死无限 Spinner。
- **权限安全体系**：`packages/shared/src/constants/permission-rules.ts` 定义只读/安全白名单与危险命令拦截。

### 4.3 主进程服务层（`main/lib/`）

`main/lib/` 是一个体量很大的服务矩阵（400+ 文件），按职责分为若干族。核心编排与运行时：

| 服务模块 | 职责与设计要点 |
|----------|----------------|
| `agent-orchestrator.ts` | 核心编排层：并发守卫、渠道调度、环境装配、沙箱隔离、自动标题生成与流式推送 |
| `adapters/pi-agent-adapter.ts` | Pi 内核适配器：绑定 Pi runtime，转换消息/工具/流事件 |
| `adapters/pi-builtin-tools.ts` | Pi 内置工具装配（bash / powershell / 文件读写等） |
| `adapters/pi-model-registry.ts` | Pi 模型注册表与运行时模型能力解析 |
| `adapters/pi-mcp-tools.ts` / `pi-skill-resources.ts` | Pi 侧 MCP 工具与 Skills 资源注入 |
| `adapters/pi-prompt-chain.ts` / `pi-task-prompt.ts` | Pi 提示链与任务提示构建 |
| `pi-harness/` | Pi Harness：goal-controller、governor、reconciler、verification-evaluator、replay 评测等运行时治理 |
| `pi-file-checkpoint.ts` | 文件增量快照引擎：优先 Git 检查点，内置 MinGit 降级回退，物理复制带 500 文件安全熔断 |
| `pi-background-task-manager.ts` / `background-task-manager.ts` | 后台任务/Shell 任务生命周期管理 |
| `pi-execution-ledger.ts` | 执行账本：记录 Agent 运行事实 |
| `agent-session-manager.ts` | Agent 会话管理：消息持久化、会话元数据 CRUD、JSONL 存储、委派子会话元数据 |
| `agent-collaboration-tools.ts` | Agent 协作委派工具：`delegate_agent` / `delegate_agents` / `wait_for_delegations` / `list_delegations` / `get_delegation_results` / `stop_delegation(s)` / `answer_delegation_question` / `continue_delegation` / `list_available_agent_models` 等子会话创建、等待、管理与恢复 |
| `agent-prompt-builder.ts` | Agent 系统提示词构建：动态上下文构建、内置 Agent 构建、工作区上下文注入 |
| `agent-service.ts` / `agent-headless-runner-registry.ts` | headless Agent 运行服务与协作委派运行实例注册表 |
| `agent-permission-service.ts` / `agent-ask-user-service.ts` / `agent-exit-plan-service.ts` | 权限管理、AskUser 交互、退出计划服务 |
| `agent-preset-manager.ts` / `agent-preset-operations.ts` | Agent 预设（Preset）管理 |
| `agent-workspace-manager.ts` | 工作区管理：MCP Server 配置、Skills 配置、工作区 CRUD、默认沙箱工作区保障 |
| `channel-manager.ts` | 渠道管理：渠道 CRUD、API Key AES-256-GCM 本地加密存储与连通性测试 |

集成与系统服务：

| 服务模块 | 职责 |
|----------|------|
| `feishu-bridge.ts` / `feishu/` | 飞书集成：消息同步、任务通知、卡片渲染、OAuth 认证 |
| `dingtalk-bridge.ts` / `dingtalk-*` | 钉钉集成 |
| `lark-cli-service.ts` / `lark-mcp-service.ts` | Lark CLI / MCP 服务 |
| `memory-service.ts` / `memory-archive-search.ts` / `memory-wikilink-service.ts` | 跨会话记忆存储、归档检索与 wikilink |
| `knowledge-item-service.ts` | 知识库条目服务 |
| `automation-manager.ts` / `automation-scheduler.ts` / `automation-notification-service.ts` | 定时任务持久化调度、运行、通知 |
| `planning-manager.ts` / `planning-reminder-scheduler.ts` | 规划（Planning）管理与提醒 |
| `goal-tools.ts` / `goal-store.ts` / `goal-loop.ts` / `goal-session-service.ts` | Goal（目标）运行时与工具 |
| `skill-master-manager.ts` / `global-skill-manager.ts` / `skill-routing.ts` | 全局元 Skill、技能路由与策略投影 |
| `skin-manager-service.ts` / `skin-preview-cache.ts` / `ppt-style-pack-service.ts` | 皮肤与 PPT 风格包服务 |
| `browser-controller.ts` / `browser-*` | 内嵌浏览器控制、策略、截图与会话 |
| `review/` | 内容审核专区服务矩阵（案卷存储、文档切块、白名单网关、双路径预审、报告导出） |
| `runtime-init.ts` / `shell-env.ts` / `git-detector.ts` / `git-bash-detector.ts` / `bun-finder.ts` / `node-detector.ts` | 运行时初始化：Shell 环境注入、Bun/Git/Node 检测与自适应配置 |
| `config-paths.ts` | 配置路径管理：`~/.cdutai/` 目录结构与默认 Skills 播种 |
| `migration-service.ts` / `project-instruction-migration.ts` | 数据/项目指令迁移 |
| `updater/` / `github-release-service.ts` / `changelog-service.ts` | 自动更新、发布与更新日志 |
| `remote-*.ts` | 远程接入相关服务（保留底层能力，UI 入口已裁剪） |
| `team-*` / `sync-manager.ts` / `file-sync-service.ts` | 团队兼容数据同步底层服务（UI 入口已移除，部分 planning/team 路径仍调用） |

### 4.4 AI Provider 适配器（`packages/core/src/providers/`）

基于适配器模式，通过 `adapterRegistry` 统一管理，按 `providerId` 查找适配器：

#### 核心架构
- `ProviderAdapter` 接口：定义统一的 `sendMessage()` 流式方法
- 适配器实现：`AnthropicAdapter`、`OpenAIAdapter`、`OpenAIResponsesAdapter`、`GoogleAdapter`
- `sse-reader.ts`：通用 SSE 流读取器（fetch + ReadableStream）

#### 支持的 Provider（实际注册表）

| providerId | 适配器 | 协议 |
|-----------|--------|------|
| `anthropic` | `AnthropicAdapter` | Anthropic Messages API |
| `anthropic-compatible` | `AnthropicAdapter` | Anthropic 兼容 |
| `openai` | `OpenAIAdapter` | OpenAI Chat Completions |
| `openai-responses` | `OpenAIResponsesAdapter` | OpenAI Responses API |
| `xai` | `OpenAIResponsesAdapter` | xAI Responses API |
| `deepseek` | `OpenAIAdapter` | OpenAI 兼容 |
| `kimi-api` | `AnthropicAdapter` | Anthropic 兼容 |
| `kimi-coding` | `AnthropicAdapter` | Anthropic 兼容 |
| `zhipu` | `OpenAIAdapter` | OpenAI 兼容 |
| `zhipu-coding` | `AnthropicAdapter` | Anthropic 兼容 |
| `minimax` | `AnthropicAdapter` | Anthropic 兼容 |
| `ollama` | `OpenAIAdapter` | OpenAI 兼容（本地） |
| `doubao` | `OpenAIAdapter` | OpenAI 兼容 |
| `qwen` | `OpenAIAdapter` | OpenAI 兼容 |
| `xiaomi` | `AnthropicAdapter` | Anthropic 兼容 |
| `xiaomi-token-plan` | `AnthropicAdapter` | Anthropic 兼容 |
| `custom` | `OpenAIAdapter` | 自定义 OpenAI 兼容端点 |
| `google` | `GoogleAdapter` | Google Generative Language API |

#### 多模态支持
- **图片**：各 Provider 格式不同，适配器自动转换
- **文档**：提取文本后注入 `<file>` XML 标签

### 4.5 Agent 运行时集成架构（Pi 内核）

Agent 主界面只保留 Agent 工作流；Chat 用户模式与第三方插件宿主已移除。**Pi 是唯一执行内核**，`adapters/pi-agent-adapter.ts` 负责把 Pi runtime 的流事件转换为应用统一事件。

```
用户输入 → agent-orchestrator.ts (编排)
  ↓
Pi runtime (@earendil-works/pi-coding-agent) → 流事件
  ↓
pi-agent-adapter / pi-message-adapter → AgentEvent[]
  ↓
webContents.send() → IPC 推送
  ↓
useGlobalAgentListeners (全局监听) → store.set(atoms)
  ↓
React UI 更新
```

#### 关键设计

- **并发守卫**：同一会话不允许并行请求。
- **事件转换**：Pi/适配层将内核原始流消息转为统一的 `AgentEvent` 类型。
- **工具匹配**：`packages/shared/src/agent/tool-matching.ts` — 无状态 `ToolIndex` + `extractToolStarts` / `extractToolResults` 解析工具调用。
- **状态管理**：`applyAgentEvent()` 纯函数更新 `AgentStreamState`，支持流式增量更新。
- **全局 IPC 监听**：`useGlobalAgentListeners`（`renderer/hooks/`）在 `main.tsx` 顶层挂载，通过 `useStore()` 直接操作 atoms，永不销毁。确保页面切换（如设置页）时流式输出、权限请求不丢失。
- **权限请求排队**：权限/AskUser 请求按 sessionId 入队到 Map atoms（`allPendingPermissionRequestsAtom` / `allPendingAskUserRequestsAtom`），不区分当前/后台会话，等待用户回来响应。
- **工作区隔离**：每个工作区独立的 MCP Server 配置和 cwd，Agent 会话按工作区过滤；无工作区时落到默认沙箱工作区。

#### 共享类型（`@profer/shared`）

- `AgentEvent`：Agent 事件（text / tool_start / tool_result / done / error）
- `AgentSessionMeta`：会话元数据（id / title / channelId / workspaceId）
- `AgentMessage`：持久化消息（role + content blocks）
- `AgentSendInput`：发送请求输入
- `AGENT_IPC_CHANNELS`：Agent 相关 IPC 通道常量
- `WorkspaceCapabilities`：工作区能力（MCP Server 列表 + Skills 列表）

---

## 5. 渲染进程架构与 Jotai 状态管理

状态管理全量采用 **Jotai**（`apps/electron/src/renderer/atoms/`）：

| Atom 文件 | 管理职责 |
|-----------|----------|
| `agent-atoms.ts` | 会话列表、当前激活会话、流式状态（`AgentStreamState`）、渠道/工作区映射、权限与问答请求队列 |
| `agent-preset-atoms.ts` | Agent 预设（Preset）选择与管理 |
| `conversation-atoms.ts` / `draft-session-atoms.ts` | 会话数据与草稿会话 |
| `active-view.ts` | 主面板视图路由（`conversations` / `planning` / `agent-skills` / `content-review`） |
| `app-mode.ts` | 应用模式状态（历史 chat 值仅为设置兼容） |
| `tab-atoms.ts` / `tab-group-atoms.ts` | 标签页与标签组 |
| `sidebar-atoms.ts` / `panel-layout-atoms.ts` | 侧边栏与面板布局 |
| `settings-tab.ts` | 设置面板标签页路由（18 个：general / usage / account / channels / appearance / about / agent / prompts / tools / bots / tutorial / shortcuts / team / openapi / data-management / developer / proxy / devices） |
| `theme.ts` / `ui-preferences.ts` / `ui-scale.ts` / `markdown-font-size.ts` | 主题模式、界面偏好、界面缩放、Markdown 字号 |
| `review-atoms.ts` | 内容审核专区状态：当前案卷/案卷列表、审核运行、问题卡选中态、三栏联动焦点（`reviewFocusAtom`，nonce 驱动）、规则定位、忙碌/错误态、网关出口自检、助手消息 |
| `planning-atoms.ts` / `goal-atoms.ts` / `graph-atoms.ts` | 规划、目标与项目图状态 |
| `automation-atoms.ts` | 定时任务状态（`automationsAtom`、`automationFormAtom`） |
| `browser-atoms.ts` / `preview-atoms.ts` | 内嵌浏览器与预览面板 |
| `feishu-atoms.ts` / `dingtalk-atoms.ts` / `wechat-atoms.ts` | 飞书/钉钉/微信集成状态 |
| `team-atoms.ts` / `identity-atoms.ts` | 团队兼容与身份状态 |
| `notifications.ts` / `proxy-atoms.ts` / `environment.ts` / `search-atoms.ts` / `shortcut-atoms.ts` | 通知、代理、环境检查、搜索、快捷键 |
| `system-prompt-atoms.ts` / `agent-preset-atoms.ts` | 系统提示词与预设 |
| `user-profile.ts` / `updater.ts` | 用户档案（姓名 + 头像）与自动更新状态（优雅降级，updater 不可用时保持 idle） |
| `migration-atoms.ts` / `intro-atoms.ts` / `coach-tour-atoms.ts` / `developer-mode.ts` | 迁移、引导、教练引导、开发者模式 |

### 渲染进程组件架构（`renderer/components/`）

- **`app-shell/`**：三面板布局，含 `left-sidebar/`（会话树、导航、rail）、`AppShell`、`NavigatorPanel`、`SearchDialog`
- **`content-review/`**：内容审核专区三栏工作台 — ContentReviewView（视图根）+ LeftPanel（依据材料 + AI 规则大纲 + 案卷管理条 CaseManagerBar/CreateCaseDialog）+ CenterPanel（待审条目与证明，SourceBlockView 定位高亮块）+ RightPanel（AI 审核员问题卡 FindingCard + 覆盖摘要 + 报告导出）+ AssistantDrawer（审核助手）+ `use-review-actions`（IPC 动作层）；三栏联动由 `reviewFocusAtom` 驱动（点问题卡 → 中栏红/黄高亮 + 左栏蓝高亮，跨文档矛盾双处同色）
- **`agent/`**：Agent 工作流（`AgentView`、`AgentHeader`、`AgentMessages`、`SDKMessageRenderer`、权限/问答 UI、`@` 提及、任务进度），含 `tool-result-renderers/`（bash / read / write / edit / glob / grep / task / web-fetch / web-search 等工具结果渲染）
- **`agent-skills/`**：Agent Skills 与 MCP 管理视图（含 `MasterSkillsTab` / `MasterSkillDetailSheet` / `SyncMasterSkillDialog` 元 Skill 三件套）
- **`settings/`**：通用、外观、模型渠道、Agent、提示词、快捷键、代理、数据管理与更新设置；含 `primitives/`（SettingsCard / SettingsRow / SettingsInput 等）与 `SkinManager`
- **`file-browser/`**：文件浏览器 — FileBrowser（工作区文件树），含 `office-preview/`、`ofv-preview/`
- **`diff/`**：Diff 与 Markdown 编辑器 — DiffView/DiffTabContent（并排 diff 展示）、PreviewPanel/PreviewTabContent（Markdown 预览）、MarkdownRichEditor/MarkdownEditorToolbar（富文本编辑）、MarkdownToc（目录导航）、PreviewFindBar（预览内搜索）、WorktreeSelector
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入（含 `composer/`）
- **`automation/`**：定时任务 UI — AutomationsListView、AutomationFormView、AutomationRecommendations
- **`planning/`**：规划工作台 — PlanningView、CalendarWorkspace、PlanningFloatingInspector、PlanningGroupManager、PlanningTagManager
- **`browser/`**：内嵌浏览器面板 — BrowserPanel、BrowserViewport、BrowserStartPage、BrowserTabContent
- **`tabs/`**：多标签框架 — MainArea、TabBar、TabContent、TabGroupItem、TabSwitcher、TabPreviewPanel
- **`auth/`**：认证 — JoinWorkspaceDialog
- **`scratch-pad/`**：草稿本 — ScratchPadView
- **`onboarding/`**：新手引导 — OnboardingView、FeatureTour、含 `coach-tour/` 教练引导
- **`knowledge-base/`**：知识库预览与引用选择
- **`migration/`**：迁移导入对话框
- **`environment/`**：环境检查卡片/面板
- **`selection/`** / **`navigation/`** / **`shortcuts/`** / **`session-preview/`** / **`welcome/`** / **`tutorial/`** / **`shared/`** / **`ui/`**：选区操作、导航输入、全局快捷键、会话预览、欢迎页、教程横幅、通用组件与 Radix 原语

### 全局 Hooks（`renderer/hooks/`）

| Hook | 职责 |
|------|------|
| `useGlobalAgentListeners` | 全局 Agent IPC 监听器，在 `main.tsx` 顶层挂载，使用 `useStore()` 直接操作 atoms。处理流式事件、完成/错误、标题更新、权限请求、AskUser 请求，永不随组件卸载销毁 |
| `useBackgroundTasks` | 后台任务管理（Agent/Shell 任务的增删改查），按 sessionId 隔离 |
| `use-plan-quota` | 渠道套餐配额展示与刷新 |
| `useCreateSession` / `useOpenSession` / `useCloseTab` | 会话创建、打开与标签关闭 |
| `usePanelAutoLayout` / `useSyncActiveTabSideEffects` / `useScrollPositionMemory` / `useScrollSpy` | 面板布局、标签副作用同步、滚动记忆与滚动监听 |
| `useShortcut` / `useSystemPromptAutosave` / `useConversationSettings` | 快捷键、系统提示词自动保存、会话设置 |

### 渲染进程初始化组件（`renderer/main.tsx`）

`main.tsx` 顶部挂载一组初始化组件（当前约 14 个）：

| 组件 | 职责 |
|------|------|
| `ThemeInitializer` | 从主进程加载主题设置、监听系统主题变化、同步到 DOM |
| `AgentSettingsInitializer` | 加载 Agent 渠道/模型/工作区设置、订阅 MCP/文件变化事件 |
| `AgentListenersInitializer` | 挂载 `useGlobalAgentListeners`，全局 Agent IPC 监听 |
| `AutomationInitializer` | 加载定时任务状态并订阅调度事件 |
| `PlanningInitializer` / `PlanningShortcutInitializer` | 初始化规划数据与规划快捷键 |
| `NotificationsInitializer` / `DockBadgeInitializer` | 桌面通知与 Dock 角标 |
| `UiPreferencesInitializer` / `UiScaleInitializer` / `MarkdownFontSizeInitializer` | 界面偏好、界面缩放、Markdown 字号 |
| `FeishuInitializer` / `DingTalkInitializer` | 飞书/钉钉集成状态加载与订阅 |
| `TabStatePersistenceInitializer` | 标签页状态持久化 |

---

## 6. 本地存储规范与精简边界

- **配置文件优先**：配置存放在 `~/.cdutai/`（正式版）/ `~/.cdutai-dev/`（开发版），可由 `PROFER_CONFIG_DIR` 覆盖。**CDUT Studio 不读取也不迁移 `~/.proma` / `~/.profer` 旧数据。**
- **用户 Agent 沙箱**：`~/.cdutai/agent-workspaces/{slug}/`，无工作区会话落到 `~/.cdutai/agent-workspaces/default/{sessionId}`。
- **结构化日志**：会话消息采用追加式 JSONL 存储（`agent-sessions/{sessionId}.jsonl`）。
- **坚守原则**：**绝不引入复杂重量级的本地数据库（如 SQLite）**，轻量文本配置与原子写入优于一切。
- **产品边界**：保持纯粹的 AI Agent 交互体验。历史遗留的独立服务端、多用户协同 UI 等已彻底清理，严禁引入过度设计的冗余模块。

### `~/.cdutai/` 目录结构（主要项）

```
~/.cdutai/
├── channels.json             # 渠道配置（API Key 经 AES-256-GCM 加密）
├── conversations.json        # 对话索引（元数据）
├── conversations/{id}.jsonl  # 每对话一个 JSONL 文件，追加写入
├── agent-sessions.json       # Agent 会话索引
├── agent-sessions/{id}.jsonl # 每会话一个 JSONL 文件
├── agent-workspaces.json     # 工作区索引
├── agent-workspaces/{slug}/  # 工作区目录
│   ├── {sessionId}/          # 会话工作目录
│   ├── workspace-files/      # 工作区持久文件
│   ├── skills/  skills-inactive/
│   ├── mcp.json              # MCP Server 配置
│   └── agent-presets.json    # 工作区预设
├── agent-checkpoints/        # 文件增量检查点（Git 影子仓库/物理快照）
├── default-skills/           # 全局默认/元 Skills 库
├── default-skills-history/   # 元 Skill 版本快照
├── attachments/              # 附件文件
├── automations.json          # 定时任务
├── settings.json / user-profile.json / proxy-settings.json
├── system-prompts.json / memory.json / agent-presets.json / chat-tools.json
├── feishu.json / dingtalk.json / wechat.json
├── scratch-pad.md / browser-start-page.json
├── knowledge-base/           # 知识库
└── sdk-config/               # Pi/内核配置目录
```

**关键设计**：
- JSON 配置 + JSONL 追加日志，无本地数据库，文件可移植
- Agent 工作区按 slug 隔离，每个会话独立目录
- MCP 配置和 Skills 按工作区管理

---

## 7. 默认 Skills（`apps/electron/default-skills/`）

应用启动时 semver 比较自动同步到 `~/.cdutai/default-skills/` 和各工作区。共 17 个：

| Skill | 用途 |
|-------|------|
| `automation` | 内嵌定时任务 Skill |
| `brainstorming` | 创意工作前需求探索和设计 |
| `docx` | Word 文档创建/读取/编辑 |
| `executing-plans` | 带审查检查点的实现计划执行 |
| `find-skills` | 发现和安装 Skills |
| `guizang-ppt-skill` | 横向翻页网页 PPT 生成 |
| `in-app-browser` | 内嵌浏览器操作 Skill |
| `lark-delivery` | 飞书/Lark 交付与推送 |
| `pdf` | PDF 文档处理 |
| `pptx` | PowerPoint 演示文稿 |
| `profer-coach` | CDUT Studio 使用顾问，优化工作流 |
| `session-cleaner` | 会话 JSONL 清洗为 Markdown |
| `skill-creator` | Skill 创建/编辑/评估 |
| `tool-builder` | 自定义 HTTP 工具管理 |
| `user-sense` | 用户感知/人设与语气适配 |
| `writing-plans` | 多步骤任务实施计划 |
| `xlsx` | 电子表格处理 |

---

## 8. 构建工具

- **主进程/Preload**：esbuild（`--bundle --platform=node --format=cjs --external:electron --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai`）
- **渲染进程**：Vite + React + Tailwind CSS + HMR
- **开发热重载**：渲染进程通过 Vite HMR 即时生效；主进程/Preload 持续 watch 构建到 dist，但默认不自动重启 Electron，避免窗口反复抢焦点。修改 main/preload 后手动重启开发版。
- **打包分发**：electron-builder（配置见 `electron-builder.yml`）

### 8.1 重要：Pi 内核打包配置注意事项

**Pi 内核打包要求（必须遵守）：**
- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 必须使用 `--external` 参数排除在 esbuild 打包之外（`electron` 同样 external）。
- 内核依赖在 **根 `package.json` 的 `overrides` 中锁定为 `0.86.1`**，并在 `patchedDependencies` 中为 `pi-ai@0.86.1`、`pi-coding-agent@0.86.1` 指定补丁文件（`patches/`）。**升级 Pi 版本时必须同步评估补丁 rebase 与 native addon 兼容性。**
- 打包前必须执行 `bun run sync:runtime-deps`，将依赖闭包同步到 appDir 下的 `node_modules`，避免 Bun workspace hoist 后丢失。
- Pi 运行闭包中的 WASM / native addon 必须在 `asarUnpack` 中解包，避免 packaged runtime 从 ASAR 加载失败：
  ```yaml
  asarUnpack:
    - "node_modules/@anthropic-ai/**"
    - "node_modules/@silvia-odwyer/**"
    - "node_modules/@mariozechner/**"
    - "node_modules/@napi-rs/**"
    - "node_modules/@earendil-works/pi-tui/native/**"
  ```
- `electron-builder.yml` 的 `files` 保留 Pi 内核与 `@anthropic-ai/sdk` 等运行时依赖及其 native addon，排除构建期大依赖：
  ```yaml
  files:
    - dist/**/*
    - "!dist/resources/**"
    - package.json
    - node_modules/**/*
    - "!node_modules/electron/**"
    - "!node_modules/electron-builder/**"
    - "!node_modules/electronmon/**"
    - "!node_modules/esbuild/**"
    - "!node_modules/@electron/**"
    - "!node_modules/@electron-builder/**"
    - "!node_modules/@esbuild/**"
    - "!node_modules/@earendil-works/*/examples/**"
    - "!node_modules/@earendil-works/*/docs/**"
    - "!node_modules/**/*.map"
    - "!node_modules/@proma/**"      # 过时前缀，代码待修（见第 15 节）
  ```
- **运行时校验**：`bun run verify:packaged-pi-runtime`（PowerShell 脚本）在打包后校验 Pi 运行时闭包完整。

**跨平台打包限制：**
- 正式稳定发布默认仍只发布 Windows x64；Linux 正式签名发布暂未接入。
- macOS 具备 `macos-14` Apple Silicon (`darwin-arm64`) 的手动验收 workflow：`.github/workflows/macos-package.yml`。它只跑便携测试、typecheck、Mac 构建与包验证，并上传 Actions Artifact；不自动创建 Release。
- macOS 当前仅支持无签名、无公证的 arm64 验收包。只有用户明确要求时，才可将该 Artifact 作为测试版资产加入 GitHub Pre-release；不能把它当作正式稳定 Mac 发布。
- macOS 正式签名/公证发布仍未接入。Apple Silicon runner 不会构建 darwin-x64；Intel 需要 x64 runner 单独构建。
- Windows 专属的 PowerShell/注册表 PATH/打包校验只在 Windows 主机执行；不要在 macOS shell 中执行 Windows 命令。

**修改打包配置时的检查清单：**
1. ✅ 确认 Pi 内核三个包在 esbuild 中使用 `--external`
2. ✅ 确认根 `overrides` 版本锁定与 `patchedDependencies` 补丁到位
3. ✅ 确认 Pi native/WASM addon 在 `asarUnpack` 中解包
4. ✅ `bun install` 后确认 `@earendil-works/*` 链接到 `apps/electron/node_modules/`
5. ✅ 打包前执行 `bun run sync:runtime-deps`，打包后执行 `bun run verify:packaged-pi-runtime`
6. ✅ 本地测试打包后的应用 Agent 功能

### 8.2 Pi 内核版本升级注意事项

- **版本锁定是强约束**：Pi 四个包（`pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui`）被根 `overrides` 统一钉死在 `0.86.1`。**只升级其中一个包会导致版本错配、运行时崩溃**；升级必须四者同步。
- **补丁维护**：`pi-ai@0.86.1` 与 `pi-coding-agent@0.86.1` 带有本地补丁。升级前需检查补丁是否仍适用，必要时 rebase，否则 `bun install` 会因补丁应用失败而中断。
- **原生依赖**：`pi-tui/native/**` 含 native addon，升级大版本需重新验证 `asarUnpack` 与跨平台二进制可用性。
- **适配层回归**：`main/lib/adapters/pi-*` 与 `main/lib/pi-harness/` 是针对 Pi 运行时行为的适配与治理层。升级后必须跑通 Pi 相关测试（`pi-*.test.ts`、`pi-harness/**`）与 `verify:packaged-pi-runtime`。
- 升级到重大版本时，优先查阅 `@earendil-works/pi-coding-agent` 的变更说明，并评估 `pi-resource-loader-overrides.ts`、`pi-prompt-chain.ts` 等覆盖点是否仍成立。

---

## 9. 代码风格

- 永远不要使用 `any` 类型 — 创建合适的 interface
- 对象类型优先使用 interface 而不是 type
- 尽可能使用 `import type` 进行仅类型导入
- 注释和日志采用中文，保留专业术语
- **路径别名**：`@/` → `apps/electron/src/renderer/`

## 10. TypeScript 配置

- Module: `"Preserve"` + `"moduleResolution": "bundler"`
- JSX: `"react-jsx"`，严格模式启用，Target: ESNext
- 所有包 `"type": "module"`，导入时使用 `.ts` 扩展名

---

## 11. 版本管理与发版

提交代码时始终递增受影响包的 patch 版本（如 `0.1.18` → `0.1.19`），影响多个包则都要递增。

### 默认 Skills 版本契约（`apps/electron/default-skills/`）

修改任何 `default-skills/<skill>/` 内容时，**必须同步递增该 Skill `SKILL.md` frontmatter 的 `version` 字段**（patch +1）。

**为什么**：`seedDefaultSkills()` 通过 semver 比较决定是否将 bundle 中的 Skill 同步到老用户的 `~/.cdutai/default-skills/`（全局元 skill 库）。**version 不变 = `seedDefaultSkills` 不会用新版覆盖全局库**。

> `upgradeDefaultSkillsInWorkspaces()` 语义已收窄：**只做「缺失即注入」**，不再对已存在的工作区 skill 做基于 version 的全量覆盖。工作区已装 skill 的更新改由「全局元 Skill → 手动同步」机制掌控（见下）。

### 全局元 Skill（master）与工作区同步

- **全局元 Skill 库** = `~/.cdutai/default-skills/{slug}/`，是唯一编辑源，用户可编辑、有版本历史、可回退。
- 历史快照：`~/.cdutai/default-skills-history/{slug}/v{n}/`（v1 为出厂基线/首次保存），版本索引 `index.json`。
- 保存即 bump：`skill-master-manager.ts:saveMasterSkill` 自动把 frontmatter `version` patch+1 并落盘一条快照；`rollbackMasterSkill` 回退并保留一条新回退记录。
- **工作区同步**：`syncMasterSkillToWorkspace` 手动把元 skill 覆盖到选定个人工作区 `skills/{slug}`，写 `.source.json`（`sourceKind:'master'` + baseline 内容哈希）。
- **冲突检测**：基于内容哈希（`detectSkillConflict`），工作区副本相对上次同步基线被改过即视为冲突；非强制同步会拒绝覆盖，由 UI 让用户选择「覆盖/跳过」。
- UI 入口：Agent 技能视图「元 Skill」tab（编辑/版本回退/同步到工作区），`MasterSkillsTab.tsx` / `MasterSkillDetailSheet.tsx` / `SyncMasterSkillDialog.tsx`。
- 团队市场与跨工作区导入逻辑不受影响；master 同步只作用于个人工作区本地 skills。

> 早期实现曾用"无条件 cpSync"绕开 seed 约束，但每次启动同步 4MB+ 文件会阻塞主进程导致启动卡顿，已恢复为 semver 比较（见 `config-paths.ts:seedDefaultSkills`）。

### 发版流程（本地唯一发布者）

正式 Windows 发版由本地 `scripts/push-release.cjs` 单独完成：构建一次签名 Windows x64 安装包、上传国内更新源、推送源码/tag、创建或补齐 GitHub Release。`release.yml` 为仅手动触发的构建验证，绝不因 tag 自动构建或写入 GitHub Release，避免双重构建和两个发布者竞争同一 Release。

macOS arm64 目前走独立的手动验收流程：先运行 `.github/workflows/macos-package.yml`，成功后可在用户明确确认的前提下，把同一 Actions Artifact 中的 DMG/ZIP 作为测试资产加入对应 GitHub Pre-release。它不进入 Windows 国内更新源。无签名 Windows 测试包若需同步国内源，也只能走明确确认的临时测试流程，不能调用正式 `push-release.cjs`，不能伪造 `latest.yml.sig`：

```bash
# 1) 先提交 package.json、CHANGELOG.json 和本次客户端代码；工作树必须干净
# 2) 本地构建一次并发布两个通道（GitHub 登录或 GITHUB_TOKEN 需有效）
node scripts/push-release.cjs X.Y.Z
# 脚本不 rebase、不强推 tag；远端 main 或同名 tag 不一致会明确失败。
```

> 注意：tag 与 package.json/CHANGELOG 首条版本必须一致。GitHub API 503 时脚本会有限重试，并在每次上传后按资产名、大小与 `uploaded` 状态收敛验证。

两个构建目标编译时注入 `__PROFER_BUILD_TARGET__`（`oss` / `commercial`），互不串扰。

**新增 Skill 不需要先注入 default-skills 目录的旧版本**——`upgradeDefaultSkillsInWorkspaces` 会通过"目标缺失即注入"路径让所有老工作区自动获得。

---

## 12. 创作参考

- **会话管理**：收件箱/归档工作流；多标签（tab/tab-group）与面板布局
- **权限模式**：safe / ask / allow-all
- **执行内核**：Pi Coding Agent（`@earendil-works/pi-coding-agent`）
- **MCP 集成**：Model Context Protocol 用于外部数据源
- **凭证存储**：AES-256-GCM 加密
- **配置位置**：`~/.cdutai/`

## 13. 核心特性

### 已实现功能

- ✅ **多 Provider 支持**：Anthropic、OpenAI（Chat Completions / Responses）、xAI、DeepSeek、Kimi、智谱、MiniMax、Ollama、豆包、通义千问、小米、Google、自定义端点
- ✅ **Pi 内核集成**：以 `@earendil-works/pi-*` 为唯一执行内核，适配层与 Harness 治理
- ✅ **飞书/钉钉集成**：消息同步、任务通知、卡片渲染、OAuth 认证
- ✅ **工作区管理**：多工作区隔离、MCP Server 配置、Agent Skills 管理、默认沙箱工作区
- ✅ **权限系统**：工具权限检查、用户确认流程
- ✅ **Automation 定时任务**：持久化调度、运行历史、手动运行、失败保护、飞书通知
- ✅ **Goal / Planning**：目标运行时、项目图、规划工作台
- ✅ **记忆系统**：跨会话记忆存储与检索
- ✅ **自动更新**：Electron Updater 集成
- ✅ **代理支持**：系统代理检测与配置
- ✅ **内嵌浏览器**：CDP 控制、策略、截图与会话
- ✅ **文档解析**：PDF、Office、文本文件提取
- ✅ **多模态支持**：图片、文档附件
- ✅ **内容审核专区**：三栏审核工作台（依据/待审/审核）、领域包可切换（综测/合同/报销/自定义）、问题卡三栏联动定位高亮、跨文档比对、AI/确定性引擎双路径、预审报告导出

### 架构亮点

- **并发守卫**：同一会话防止并行请求冲突
- **全局监听**：Agent IPC 监听器永不销毁，确保后台会话不丢失
- **权限排队**：按 sessionId 隔离权限请求，支持多会话并行
- **文件监听**：工作区文件与 MCP 配置实时监控
- **事件流处理**：内核消息流式转换与累积
- **错误映射**：内核错误统一转换为应用错误

---

## 14. 当前裁剪状态

Chat 用户模式、团队工作区 UI、积分计费 UI、远程机器人、移动端远程接入、语音输入、快速任务窗口与第三方插件宿主已从产品入口/实现裁剪中移除。远程接入、团队/同步相关 main 服务仍有规划与数据兼容调用方，后续需单独评估后再决定是否删除。