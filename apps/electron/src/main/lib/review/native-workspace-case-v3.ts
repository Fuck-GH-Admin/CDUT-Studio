/**
 * Dev-C C1: native-first Case creation and READ-ONLY V1 workbench projection.
 * state.v2.json is the sole authority; no case.json or case.v2.json is created.
 * A displayed legacy shape is NEVER a second writer or a published Plan.
 */
import { randomUUID } from 'node:crypto'
import type {
  Actor, CaseAggregateV2, DocumentVersion, ReviewCase, ReviewCaseType,
  ReviewCaseV2, SourceDocument, UpdateCaseSettingsRequest,
} from '@profer/shared'
import { createAggregate, payloadHash, readAggregate, submitCommand, CommandValidationError } from './case-store-v2'
import { mapDomainToTemplate } from './migration'
import { ensureBuiltinTemplateDrafts } from './builtin-templates'
import { getTemplate, saveDraft } from './template-store'
import { registerMaterial } from './material-service'
import { revokeCurrentSourceValidity } from './source-current-validity-v3'
import { resolveDomainPack } from '@profer/shared'

export const NATIVE_CREATE_RECEIPT_V3 = 'CreateNativeWorkspaceCaseV3'
const PENDING_TEMPLATE = 'pending-template-v3'
const MAIN_ACTOR: Actor = { actorId: 'local-reviewer', actorSource: 'local', role: 'reviewer' }
const TYPES: ReadonlySet<string> = new Set(['综合测评', '活动申请', '自定义审核'])
const txt = (value: string) => ({ kind: 'text' as const, value })
const value = (input: ReviewCaseV2, key: string): string | undefined => {
  const field = input.caseFields[key]
  return field?.kind === 'text' ? field.value : undefined
}

export type NativeCreateWorkspaceInputV3 = {
  title: string
  type: ReviewCaseType
  applicant: string
  academicYear: string
  domainPackId?: string
  reviewTemplate?: { templateId: string; version: number }
}

export function isNativeWorkspaceCaseV3(aggregate: CaseAggregateV2 | undefined): boolean {
  return !!aggregate?.caseV2 && Array.isArray(aggregate.receiptLog) &&
    aggregate.receiptLog[0]?.type === NATIVE_CREATE_RECEIPT_V3 &&
    aggregate.receiptLog[0]?.revision === 0
}

export function nativeWorkspaceProjectionV3(aggregate: CaseAggregateV2 | undefined): ReviewCase | undefined {
  if (!isNativeWorkspaceCaseV3(aggregate) || !aggregate) return undefined
  const state = aggregate.caseV2
  if (state.stage === 'archived' || !Number.isSafeInteger(state.revision) ||
      typeof state.title !== 'string' || !Array.isArray(state.documents) ||
      !Array.isArray(state.subjects)) return undefined
  const type = value(state, 'legacyReviewType')
  const applicant = value(state, 'applicant')
  const academicYear = value(state, 'academicYear')
  const domainPackId = value(state, 'legacyDomainPackId')
  if (!type || !TYPES.has(type) || applicant === undefined || academicYear === undefined ||
      !domainPackId || !state.id) return undefined
  // V1's three columns have no 'attachment' role. Never mislabel a native
  // attachment as verified evidence; it remains visible in the V2 ledger.
  const current = state.documents.filter(document => document.active !== false && document.role !== 'attachment')
  const archived = state.documents.filter(document => document.active === false && document.role !== 'attachment')
  const asDocument = (doc: DocumentVersion): SourceDocument => ({
    id: doc.documentId,
    fileName: doc.fileName,
    role: doc.role as SourceDocument['role'],
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    parseStatus: doc.parseStatus === 'pending' ? 'partial' : doc.parseStatus,
    ...(doc.parseError ? { parseError: doc.parseError } : {}),
    blocks: doc.blocks.map(block => ({
      id: block.blockId,
      text: block.text,
      kind: block.kind === 'image' ? 'image' : block.kind === 'table' ? 'table-cell'
        : block.format === 'heading' ? 'heading' : block.format === 'list-item' ? 'list-item' : 'paragraph',
      page: block.location?.kind === 'pdf-rect' ? block.location.page : 1,
      ...(block.table ? { table: block.table } : {}),
      ...(block.imageAlt ? { imageAlt: block.imageAlt } : {}),
      ...(block.imageAssetPath ? { imageAssetPath: block.imageAssetPath } : {}),
    })),
    origin: 'upload',
    // DocumentVersion has no creation timestamp; use the durable material
    // receipt where available instead of inventing a per-block provenance.
    importedAt: aggregate.receiptLog.find(receipt =>
      receipt.type === 'RegisterMaterial' && receipt.summary.includes(doc.versionId))?.at ?? state.createdAt,
  })
  const documents = current.map(asDocument)
  // Version-pinned selection prevents an old documentId from automatically
  // selecting its new, as-yet-unreviewed physical bytes.
  const savedSelection = state.nativeWorkspaceDraft?.subjectDocumentVersionIds
  const subjectDocumentIds = savedSelection?.flatMap(versionId => {
    const document = current.find(doc => doc.versionId === versionId && doc.role === 'application')
    return document ? [document.documentId] : []
  })
  const rulePacks = current.filter(doc => doc.role === 'rule').map(doc => ({
    id: `native-pack-${doc.versionId}`,
    documentId: doc.documentId,
    name: doc.fileName.replace(/\.[^.]+$/, ''),
    publisher: '',
    academicYear,
    version: doc.versionId,
    outline: [],
    confirmed: false,
  }))
  const hasBoundTemplate = state.templateId !== PENDING_TEMPLATE && state.templateVersion > 0
  return {
    id: state.id, title: state.title, type: type as ReviewCaseType, applicant, academicYear,
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    documents, archivedDocuments: archived.map(asDocument), rulePacks,
    items: [], evidences: current.filter(doc => doc.role === 'evidence').map(doc => ({
      documentId: doc.documentId, recognizedFacts: '', parseStatus: 'unrecognized' as const,
      linkedItemIds: [],
    })), isDemo: false,
    domainPackId: domainPackId as ReviewCase['domainPackId'],
    ...(hasBoundTemplate ? { reviewTemplate: { templateId: state.templateId, version: state.templateVersion } } : {}),
    ...(state.nativeWorkspaceDraft?.manualRules ? { manualRules: state.nativeWorkspaceDraft.manualRules.map(rule => ({ ...rule })) } : {}),
    ...(savedSelection !== undefined ? { subjectDocumentIds } : {}),
    revision: state.revision,
  }
}

