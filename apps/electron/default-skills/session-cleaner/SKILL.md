---
name: session-cleaner
description: 把 Profer 会话 JSONL 清洗为干净可读的 Markdown 对话，并支持对超长会话的渐进式读取（概览 / 大纲 / 搜索 / 按 turn 区间导出），避免一次性全量读撑爆上下文。当用户提到"清洗会话""解析对话文件""提取对话上下文""过滤流式冗余""导出会话 Markdown""把会话转成对话""整理 agent-sessions""看某个会话讲了什么"时使用此技能。
version: 2.0.2
license: AGPL-3.0-only
---

# Session Cleaner

Clean sessions in `~/.profer/agent-sessions/<id>.jsonl` that were polluted by streaming snapshots into clean Markdown conversations.

This skill is a **thin wrapper** around the `profer` CLI: all parsing / snapshot-dedup / rendering logic lives in `@profer/session-core` (the single source of truth inside the repo), exposed through the `profer session` command. The skill itself does not parse JSONL; it only teaches you to call the CLI in the correct order.

> History: v1 shipped its own Python parser (a separately duplicated copy of the session format that drifted with internal format changes). From v2 on it calls the in-repo `profer` CLI, so format knowledge is stored in exactly one place.

## Why Progressive Reading

A session JSONL (会话 JSONL) file can be very large (a single session's raw file has been observed at 50MB in practice). Cleaning it in full and reading it into context at once instantly blows up the token budget. The right approach is **inspect the structure first, then locate, and finally fetch only the needed segments**:

1. `profer session info <id>` — gauge the size: turn count, estimated tokens, byte size. First decide "can this be read in full".
2. `profer session outline <id>` — see the map: one line per turn (role + preview + tool overview + tokens). Locate the turn indexes of interest.
3. `profer session search <keyword> <id>` — find content: returns matched turn indexes + snippets.
4. `profer session export <id> --turns A-B` — export only the needed turn range into context.

**Only when `info` shows the size is small (e.g. estimated tokens < a few thousand) should you read everything with a direct `export <id>`.** The CLI has a built-in guardrail: when no turn range is specified and the output exceeds 50KB, it refuses to print directly, writes to disk instead, and tells you to use `--turns`.

## Command Cheatsheet

```bash
# List sessions (descending by update time)
profer session list [--limit N] [--workspace W]

# Size/structure overview — run this before deciding how to read
profer session info <id|path>

# Turn-level map: one line per turn
profer session outline <id|path> [--offset K] [--limit N]

# Search a keyword within a session; returns matched turn indexes + snippets
profer session search <keyword> <id|path> [--context N] [--limit N] [--case-sensitive]

# Export clean Markdown (windowed)
profer session export <id|path> --turns 5-12       # only turns 5~12
profer session export <id|path> --head 4           # first 4 turns
profer session export <id|path> --tail 4           # last 4 turns
profer session export <id|path> --out cleaned/x.md # write to disk (not subject to the guardrail)
profer session export <id|path> --stdout           # force full output (bypasses the guardrail; use with care)

# All commands support --json for machine-readable output
profer session info <id> --json
```

## Typical Workflows

**Scenario: the user asks "what did we discuss about X in the last session"**

```bash
# 1. Find the session
profer session list --limit 5
# 2. Gauge the size (assume it is large)
profer session info <id>
# 3. Search keywords to locate
profer session search "X" <id>
#    → hits #7 #12
# 4. Export only the neighborhood of the hits
profer session export <id> --turns 6-13
```

**Scenario: the user wants a small session converted to Markdown in full for archiving**

```bash
profer session info <id>          # confirm the size is manageable
profer session export <id> --out cleaned/<id>.clean.md
```

## Output Format

The cleaned Markdown is segmented by role (`## 用户` / `## 助手`), tool calls are compressed into single lines `> [工具: name args]` (consecutive identical calls are collapsed into `×N`), and thinking plus raw `tool_result` content are all dropped:

```markdown
## 用户

帮我配置机器人图标...

## 助手

我来先探索代码库。

> [工具: Read file_path=/a/b.ts]
> [工具: Bash command=ls assets ×3]
```

All user-facing output you author — summaries, explanations, and any commentary accompanying an exported file — must be written in the user's language (e.g., Simplified Chinese when the user writes in Chinese). The literal markers emitted by the cleaner itself (`## 用户` / `## 助手`, `> [工具: ...]`) are part of the fixed output format and stay as-is.

## CLI Location

- **Packaged build (production)**: the `profer` binary ships with the desktop app and should be on PATH or injected by the runtime (see PR4). Prefer calling `profer session ...` directly.
- **Dev/source environment**: if `profer` is not on PATH, run the source directly with `bun <repo>/apps/cli/src/index.ts session ...`.
- **Config directory**: the CLI reads `~/.profer` by default; dev-mode data lives in `~/.profer-dev` — add `--dev` or set `PROFER_DEV=1`.

## Implementation Notes (for maintainers)

- Parsing / snapshot dedup / rendering all live in `@profer/session-core`; the CLI is only command routing. Fix bugs or format changes in core — never add parsing logic inside this skill.
- For format details (streaming-snapshot fragmentation, `message.id` merging, legacy flat-format normalization), see `references/cli-usage.md` and the core package source.
