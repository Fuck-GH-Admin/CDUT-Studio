# CI 修复记录：Bun lockfile v2 解析失败（2026-10-05）

## 现象

PR CI `verify (ubuntu-latest)` 在 **Install dependencies** 步骤 0s 即失败：

```
bun install v1.3.14 (0d9b296a)
2 |   "lockfileVersion": 2,
    ^
error: Unknown lockfile version
    at bun.lock:2:22
UnknownLockfileVersion: failed to parse lockfile: 'bun.lock'
warn: Ignoring lockfile
error: lockfile had changes, but lockfile is frozen
Error: Process completed with exit code 1.
```

后续 Typecheck / Boundaries / Build / Tests 全部 0s 跳过。

## 根因

- 仓库 `bun.lock` 由本地 **Bun 1.4.0** 生成，为 `lockfileVersion: 2` 的文本格式（Bun 1.4 引入）
- CI 三个 workflow（`ci.yml` / `macos-package.yml` / `release.yml`）用 `oven-sh/setup-bun` 固定 **bun-version: 1.3.14**，该版本不认识 v2 lockfile
- `--frozen-lockfile` 下 Bun 选择"Ignoring lockfile"再发现 lockfile 有变化 → 按冻结约定退出 1

## 修复

三个 workflow 的 `bun-version: 1.3.14` → **1.4.0**（与本地生成 lockfile 的版本一致），提交 77122afd。

## 验证

- 本地同版本 `bun install --frozen-lockfile` 退出 0
- 手动 `workflow_dispatch` 触发 `ci.yml`（run 37256159419，sha 77122afd）：**verify (ubuntu-latest) → success**（Install dependencies / Typecheck / Boundaries / Build / 全量测试全部执行通过）

## 后续

- PR #7 上的 pull_request 触发会在下一次 push 后自然带新检查；本修复已由 dispatch run 证明有效
- 提醒：今后升级本地 Bun 大版本（改变 lockfileVersion）时，三个 workflow 的 bun-version 需同步
