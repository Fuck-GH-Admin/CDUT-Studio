/**
 * T09 离线包 Main 桥接（Local-L04）。
 *
 * 职责边界（计划 §5 T09）：
 * - 签发：Main 用真实 CaseAggregate 生成任务包并落盘；包内的 recipient 是
 *   **声明**，不是登录身份，不能据此获得校方权限。
 * - 导入：先校验（哈希/锁定/版本/收件人），附件**先登记为真实 DocumentVersion**，
 *   再作为 T05 补件答复原子写入；`actionId` 幂等，重复导入返回既有回执。
 * - 不重写 T09 编解码：全部复用 `review-v3-t09-offline-codec` 的既有纯函数。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigDir } from '../config-paths'
import { assertSafeReviewStorageId } from './review-storage-id'
import {
  importT09Reply, previewT09Reply, readT09File, unpackT09Asset,
  type T09Preview, type T09Receipt, type T09ReplyPackage, type T09State, type T09TaskPackage,
} from './review-v3-t09-offline-codec'
import { issueT09StudentFromCase } from './review-v3-t09-offline-issuer'
import type { CaseAggregateV2, TemplateVersion } from '@profer/shared'

/**
 * Public fields are a Main-only decision, never a renderer-supplied permission.
 * Reject nonpublished/mismatched templates rather than trusting stale policy.
 */
export function t09PublishedStudentVisibility(
  aggregate: CaseAggregateV2, template: TemplateVersion | undefined,
): Record<string, 'public' | 'internal'> {
  if (!template || template.status !== 'published' ||
      template.templateId !== aggregate.caseV2.templateId ||
      template.version !== aggregate.caseV2.templateVersion) {
    throw new Error('T09_PUBLIC_TEMPLATE_NOT_PUBLISHED')
  }
  const visibility: Record<string, 'public' | 'internal'> = {}
  for (const field of template.fields) {
    visibility[field.key] = field.visibility === 'public' ? 'public' : 'internal'
  }
  return visibility
}

function offlineDir(caseId: string): string {
  assertSafeReviewStorageId(caseId, 'caseId')
  return join(getConfigDir(), 'review-offline', caseId)
}

function writeAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 已签发任务包：按 packageId 保存，供回件校验原任务。 */
export function saveT09TaskPackage(caseId: string, pkg: T09TaskPackage): void {
  const dir = join(offlineDir(caseId), 'tasks')
  ensureDir(dir)
  writeAtomic(join(dir, `${pkg.packageId}.json`), pkg)
}

export function readT09TaskPackage(caseId: string, packageId: string): T09TaskPackage | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(packageId)) return undefined
  const filePath = join(offlineDir(caseId), 'tasks', `${packageId}.json`)
  if (!existsSync(filePath)) return undefined
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T09TaskPackage
}

/** 回执按 actionId 幂等保存。 */
function receiptsPath(caseId: string): string {
  return join(offlineDir(caseId), 'receipts.json')
}

export function readT09Receipt(caseId: string, actionId: string): T09Receipt | undefined {
  const filePath = receiptsPath(caseId)
  if (!existsSync(filePath)) return undefined
  try {
    const all = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, T09Receipt>
    return all[actionId]
  } catch { return undefined }
}

export function saveT09Receipt(caseId: string, receipt: T09Receipt): void {
  const filePath = receiptsPath(caseId)
  const all = existsSync(filePath)
    ? (() => { try { return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, T09Receipt> } catch { return {} } })()
    : {}
  all[receipt.actionId] = receipt
  writeAtomic(filePath, all)
}

/**
 * 学生回件的 staging 账本（OFF-01/03）。
 *
 * 为什么需要它：附件登记与补件答复是两个独立 Case CAS，外层 receipts.json 又是
 * 第三次写盘。没有 staging 时，第 N 份附件失败、补件成功后回执写盘前崩溃，都会
 * 让“哪份附件属于哪次离线答复、该回件是否已应用”失去唯一锚点。
 *
 * 约束：
 * - 以 actionId 为键，requestHash 绑定载荷，载荷漂移直接拒绝；
 * - 每登记一份附件就落盘，崩溃后重试复用已登记 versionId，不再复制材料；
 * - 业务写入前记 `applying`，成功后才记 `applied`；`applied` 即使 receipts.json
 *   丢失也能恢复出原回执（不重复答复）；
 * - `applying` 且无法核验时返回“待核验”，绝不静默重复写。
 */