function resolvedTemplate(domain: string, explicit?: { templateId: string; version: number }) {
  ensureBuiltinTemplateDrafts({ getTemplate, saveDraft })
  if (explicit) {
    if (!explicit.templateId || !Number.isSafeInteger(explicit.version) || explicit.version < 1)
      throw new CommandValidationError('VALIDATION_FAILED', '审核模板版本非法')
    const selected = getTemplate(explicit.templateId, explicit.version)
    if (!selected || selected.status !== 'published')
      throw new CommandValidationError('VALIDATION_FAILED', '只能选择已发布模板；候选与草稿不能作为正式绑定')
    return selected
  }
  const mapped = mapDomainToTemplate(domain).templateId
  // Custom/unmapped domains remain genuinely unbound, not silently assigned
  // the comprehensive-assessment policy. No official Plan is installed.
  const selected = mapped ? getTemplate(mapped) : undefined
  // A template draft/reference candidate is NOT an installed published Plan.
  return selected?.status === 'published' ? selected : undefined
}

/** Main generates its own identity; V2 CAS+creation receipt commits first. */
export async function createNativeWorkspaceCaseV3(input: NativeCreateWorkspaceInputV3, actor: Actor = MAIN_ACTOR, authorizeAtCommit?: () => void):
  Promise<{ aggregate: CaseAggregateV2; view: ReviewCase }> {
  if (!input || typeof input !== 'object' || !TYPES.has(input.type) ||
      typeof input.title !== 'string' || input.title.length === 0 ||
      typeof input.applicant !== 'string' || !input.applicant.trim() ||
      typeof input.academicYear !== 'string' || !input.academicYear.trim() ||
      (input.domainPackId !== undefined && typeof input.domainPackId !== 'string')) {
    throw new CommandValidationError('VALIDATION_FAILED', '新建案卷缺少标题、类型、申请人或学年')
  }
  if (actor.actorSource !== 'local' || actor.role !== 'reviewer')
    throw new CommandValidationError('VALIDATION_FAILED', '只有受信本地审核人可建案')
  const domain = resolveDomainPack(input.domainPackId).id
  const template = resolvedTemplate(domain, input.reviewTemplate)
  const caseId = `case-${randomUUID().replace(/-/g, '')}`
  const now = new Date().toISOString()
  const state: ReviewCaseV2 = {
    id: caseId, templateId: template?.templateId ?? PENDING_TEMPLATE,
    templateVersion: template?.version ?? 0,
    title: input.title.trim() || '未命名案卷', objectType: template?.objectType ?? 'document',
    caseFields: {
      applicant: txt(input.applicant.trim()), academicYear: txt(input.academicYear.trim()),
      legacyReviewType: txt(input.type), legacyDomainPackId: txt(domain),
    },
    subjects: [], documents: [], stage: 'draft', revision: 0, createdAt: now, updatedAt: now,
  }
  const receipt = {
    requestId: `native-create-${caseId}`, type: NATIVE_CREATE_RECEIPT_V3,
    payloadHash: payloadHash(NATIVE_CREATE_RECEIPT_V3, {
      title: state.title, type: input.type, applicant: input.applicant.trim(),
      academicYear: input.academicYear.trim(), domainPackId: domain,
      templateId: state.templateId, templateVersion: state.templateVersion,
    }), revision: 0, at: now, summary: 'Main 原生建案，未发布任何校方政策或正式 Plan', actor,
  }
  await createAggregate(caseId, state, receipt, authorizeAtCommit)
  const aggregate = readAggregate(caseId)!
  const view = nativeWorkspaceProjectionV3(aggregate)
  if (!view) throw new Error('原生案卷已建立但兼容视图未能生成；请从 V2 列表恢复')
  return { aggregate, view }
}

