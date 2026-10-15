# session-cleaner CLI Reference

This skill is a thin wrapper around the `profer` CLI. This file explains the **underlying format** and **CLI behavior** to maintainers for troubleshooting.
The real parsing logic lives in `@profer/session-core` (the single source of truth in the repo) — do not duplicate it inside the skill.

## Session Storage

```
~/.profer/agent-sessions.json        session index ({ version, sessions: AgentSessionMeta[] })
~/.profer/agent-sessions/<id>.jsonl   per-session messages, JSONL (one JSON object per line)
```

In dev mode (`PROFER_DEV=1` or when Profer is unpackaged) data lives under `~/.profer-dev/`. The CLI switches with `--dev` or `--config-dir`.

## Two Session Formats (auto-detected by the CLI; no need to care)

`readSessionMessages` in `@profer/session-core` normalizes on read, so downstream code does not need to distinguish:

- **Format B (SDK streaming, current default)**: each line is `{ type, message, _createdAt, ... }`. A single assistant turn is split into **multiple complete snapshots** sharing the same `message.id`, with the content array growing incrementally — this is the source of "stitched single characters / repeated segments". core's `toTranscript` picks the most complete snapshot per `message.id` to eliminate redundancy.
- **Format A (legacy flat chat)**: each line is `{ id, role, content: string, createdAt }`. core's `convertLegacyMessage` converts it into an SDKMessage-like shape.

## Cleaning Rules (implemented in core, passed through by the CLI)

| Block type | Handling |
|--------|------|
| `text` | Keep as-is |
| `thinking` | Drop (chain-of-thought does not enter the transcript) |
| `tool_use` | Compressed into `> [工具: name args]`, consecutive identical calls collapsed into `×N` |
| `tool_result` (inside user lines) | Drop (tool replies, not user speech) |
| User lines containing only tool_result | Drop the whole line; not counted as a user turn |

Corrupted lines (truncated JSON) are silently skipped without interrupting.

## Turn Index Stability

`outline` / `search` / `export --turns` share the same 0-based index — i.e. the output order of `groupIntoTurns`. The `index` returned by `search` can be fed directly into `export --turns index-index`.

## Export Guardrail Logic

```
No window specified (--turns/--head/--tail/--offset/--limit) AND rendered bytes > --max-bytes (default 51200)
  → do not write stdout; write to <id>.clean.md and return { guarded: true, written, hint }
Otherwise
  → normal stdout (or write to the path given by --out)
```

`--stdout` forcibly bypasses the guardrail; `--out` explicitly writes to disk and is not subject to the guardrail.

## Exit Codes

- `0` success
- `1` runtime error (session not found, etc.)
- `2` usage error (invalid arguments)

## Relationship with core (maintainer notes)

```
@profer/session-core   parse / snapshot dedup / outline / search / select / render — source of truth
  └─ /node sub-entry    readSessionMessages (file IO, uses node:fs)
apps/cli (profer)      thin command-routing shell, calls core
default-skills/session-cleaner  this skill, teaches the Agent to call the CLI
```

Bug fixes / format changes → change `@profer/session-core`. Neither the CLI nor the skill should contain parsing logic.