export interface T09StagedAsset {
  name: string
  mimeType: string
  sha256: string
  versionId: string
}

export interface T09StagingRecord {
  actionId: string
  caseId: string
  requestHash: string
  supplementId: string
  baseRevision: number
  status: 'staged' | 'applying' | 'applied'
  assets: T09StagedAsset[]
  appliedRevision?: number
  updatedAt: string
}

function stagingDir(caseId: string): string {
  return join(offlineDir(caseId), 'staging')
}

export function readT09Staging(caseId: string, actionId: string): T09StagingRecord | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(actionId)) return undefined
  const filePath = join(stagingDir(caseId), `${actionId}.json`)
  if (!existsSync(filePath)) return undefined
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as T09StagingRecord } catch { return undefined }
}

function saveT09Staging(caseId: string, record: T09StagingRecord): void {
  ensureDir(stagingDir(caseId))
  writeAtomic(join(stagingDir(caseId), `${record.actionId}.json`), { ...record, updatedAt: new Date().toISOString() })
}

/** 由 staging 的 applied 记录重建回执：这是 receipts.json 丢失后的恢复锚点。 */
function stagingReceipt(caseId: string, actionId: string): T09Receipt | undefined {
  const staged = readT09Staging(caseId, actionId)
  if (!staged || staged.status !== 'applied') return undefined
  return { actionId, hash: staged.requestHash, caseId: staged.caseId, status: 'accepted', newRevision: staged.appliedRevision }
}

/** 由真实案卷构造离线校验状态（不含任何虚构身份）。 */
export function buildT09State(aggregate: import('@profer/shared').CaseAggregateV2): T09State {
  const supplements: T09State['supplements'] = {}
  for (const request of aggregate.supplements ?? []) {
    supplements[request.id] = (request.status ?? 'open') as T09State['supplements'][string]
  }
  return {
    caseId: aggregate.caseV2.id,
    revision: aggregate.caseV2.revision,
    lock: {
      templateId: aggregate.caseV2.templateId,
      templateVersion: aggregate.caseV2.templateVersion,
      // 显式空数组：packages 里的 lock 用 canonical 比较，undefined 与 [] 不等
      policyVersionIds: [],
    },
    supplements,
    assignments: {},
  }
}

export interface T09IssueResult {
  packageId: string
  actionId: string
  /** 可直接交给离线编辑器的 JSON 文本 */
  json: string
}

/** 签发学生应答包（补件场景）。 */
export function issueT09StudentPackage(input: {
  aggregate: import('@profer/shared').CaseAggregateV2
  supplementId: string
  recipientId: string
  fieldVisibility?: Record<string, 'public' | 'internal'>
}): T09IssueResult {
  const pkg = issueT09StudentFromCase(
    input.aggregate,
    input.recipientId,
    input.supplementId,
    input.fieldVisibility ?? {},
    [],
  )
  saveT09TaskPackage(input.aggregate.caseV2.id, pkg)
  return { packageId: pkg.packageId, actionId: pkg.actionId, json: JSON.stringify(pkg, null, 2) }
}

/** 预览回件：只做校验，不写任何业务状态。 */
export function previewT09Package(input: {
  aggregate: import('@profer/shared').CaseAggregateV2
  packageJson: string
}): { preview: T09Preview; task?: T09TaskPackage } {
  const parsed = readT09File(input.packageJson)
  if (parsed.type !== 'reply') throw new Error('T09_NOT_A_REPLY_PACKAGE')
  const task = readT09TaskPackage(input.aggregate.caseV2.id, parsed.requestPackageId)
  if (!task) throw new Error('T09_TASK_PACKAGE_NOT_FOUND')
  return { preview: previewT09Reply(parsed, task, buildT09State(input.aggregate)), task }
}