/** No V1 updateCase/saveCase; native settings share the existing durable ledger. */
export async function updateNativeWorkspaceSettingsV3(
  caseId: string, input: UpdateCaseSettingsRequest, actor: Actor = MAIN_ACTOR,
  authorizeAtCommit?: () => void,
): Promise<ReviewCase> {
  const original = readAggregate(caseId)
  if (!isNativeWorkspaceCaseV3(original) || !original)
    throw new CommandValidationError('NOT_FOUND', '案卷不是原生工作台案卷')
  if (original.canonicalPlan || original.d2RuntimePlan)
    throw new CommandValidationError('INVALID_TRANSITION', '正式 Plan 已绑定；仅允许显式升版与确认')
  const inputRules = input.manualRules
  let checkedRules: NonNullable<ReviewCaseV2['nativeWorkspaceDraft']>['manualRules'] | undefined
  if (inputRules !== undefined) {
    if (!Array.isArray(inputRules) || inputRules.length > 100)
      throw new CommandValidationError('VALIDATION_FAILED', '手写规则必须是 100 条以内的列表')
    const ids = new Set<string>()
    checkedRules = inputRules.map((rule, index) => {
      if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(rule.id) || ids.has(rule.id) ||
          typeof rule.title !== 'string' || !rule.title.trim() || rule.title.length > 160 ||
          typeof rule.requirement !== 'string' || !rule.requirement.trim() || rule.requirement.length > 8000)
        throw new CommandValidationError('VALIDATION_FAILED', `第 ${index + 1} 条手写规则无效`)
      ids.add(rule.id)
      return { id: rule.id, title: rule.title.trim(), requirement: rule.requirement.trim() }
    })
  }
  let selectedVersions: string[] | undefined
  if (input.subjectDocumentIds !== undefined) {
    if (!Array.isArray(input.subjectDocumentIds) ||
        input.subjectDocumentIds.some(id => typeof id !== 'string' || !id) ||
        new Set(input.subjectDocumentIds).size !== input.subjectDocumentIds.length)
      throw new CommandValidationError('VALIDATION_FAILED', '待审主体文档列表无效或重复')
    // Map the legacy document ID into its current exact physical V2 version.
    // This is a draft scope, NOT a CanonicalPlan source authorization.
    selectedVersions = input.subjectDocumentIds.map(documentId => {
      const document = original.caseV2.documents.find(doc =>
        doc.documentId === documentId && doc.role === 'application' && doc.active !== false)
      if (!document) throw new CommandValidationError('STALE_INPUT', '待审主体材料不存在、已换版或角色不合法')
      return document.versionId
    })
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim()))
    throw new CommandValidationError('VALIDATION_FAILED', '标题不能为空')
  if (input.type !== undefined && !TYPES.has(input.type))
    throw new CommandValidationError('VALIDATION_FAILED', '案卷类型非法')
  if (input.domainPackId !== undefined && typeof input.domainPackId !== 'string')
    throw new CommandValidationError('VALIDATION_FAILED', '审核领域非法')
  const domain = resolveDomainPack(input.domainPackId ?? value(original.caseV2, 'legacyDomainPackId')).id
  const template = input.reviewTemplate === undefined && input.domainPackId === undefined
    ? undefined : resolvedTemplate(domain, input.reviewTemplate ?? undefined)
  const output = await submitCommand(caseId, {
    type: 'UpdateNativeWorkspaceSettingsV3',
    requestId: `native-settings-${randomUUID().replace(/-/g, '')}`,
    expectedRevision: original.caseV2.revision,
    actor, payload: {
      title: input.title, type: input.type, domainPackId: domain,
      manualRules: checkedRules ?? null, subjectDocumentVersionIds: selectedVersions ?? null,
      templateChange: input.reviewTemplate !== undefined || input.domainPackId !== undefined,
      templateId: template?.templateId ?? PENDING_TEMPLATE, templateVersion: template?.version ?? 0,
      objectType: template?.objectType ?? 'document',
    },
  }, snapshot => {
    authorizeAtCommit?.()
    if (!isNativeWorkspaceCaseV3(snapshot)) throw new CommandValidationError('INVALID_TRANSITION', '案卷权威已改变')
    if (snapshot.canonicalPlan || snapshot.d2RuntimePlan)
      throw new CommandValidationError('INVALID_TRANSITION', '审核计划已冻结')
    if (snapshot.caseV2.stage !== 'draft')
      throw new CommandValidationError('INVALID_TRANSITION', '只有草稿阶段可修改本地工作台规则及材料范围')
    if ((checkedRules !== undefined || selectedVersions !== undefined) &&
        (snapshot.observations.some(item => item.confirmed) ||
          snapshot.evidenceLinks.some(item => item.status === 'confirmed')))
      throw new CommandValidationError('DEPENDENCY_UNRESOLVED', '存在已确认事实或证据，请先完成显式撤销与重新审核')
    if (selectedVersions && selectedVersions.some(versionId =>
      !snapshot.caseV2.documents.some(doc => doc.versionId === versionId &&
        doc.role === 'application' && doc.active !== false)))
      throw new CommandValidationError('STALE_INPUT', '材料在提交前已换版或归档，请重新选择')
    return { summary: '修改原生案卷草稿设置（不产生校方政策与正式 Plan）', mutate: draft => {
      if (input.title !== undefined) draft.caseV2.title = input.title.trim()
      if (input.type !== undefined) draft.caseV2.caseFields.legacyReviewType = txt(input.type)
      if (input.domainPackId !== undefined) draft.caseV2.caseFields.legacyDomainPackId = txt(domain)
      if (checkedRules !== undefined || selectedVersions !== undefined) {
        const old = draft.caseV2.nativeWorkspaceDraft
        draft.caseV2.nativeWorkspaceDraft = {
          manualRules: checkedRules ?? old?.manualRules ?? [],
          ...(selectedVersions !== undefined
            ? { subjectDocumentVersionIds: [...selectedVersions] }
            : old?.subjectDocumentVersionIds !== undefined
              ? { subjectDocumentVersionIds: [...old.subjectDocumentVersionIds] } : {}),
        }
      }
      if (input.reviewTemplate !== undefined || input.domainPackId !== undefined) {
        draft.caseV2.templateId = template?.templateId ?? PENDING_TEMPLATE
        draft.caseV2.templateVersion = template?.version ?? 0
        draft.caseV2.objectType = template?.objectType ?? 'document'
      }
    } }
  })
  if (!output.ok) throw new CommandValidationError(output.code, output.message)
  const projected = nativeWorkspaceProjectionV3(output.aggregate)
  if (!projected) throw new Error('原生设置已保存但兼容读取失败')
  return projected
}

