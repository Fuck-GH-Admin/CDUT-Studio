# Review V3 Dev-C C1+ — real development checkpoint / safe handoff

**Track**: V3-DEV-C-C1PLUS-R01 · **implementation status**: C1 PARTIAL; C2–C5 NOT STARTED · **Release**: NO-GO  
**Repository**: `Fuck-GH-Admin/cdut-studio-review-agent`  
**Parent**: [C0 Draft PR #141](https://github.com/Fuck-GH-Admin/cdut-studio-review-agent/pull/141), **exact immutable base** `5682057c7232c914e72fdae525ce95fd33f32b53`; C0 contract `review-c0/1`.  
**Branch**: `feat/v3-dev-c-business-r01`; [Draft PR #144](https://github.com/Fuck-GH-Admin/cdut-studio-review-agent/pull/144), **base branch** `feat/v3-dev-c-c0-contract-r01`. This branch is intentionally independent; do not merge main.  
**Design evidence**: Draft #140 `7f954661b3dbca7f0707832c2d097d9c68a965b4`. Audit #133–139 fixed in #140/01; notably #139 L1-01/02/03 synthetic red cases do **not** prove a normal live GUI exploit.  
**Source anchors**: M `8989941b6fb5651564e32d11c4215b6a6d5a5209`; D4 `c2f965d29022a42b3c32d6a4cb73aa8fd542329b`; P06 R03 `db0284879f75ce123b5d83cb6577a3cc7ad057da`; R02 `c23789882aabf18689c314c77c270ac4a8ae4729`; #97 `b68443b23293b4714e61a3b81383d3d3a56434fc`. No whole-branch import.

## Actual C1 production changes committed to Dev-C branch

1. `workspace-service-v2.ts`: native `CaseAggregate` lookup has priority over V1, including a same-ID legacy file; V1 migration receipt distinguishes legacy projection. After a D2/CanonicalPlan bind, V1 projection cannot overwrite frozen Subjects/rules/template. Archive transitions revoke obsolete source validity in same aggregate CAS/Receipt and do not recreate archived links.
2. `source-current-validity-v3.ts` + `review-v2-contracts.ts`: source retirement retains original Observation values/refs/Receipts, records which confirmed facts and links were revoked, demotes current confirmations, and catches stale legacy states at read/decision boundary. Missing source for earlier un-attributed confirmations fails closed after retirement.
3. `material-service.ts`: replacement rejects missing/inactive specified predecessor, deactivates old material and revokes dependent current fact/link in the same case aggregate write; no claim of cross-file/asset atomicity.
4. `run-service-v2.ts`: input hash now includes each material's active flag, so retiring a material invalidates an earlier Run rather than merely altering UI usage.
5. `application-service.ts`: current evidence creation/reconfirmation refuses unknown/archived documents and unknown Subjects, manual SourceRef must match current case/current version; after archive un-attributed fact cannot be unconditionally reconfirmed.
6. `workspace-business-service-v2.ts`: high-level current-Run boundary rejects stale source evidence; frozen CanonicalPlan cases are held from legacy-run formal decision until an authenticated C2 Run writer exists.
7. `material-lifecycle-v3.ts`: a native aggregate ArchiveMaterialVersion typed CAS command (not yet public IPC) with documented reason, exact request replay, historical manualReadReceipt retention and stale evidence rejection.
8. `plan-binding-v3.ts`: explicit internal-only CanonicalPlan initial bind and version upgrade ACK via V2 CAS, records old immutable Plan and receipt. **The Dev-B publisher/provenance verifier is NOT yet integrated**. Test callbacks are synthetic and cannot authorize production template publication.

Tests committed: `source-current-validity-v3.test.ts`, `material-lifecycle-v3.test.ts`, `plan-binding-v3.test.ts`, additions to `workspace-service-v2.test.ts`. **Do not count as PASS until executed on the exact commit.** Major non-C1 legacy paths and IPC write matrix remain outside this patch.

## Trust boundaries / remaining work (in order)

- C1 unfinished: enumerate every V1 `CREATE_CASE` / `case.json` new-case write and transition UI/Main to native C0 command; keep old case.json read-only shadow. Retain V1 user workflows via typed Main intents; finish genuine plan-bound API replace/archive→readiness→decide (with accepted Run), source/ReadReceipt validity and legal new-version re-confirmation; negative/positive tests at business service rather than test-only D2 deletion or synthetic Run.
- C2: one Dev-C ReviewRun writer using Dev-A signed attempt/generation/manifest/sequence/tool receipt events and Dev-B Plan/Source; Check×target/unknown/coverage/read ledger; assert 9-of-9/arithmetics. Never turn graph/direct finish or `run@rev` into approval.
- C3: independent `ReviewBatchAttempt`, exact entry Run+Decision.basedOnRunId and manifest/hash/revision checks at **final persisted write**; normal auto/group/retry and low-level/Main reject cases #139 L1-03, same case dual batch, legacy done without Run blocked.
- C4: durable cross-object commit-intent/journal/recovery with multi-PID fencing; Outbox simulated/provider/external tiers, receipt reconciliation on ambiguous timeout; trusted teacher/gated appeal/ratings and immutable business history; ENOSPC only on isolated fault volume.
- C5: V1 legacy shadow/read-only migration + explicit adoption/tombstone/rollback; one three-column workspace and four distinct technical/business/approval/source-validity states; integrate A/B/C under one SHA, replay 72/20/71, then real Electron/Office/Provider/SchoolPort/Gold distinct gates.
- Absolute prohibitions: no separate current Case/Run/Decision writer, no renderer-provided teacher, no fake SchoolPort ACK, no implicit latestRun for historical batches, no whole `review-ipc.ts` copy or branch merge, no Gold/policy fabrication.

## Exact repeatable verification (run in isolated local clone/worktree)

```bash
git fetch origin feat/v3-dev-c-c0-contract-r01 feat/v3-dev-c-business-r01
git worktree add ../review-v3-dev-c feat/v3-dev-c-business-r01
cd ../review-v3-dev-c
git status --porcelain
git rev-parse HEAD
git worktree list --porcelain
bun install --frozen-lockfile
bun run typecheck
bun run check:boundaries
bun test --isolate apps/electron/src/main/lib/review/source-current-validity-v3.test.ts apps/electron/src/main/lib/review/material-lifecycle-v3.test.ts apps/electron/src/main/lib/review/plan-binding-v3.test.ts apps/electron/src/main/lib/review/workspace-service-v2.test.ts
bun test --isolate apps/electron/src/main/lib/review/case-store-v2.test.ts apps/electron/src/main/lib/review/material-service.test.ts apps/electron/src/main/lib/review/review-c0-ipc.test.ts packages/shared/src/types/review-v3-c0.test.ts
bun test --isolate --timeout 30000
```

Preserve for **this exact head** `stdout/stderr` and exit code per command, SHA256(log), first failure/repro hash, correction commit and persisted data hashes. Remote GitHub connector permits submissions but local Bun and working tree were **NOT_OBSERVABLE** in this execution session; PR CI may validate later. If PR CI fails, treat FAIL, fix and rerun rather than borrowing earlier C0/legacy PASS. If CI passes, it is still only scoped offline Gate O evidence, not Gate E/L/P.

## Files/Owners, interface requests and rollback

C0 `C0-OWNERSHIP-MANIFEST.md` remains the sole cross-track owner. C alone edits `packages/shared`, `review-ipc.ts`, Case/Run/Batch/Decision/Preload/Renderer integration; A/B can only request exact versioned adapters (C0 `C0-ADAPTER-CHANGE-REQUEST.md`), never create parallel write truth. Dev-B must provide a verifiably immutable, published Plan descriptor and SourceIdentity/obligation coverage; Dev-A must provide authorized event envelopes. Contract version bump requires Change Request, bilateral tests and rollback. New `plan-binding-v3.ts` is internal-only and accepts no renderer-origin verification callbacks.

Rollback before deployment: revert the Dev-C PR commits on this dependent branch and return to exact C0 code SHA; do not delete existing receipts/material archives. Do not downgrade migrated data/externally-acknowledged actions automatically. Legacy writes must remain disabled once an old case is adopted as native.

## Required status ledgers

- `72-capability-runtime-status.csv`: 72/72 accounted for, C1 touching select CASE capabilities only as PARTIAL, others NOT_STARTED.
- `20-arch-risk-closure.csv`: 20/20, ARCH-001/002/003 C1 PARTIAL, ARCH-004 C0 partial limited to trusted local Main; rest open.
- `71-original-product-gates.csv`: 71/71 original gates, **none PASS**.
- `07-journey-status.csv`: A–G, B/G PARTIAL and rest NOT_STARTED.

**Gate verdict**: C0 contract `FROZEN_GO` for offline local development ONLY. Dev-C C1 `PARTIAL / NOT_FULLY_VERIFIED`. Integrated Gate O `NOT_RUN` (three-track SHA not assembled). Target Gate E `NOT_RUN`, authorized Gate L `BLOCKED_NO_AUTH`, original product Gate P `NOT_RUN`, Release `NO-GO`.