export interface T09ImportDeps {
  readAggregate: (caseId: string) => import('@profer/shared').CaseAggregateV2 | undefined
  /**
   * 把附件字节登记为真实 DocumentVersion，返回 versionId。
   * meta 只用于归属：actionId 让原件可回溯到这次离线答复，displayName 是
   * 用户原始文件名（不得被临时文件 UUID 前缀替代）。
   */
  registerAsset: (caseId: string, name: string, mimeType: string, bytes: Uint8Array,
    meta?: { actionId: string; index: number; displayName: string }) => Promise<string>
  /** 原子答复补件；expectedRevision 必须是预览确认过的版本，不得换成“最新”。 */
  respondSupplement: (caseId: string, supplementId: string, note: string,
    documentVersionIds: string[], expectedRevision: number,
    meta?: { actionId: string }) => Promise<{ ok: boolean; message?: string }>
  /**
   * 可选：崩溃恢复时核验该 actionId 是否已经真正写入补件答复。
   * 未提供时，处于 applying 的导入返回“待核验”，既不重复写也不假装成功。
   */
  verifyApplied?: (input: { caseId: string; supplementId: string; actionId: string; requestHash: string })
    => { applied: boolean; revision?: number } | undefined
}

/**
 * 导入回件：幂等 + 附件先登记为原件 + 再原子答复补件 + staging 恢复锚点。
 *
 * 顺序不可颠倒：附件未成为 DocumentVersion 之前，补件答复不得写入，
 * 否则补件会声称「已有新材料」而案卷里查不到。
 *
 * 事务边界（OFF-01/02/03）：
 * 1. 预览确认的 revision 在真正写入前重新比对；案卷已前进则拒绝，绝不悄悄
 *    改用最新 revision 提交；
 * 2. 附件按 actionId 记入 staging，重试复用已登记 versionId，不重复登记副本；
 * 3. 业务成功后才把 staging 标为 applied；receipts.json 丢失时据此恢复 duplicate；
 * 4. 失败保留 staged，成功/失败后都清理过期的临时落盘文件。
 */