/** Native material intake uses the existing C-owned physical-byte V2 service. */
export async function registerNativeWorkspaceMaterialV3(
  caseId: string, sourcePath: string, role: SourceDocument['role'], actor: Actor = MAIN_ACTOR,
  authorizeAtCommit?: () => void,
): Promise<SourceDocument> {
  const current = readAggregate(caseId)
  if (!isNativeWorkspaceCaseV3(current) || !current || current.caseV2.stage === 'archived')
    throw new CommandValidationError('INVALID_TRANSITION', '案卷不存在、已归档或不是原生 V2 案卷')
  authorizeAtCommit?.()
  const result = await registerMaterial(caseId, {
    requestId: `native-register-${randomUUID().replace(/-/g, '')}`,
    actor, expectedRevision: current.caseV2.revision,
    payload: { sourcePath, role },
  }, authorizeAtCommit)
  if (!result.ok) throw new CommandValidationError(result.code, result.message)
  const doc = result.entity
  const view = nativeWorkspaceProjectionV3(result.aggregate)
  const found = view?.documents.find(candidate => candidate.id === doc?.documentId)
  if (!found) throw new Error('原生材料已写入但只读兼容投影失败，请通过 V2 材料列表查看')
  return found
}

export async function removeNativeWorkspaceDocumentsV3(
  caseId: string, role: SourceDocument['role'], documentIds?: string[], actor: Actor = MAIN_ACTOR,
  authorizeAtCommit?: () => void,
): Promise<ReviewCase> {
  if (documentIds !== undefined && (!Array.isArray(documentIds) ||
      documentIds.some(id => typeof id !== 'string' || !id) ||
      new Set(documentIds).size !== documentIds.length))
    throw new CommandValidationError('VALIDATION_FAILED', '移除材料 ID 非法或重复')
  const original = readAggregate(caseId)
  if (!isNativeWorkspaceCaseV3(original) || !original)
    throw new CommandValidationError('NOT_FOUND', '原生案卷不存在')
  const result = await submitCommand(caseId, {
    requestId: `native-remove-${randomUUID().replace(/-/g, '')}`,
    expectedRevision: original.caseV2.revision, actor,
    type: 'ArchiveNativeWorkspaceDocumentsV3',
    payload: { role, documentIds: documentIds ?? null },
  }, (snapshot, payload) => {
    authorizeAtCommit?.()
    if (!isNativeWorkspaceCaseV3(snapshot))
      throw new CommandValidationError('INVALID_TRANSITION', '原生案卷权威已经变化')
    const applicable = snapshot.caseV2.documents.filter(d => d.active !== false && d.role === role &&
      (payload.documentIds === null || payload.documentIds.includes(d.documentId)))
    if (applicable.length === 0 || (payload.documentIds !== null &&
        applicable.length !== payload.documentIds.length))
      throw new CommandValidationError('VALIDATION_FAILED', '材料不存在、版本已失效或角色不匹配')
    const retiring = new Set(applicable.map(d => d.versionId))
    return { summary: '原生材料批量归档：保留物理原件及所有历史来源', mutate: draft => {
      draft.caseV2.documents = draft.caseV2.documents.map(d =>
        retiring.has(d.versionId) ? { ...d, active: false, usage: 'unread' as const } : d)
      revokeCurrentSourceValidity(draft, retiring, 'archive')
    } }
  })
  if (!result.ok) throw new CommandValidationError(result.code, result.message)
  const view = nativeWorkspaceProjectionV3(result.aggregate)
  if (!view) throw new Error('归档已写入，兼容视图未能恢复')
  return view
}

