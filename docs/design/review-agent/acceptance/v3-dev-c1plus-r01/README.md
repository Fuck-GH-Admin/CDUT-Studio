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


## C1-R06 native-first workbench engineering checkpoint (2026-10-19)

**Exact production checkpoint before this docs update:** `21f4927e93eed9c39e8e15c75ff67415ecbe1d11`. **C1_PARTIAL / Gate O NOT_ATTESTED / Release NO-GO**. This is real C-owned code and tests on Draft #144, not a specification-only phase. No C0 `review-c0/1` semantic change, no I/A/B file delegation, no second Case writer.

### Real modified entry chain

1. New `native-workspace-case-v3.ts` is C's native-first `CREATE_CASE` implementation. Main-generated random case ID + original local Actor → exactly one `state.v2.json` with `CreateNativeWorkspaceCaseV3` Receipt at revision 0; **no `case.json` and no `case.v2.json`**. Main sender/frame revalidates inside the serialized `createAggregate` commit. The old Renderer `CREATE_CASE` API shape is preserved.
2. `case-store.ts::getCase/listCases` derive an **in-memory, read-only** V1-shaped view from native `CaseAggregateV2`, without creating or mutating a V1 file. Native identity must match the requested directory; invalid/cross-ID state remains hidden. `MIGRATE_CASE_V2` returns the native aggregate instead of creating a migration shadow. `ensureWorkspaceAggregateV2` returns existing native state without a legacy projection write. Previously migrated genuine V1 cases still use the legacy compatibility branch, and a stale V1 shadow cannot overwrite a native Case.
3. `UPDATE_CASE_SETTINGS` detects genuine native origin and redirects basic title/type/domain/template intents to one C-owned `submitCommand` CAS+Receipt. Bound `CanonicalPlan`/`D2RuntimePlan` cannot be silently replaced; modifying native manual rules or material scope requires future typed business commands. A **candidate/draft/unmapped template remains pending**, never silently published or installed as an official Plan.
4. The existing three-column `IMPORT_DOCUMENT` uses the true invoking Main-window OS picker for native cases and C `registerMaterial` (actual file bytes, SHA256, current DocumentVersion, receipt). Developer-only `IMPORT_DOCUMENT_FROM_PATH` is separately gated by `!app.isPackaged`; it is **not** a production file-capability entitlement. Native remove/reorder use dedicated same-aggregate CAS commands; physical files, old versions and source revocation records remain. All native commands perform a **commit-time revalidation** of the actual Main window/frame after dialog/parser awaits. Old V1-only paths retain their old implementation, no mass deletion/auto-migration.
5. `PICK_REGISTER_MATERIAL_V2` is scoped to the invoking Main window (not `getFocusedWindow`) and rechecks sender after dialog and during `RegisterMaterial`. **Native `REGISTER_MATERIAL_PATH_V2` fails closed with `SOURCE_CAPABILITY_REQUIRED`** because a Renderer-supplied absolute path is not proof of an OS-selected/drop capability. Integrating B2 physical bytes/capability as a trusted Native drop remains unimplemented; don't relabel the rejected legacy text path as authorized. Explicit Main OS picker works, but actual Electron Gate E is still required.
6. The projection does **not** mislabel V2-only `attachment` materials as evidence or invent AI-extracted subjects/validated policy checks. Current three-column legacy rule generation/AI item edits/export still contain V1 mutator dependencies and are **not declared complete or silently faked**. Native-only restore is again selectable through the read-only view. Full C1 requires converting those remaining commands to typed V2 writers with authorized Plan/Source scope.

### Exact test files and proofs to obtain

- `review-v3-legacy-entry-gates.test.ts`: actual Main handler native create, no V1 shadow, no duplicate migration, native basic settings, archive/restore round-trip, trusted sender/frame negatives; development-only physical text original into V2 material, two-source reordering/retirement, source validity revocation; unsealed Renderer path and spoof negatives; malformed V2 summary isolation.
- `native-workspace-case-v3.test.ts`: native Case creation/reopen/read-only projection, V1 low-level write rejection, deliberate Main revoke precisely at native create/settings/material/remove commit, authentic physical bytes, custom unbound template does **not** become published policy.
- `review-actions-controller.test.ts`: native-only restore refreshes selected three-column Case through V2-derived read projection, not a V1 ghost.
- `case-lifecycle-v3.test.ts` and earlier legacy Main tests: archive/reopen/re-archive idempotency and historical receipt preservation.
- Required targeted Gate O first: `bun run typecheck`; `bun run check:boundaries`; `bun test --isolate apps/electron/src/main/lib/review/native-workspace-case-v3.test.ts apps/electron/src/main/lib/review/review-v3-legacy-entry-gates.test.ts apps/electron/src/main/lib/review/case-lifecycle-v3.test.ts apps/electron/src/renderer/components/content-review/review-actions-controller.test.ts`; then full `bun test --isolate --timeout 30000`, Main/Preload/Renderer builds and standard workflows. Capture exact checkout SHA, exit code, first failure and rollback; do not claim a PASS from queued CI or old source.

### Explicit still-open hard problems

- C1 native-only three-column **write-complete** RulePack/AI item/evidence/report integration, credible source/subject projection, native trusted drag capability, full material attachment role, explicit Plan publisher/provenance, all old mutator transformations.
- Native create request/reply lost-response recovery and ImportBatch cross-call durable idempotency; `randomUUID` prevents Case ID collision but does **not** prove same user request dedup after crash.
- Multi-PID Case/Run/Host/physical-copy atomicity, ENOSPC recoverable intent, durable OS capability after await (C-Tx/C4); physical asset may remain if aggregate write fails. A/B/I technical proposals are not C durable Run/Decision ACK.
- Full native Electron/picker/parser/Office and user workflow Gate E not run; school/Gold/Provider Gate L blocked without authorization; 71 product gates and 7 journeys not accepted. Separate safe staging/read-only preview from formal InstallPlan/ReviewRun release.

**Rollback:** reverse C1-R06 #144 commits using normal Git revert on an isolated C branch, keep all live state.v2.json/receipts/material assets intact; do not run V1-first replay over cases with a native origin Receipt. Reversion of a code feature is not permission to down-migrate existing native business state.