export async function importT09Package(input: {
  caseId: string
  packageJson: string
  deps: T09ImportDeps
}): Promise<{ status: 'accepted' | 'duplicate'; receipt: T09Receipt } | { status: 'conflict' | 'rejected'; preview: T09Preview }> {
  const aggregate = input.deps.readAggregate(input.caseId)
  if (!aggregate) throw new Error('T09_CASE_NOT_FOUND')
  const parsed = readT09File(input.packageJson)
  if (parsed.type !== 'reply') throw new Error('T09_NOT_A_REPLY_PACKAGE')
  const task = readT09TaskPackage(input.caseId, parsed.requestPackageId)
  if (!task) throw new Error('T09_TASK_PACKAGE_NOT_FOUND')

  const state = buildT09State(aggregate)
  const outcome = await importT09Reply(
    parsed,
    task,
    state,
    async (actionId) => readT09Receipt(input.caseId, actionId) ?? stagingReceipt(input.caseId, actionId),
    async (reply: T09ReplyPackage, expectedRevision: number) => {
      if (reply.reply.kind !== 'student-reply') {
        return { actionId: reply.actionId, hash: reply.hash, caseId: reply.caseId,
          status: 'rejected', message: '评委评分包尚未接入本地评分写入' } as T09Receipt
      }
      const reject = (message: string): T09Receipt => ({ actionId: reply.actionId, hash: reply.hash,
        caseId: reply.caseId, status: 'rejected', message })

      // OFF-02：预览确认的 revision 必须仍是当前版本；否则要求重新预览，绝不换新版本提交。
      const live = input.deps.readAggregate(reply.caseId)
      if (!live) throw new Error('T09_CASE_NOT_FOUND')
      if (live.caseV2.revision !== expectedRevision) {
        return reject(`T09_REVISION_CHANGED: 预览版本 ${expectedRevision} 已变为 ${live.caseV2.revision}，请重新预览后再导入`)
      }

      const existing = readT09Staging(input.caseId, reply.actionId)
      if (existing && existing.requestHash !== reply.hash) {
        return reject('T09_ACTION_PAYLOAD_DRIFT: 相同 actionId 的载荷与首次导入不一致')
      }
      if (existing?.status === 'applied') {
        // 双保险：lookup 已处理，这里防止竞态重复进入。
        return { actionId: reply.actionId, hash: reply.hash, caseId: reply.caseId,
          status: 'accepted', newRevision: existing.appliedRevision } as T09Receipt
      }
      if (existing?.status === 'applying') {
        const verified = input.deps.verifyApplied?.({
          caseId: reply.caseId, supplementId: reply.reply.supplementId,
          actionId: reply.actionId, requestHash: reply.hash,
        })
        if (!verified) {
          return reject('T09_RECOVERY_UNCERTAIN: 上次导入在业务写入中断，需先核验补件答复是否已生效')
        }
        if (verified.applied) {
          saveT09Staging(input.caseId, { ...existing, status: 'applied', appliedRevision: verified.revision })
          return { actionId: reply.actionId, hash: reply.hash, caseId: reply.caseId,
            status: 'accepted', newRevision: verified.revision } as T09Receipt
        }
      }

      const staged: T09StagingRecord = existing ?? {
        actionId: reply.actionId, caseId: reply.caseId, requestHash: reply.hash,
        supplementId: reply.reply.supplementId, baseRevision: expectedRevision,
        status: 'staged', assets: [], updatedAt: new Date().toISOString(),
      }

      // 1) 附件先成为真实 DocumentVersion；已登记的同名同哈希附件直接复用。
      const versionIds: string[] = []
      for (const [index, asset] of reply.reply.assets.entries()) {
        const prior = staged.assets.find((item) => item.sha256 === asset.sha256 && item.name === asset.name)
        if (prior) { versionIds.push(prior.versionId); continue }
        const bytes = unpackT09Asset(asset)
        const versionId = await input.deps.registerAsset(reply.caseId, asset.name, asset.mimeType, bytes,
          { actionId: reply.actionId, index, displayName: asset.name })
        staged.assets.push({ name: asset.name, mimeType: asset.mimeType, sha256: asset.sha256, versionId })
        saveT09Staging(input.caseId, staged)
        versionIds.push(versionId)
      }

      // 2) 记下“正在写入”，再执行补件 CAS；成功前不得对外宣称已应用。
      staged.status = 'applying'
      saveT09Staging(input.caseId, staged)
      const written = await input.deps.respondSupplement(
        reply.caseId, reply.reply.supplementId, reply.reply.note, versionIds, expectedRevision,
        { actionId: reply.actionId },
      )
      if (!written.ok) {
        // 保留 staged（含已登记 versionId），重试不再复制材料。
        saveT09Staging(input.caseId, { ...staged, status: 'staged' })
        return reject(written.message ?? '补件答复写入失败')
      }
      const current = input.deps.readAggregate(reply.caseId)
      const appliedRevision = current?.caseV2.revision
      saveT09Staging(input.caseId, { ...staged, status: 'applied', appliedRevision })
      return {
        actionId: reply.actionId, hash: reply.hash, caseId: reply.caseId,
        status: 'accepted', newRevision: appliedRevision,
      } as T09Receipt
    },
  )
  // 无论成败都回收过期临时文件；成功路径同样清理（OFF-06）。
  try { pruneT09AssetTempRoot() } catch { /* 清理失败不影响业务结果 */ }
  if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
    saveT09Receipt(input.caseId, outcome.receipt)
    return outcome
  }
  return outcome
}

/** 临时落盘目录（附件登记需要真实路径）。 */
export function t09AssetTempRoot(): string {
  const dir = join(tmpdir(), 'cdut-review-t09')
  ensureDir(dir)
  return dir
}

/**
 * 回收过期临时附件（OFF-06）。
 *
 * 原件已由材料服务复制进权威存储，临时文件只是导入中转。只删除超过 maxAgeMs
 * 的文件，避免误删并发导入正在读取的中转文件；长期残留因此有上界。
 * 逐文件的即时删除仍需 IPC 在 finally 中调用（见 handoffs/offline-IPC-REQUEST.md）。
 */
export function pruneT09AssetTempRoot(maxAgeMs = 60_000): number {
  const dir = join(tmpdir(), 'cdut-review-t09')
  if (!existsSync(dir)) return 0
  const now = Date.now()
  let removed = 0
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry)
    try {
      const info = statSync(filePath)
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) { unlinkSync(filePath); removed += 1 }
    } catch { /* 并发删除或权限问题：跳过 */ }
  }
  return removed
}