export async function reorderNativeWorkspaceDocumentsV3(
  caseId: string, role: SourceDocument['role'], documentIds: string[], actor: Actor = MAIN_ACTOR,
  authorizeAtCommit?: () => void,
): Promise<ReviewCase> {
  if (!Array.isArray(documentIds) || documentIds.some(id => typeof id !== 'string' || !id) ||
      new Set(documentIds).size !== documentIds.length)
    throw new CommandValidationError('VALIDATION_FAILED', '材料顺序无效或存在重复')
  const original = readAggregate(caseId)
  if (!isNativeWorkspaceCaseV3(original) || !original)
    throw new CommandValidationError('NOT_FOUND', '原生案卷不存在')
  const outcome = await submitCommand(caseId, {
    requestId: `native-reorder-${randomUUID().replace(/-/g, '')}`,
    expectedRevision: original.caseV2.revision, actor,
    type: 'ReorderNativeWorkspaceDocumentsV3', payload: { role, documentIds },
  }, (snapshot, payload) => {
    authorizeAtCommit?.()
    const active = snapshot.caseV2.documents.filter(d => d.active !== false && d.role === role)
    if (active.length !== payload.documentIds.length ||
        active.some(d => !payload.documentIds.includes(d.documentId)))
      throw new CommandValidationError('VALIDATION_FAILED', '顺序必须覆盖当前角色的所有有效材料')
    const byId = new Map(active.map(d => [d.documentId, d]))
    const desired = payload.documentIds.map(id => byId.get(id)!)
    return { summary: '调整原生材料显示次序，不更改任何物理身份', mutate: draft => {
      let i = 0
      draft.caseV2.documents = draft.caseV2.documents.map(d =>
        d.active !== false && d.role === role ? desired[i++]! : d)
    } }
  })
  if (!outcome.ok) throw new CommandValidationError(outcome.code, outcome.message)
  const view = nativeWorkspaceProjectionV3(outcome.aggregate)
  if (!view) throw new Error('材料顺序已写入，兼容投影失败')
  return view
}
