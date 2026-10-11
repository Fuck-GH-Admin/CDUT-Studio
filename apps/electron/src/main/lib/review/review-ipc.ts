import { bindLocalReviewerCommand } from './review-ipc-actor-guard'
import { assertSafeReviewStorageId } from './review-storage-id'
/**
 * 内容审核专区 - IPC 处理器注册
 *
 * 对应共享通道常量：packages/shared/src/types/review.ts 的 REVIEW_IPC_CHANNELS。
 * preload 侧桥接：apps/electron/src/preload/index.ts 的 reviewAPI。
 *
 * 设计决策（docs/plans/2026-10-02-content-review-demo-implementation.md D2）：
 * 独立注册函数 registerReviewIpc()，由 main/ipc.ts 的 registerIpcHandlers() 调用一次，
 * 避免向 7700+ 行的 ipc.ts 继续追加业务逻辑。
 */

import { app, ipcMain } from 'electron'
import {
  REVIEW_MODEL_PROVIDERS,
  REVIEW_IPC_CHANNELS,
  type AssistantChatRequest,
  type ExportReportResult,
  type ImportDocumentsResult,
  type GenerateRuleOutlineRequest,
  type ReviewCase,
  type ReviewCaseType,
  type ReviewItem,
  type ReviewModelGatewayStatus,
  type ReviewModuleSettingsV2,
  type ReviewRun,
  type RuleOutlineItem,
  type SourceDocument,
  type UpdateCaseSettingsRequest,
  type UpdateRuleOutlineRequest,
  type UpdateReviewItemRequest,
} from '@profer/shared'
import {
  deleteCase,
  getCase,
  getReviewCasesDir,
  listCases,
  listRuns,
  loadDemoCase,
  saveCase,
  updateCase,
} from './case-store'
import { parseFileIntoSourceDocument } from './document-service'
import {
  extractItems,
  generateRuleOutline,
  reviewAssistantChat,
  runAiReview,
} from './ai-review-service'
import { startReviewRun } from './run-service'
import { exportReport } from './report-service'
import { getReviewModelGatewayStatus } from './review-model-gateway'
import { createEmptyCase } from './case-creation'
import { importDocumentFromPath, importDocumentsIntoCase, removeDocumentsFromCase, reorderDocumentsInCase } from './case-import'
import { invalidateDerivedReviewInputs } from './input-invalidation'
import { ensureWorkspaceAggregateV2, syncWorkspaceProjectionV2 } from './workspace-service-v2'
import { resolveCaseDocumentPreviewPath } from './document-preview-path'

/** 来源角色枚举（IMPORT_DOCUMENT 入参白名单） */
const SOURCE_ROLES: ReadonlySet<string> = new Set(['rule', 'application', 'evidence'])

/** 审核类型枚举（CREATE_CASE 入参白名单） */
const CASE_TYPES: ReadonlySet<string> = new Set(['综合测评', '活动申请', '自定义审核'])

/** 收窄字符串入参（非字符串 → 中文错误，IPC 边界上类型注解不生效） */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 ${name} 缺失或类型非法`)
  }
  return value
}

/**
 * 注册内容审核专区全部 IPC 处理器。
 *
 * 由 registerIpcHandlers() 在应用启动时调用一次（幂等由外层守卫保证）。
 */
export function registerReviewIpc(): void {
  // 启动恢复：上次进程遗留的 queued/running 运行标 interrupted（08 设计 §5）
  try {
    const { markStaleRunsInterrupted } = require('./run-store-v2') as typeof import('./run-store-v2')
    const recovered = markStaleRunsInterrupted()
    if (recovered > 0) console.log(`[审核V2] 启动恢复：${recovered} 个中断运行已标记（可续跑）`)
  } catch (error) {
    console.warn('[审核V2] 启动恢复检查失败:', error)
  }
  // ===== 案卷管理 =====

  /** 载入演示案卷（首次复制进配置目录，之后读存储） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LOAD_DEMO_CASE, async (): Promise<ReviewCase> => {
    const reviewCase = loadDemoCase()
    await ensureWorkspaceAggregateV2(reviewCase.id)
    return reviewCase
  })

  /** 列出已存储案卷（摘要） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_CASES, () => {
    return listCases()
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_RUNS, (_event, caseId: string): ReviewRun[] => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    return listRuns(caseId)
  })

  /** 读取单个案卷 */
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_CASE, (_event, caseId: string): ReviewCase | undefined => {
    return getCase(caseId)
  })

  /** 创建空案卷 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.CREATE_CASE,
    async (
      _event,
      input: {
        title: string
        type: ReviewCaseType
        applicant: string
        academicYear: string
        domainPackId?: string
        reviewTemplate?: { templateId: string; version: number }
      },
    ): Promise<ReviewCase> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!CASE_TYPES.has(input.type)) throw new Error(`参数 type 非法：${String(input.type)}`)
      // 领域包 ID 只做存在性判断：未知 ID 回落缺省包由 resolveDomainPack 负责，不因拼错而拒绝建卷
      if (input.domainPackId !== undefined && typeof input.domainPackId !== 'string') {
        throw new Error('参数 domainPackId 类型非法')
      }
      if (input.reviewTemplate !== undefined) {
        const { templateId, version } = input.reviewTemplate
        if (typeof templateId !== 'string' || !templateId || !Number.isInteger(version) || version < 1) {
          throw new Error('参数 reviewTemplate 非法')
        }
        const { getTemplate } = require('./template-store') as typeof import('./template-store')
        const template = getTemplate(templateId, version)
        if (!template || template.status !== 'published') throw new Error('只能使用已发布的审核模板创建项目')
      }
      const reviewCase = createEmptyCase({
        title: requireString(input.title, 'title'),
        type: input.type,
        applicant: requireString(input.applicant, 'applicant'),
        academicYear: requireString(input.academicYear, 'academicYear'),
        ...(input.domainPackId ? { domainPackId: input.domainPackId } : {}),
        ...(input.reviewTemplate ? { reviewTemplate: input.reviewTemplate } : {}),
      })
      await ensureWorkspaceAggregateV2(reviewCase.id)
      return reviewCase
    },
  )

  /** 更新案卷设置（领域包 / 标题 / 类型 / 待审主体文档） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.UPDATE_CASE_SETTINGS,
    async (_event, input: UpdateCaseSettingsRequest): Promise<ReviewCase> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      const caseId = requireString(input.caseId, 'caseId')
      const reviewCase = getCase(caseId)
      if (!reviewCase) throw new Error(`案卷不存在: ${caseId}`)
      if (input.type !== undefined && !CASE_TYPES.has(input.type)) {
        throw new Error(`参数 type 非法：${String(input.type)}`)
      }
      if (input.domainPackId !== undefined && typeof input.domainPackId !== 'string') {
        throw new Error('参数 domainPackId 类型非法')
      }
      if (input.title !== undefined && typeof input.title !== 'string') {
        throw new Error('参数 title 类型非法')
      }
      let reviewTemplate: ReviewCase['reviewTemplate'] | null | undefined
      if (input.reviewTemplate !== undefined) {
        if (input.reviewTemplate === null) {
          reviewTemplate = null
        } else {
          const selected = input.reviewTemplate
          if (!selected || typeof selected !== 'object'
            || typeof selected.templateId !== 'string'
            || !Number.isInteger(selected.version) || selected.version < 1) {
            throw new Error('审核模板参数非法')
          }
          const { getTemplate, isSafeTemplateId } = require('./template-store') as typeof import('./template-store')
          if (!isSafeTemplateId(selected.templateId)) throw new Error('审核模板参数非法')
          const template = getTemplate(selected.templateId, selected.version)
          if (!template || template.status !== 'published') {
            throw new Error('只能载入已发布的审核模板版本')
          }
          reviewTemplate = { templateId: selected.templateId, version: selected.version }
        }
      }
      let manualRules: ReviewCase['manualRules'] | undefined
      if (input.manualRules !== undefined) {
        if (!Array.isArray(input.manualRules) || input.manualRules.length > 100) {
          throw new Error('手写规则必须是 100 条以内的列表')
        }
        const seenRuleIds = new Set<string>()
        manualRules = input.manualRules.map((rule, index) => {
          if (!rule || typeof rule !== 'object'
            || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(rule.id)
            || seenRuleIds.has(rule.id)
            || typeof rule.title !== 'string' || rule.title.trim().length === 0 || rule.title.length > 160
            || typeof rule.requirement !== 'string' || rule.requirement.trim().length === 0 || rule.requirement.length > 8000) {
            throw new Error(`第 ${index + 1} 条手写规则无效`)
          }
          seenRuleIds.add(rule.id)
          return { id: rule.id, title: rule.title.trim(), requirement: rule.requirement.trim() }
        })
      }
      // 待审主体文档：逐个校验是否属于本卷，防止悬空 ID 让三栏联动指向不存在的文档
      let subjectDocumentIds: string[] | undefined
      if (input.subjectDocumentIds !== undefined) {
        if (!Array.isArray(input.subjectDocumentIds) || input.subjectDocumentIds.some((id) => typeof id !== 'string')) {
          throw new Error('参数 subjectDocumentIds 类型非法')
        }
        const known = new Set(reviewCase.documents.map((doc) => doc.id))
        subjectDocumentIds = input.subjectDocumentIds.filter((id) => known.has(id))
        if (subjectDocumentIds.length !== input.subjectDocumentIds.length) {
          throw new Error('待审主体文档包含不属于本案卷的文档 ID')
        }
      }
      // M0/H05：设置变更走逐案串行写队列（读最新 → 定向 patch → revision+1），
      // 避免校验期间的其他写回（导入/大纲/识别）被整案快照覆盖
      const updated = await updateCase(
        caseId,
        (fresh) => {
          const domainPackChanged = input.domainPackId !== undefined
            && (fresh.domainPackId ?? 'comprehensive-assessment') !== input.domainPackId
          const subjectDocumentsChanged = subjectDocumentIds !== undefined
            && JSON.stringify(fresh.subjectDocumentIds ?? []) !== JSON.stringify(subjectDocumentIds)
          return {
            ...invalidateDerivedReviewInputs(fresh, { domainPackChanged, subjectDocumentsChanged }),
            ...(input.title !== undefined ? { title: input.title.trim() || fresh.title } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.domainPackId !== undefined ? { domainPackId: input.domainPackId } : {}),
            ...(subjectDocumentIds !== undefined ? { subjectDocumentIds } : {}),
            ...(reviewTemplate !== undefined ? { reviewTemplate: reviewTemplate ?? undefined } : {}),
            ...(manualRules !== undefined ? { manualRules } : {}),
          }
        },
        { reason: `更新案卷审核设置${input.domainPackId ? `（领域包 ${input.domainPackId}）` : ''}` },
      )
      await syncWorkspaceProjectionV2(caseId)
      return updated
    },
  )

  ipcMain.handle(REVIEW_IPC_CHANNELS.UPDATE_RULE_OUTLINE, async (_event, input: UpdateRuleOutlineRequest): Promise<ReviewCase> => {
    if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
    const caseId = requireString(input.caseId, 'caseId')
    const rulePackId = requireString(input.rulePackId, 'rulePackId')
    const ruleId = requireString(input.ruleId, 'ruleId')
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('规则名称不能为空且不能超过 160 字')
    if (typeof input.summary !== 'string' || input.summary.length > 8000) throw new Error('规则摘要不能超过 8000 字')
    const updated = await updateCase(caseId, (fresh) => {
      const pack = fresh.rulePacks.find((item) => item.id === rulePackId)
      if (!pack || !pack.outline.some((item) => item.id === ruleId)) throw new Error('规则摘要不存在或已被移除，请刷新后重试')
      return {
        ...fresh,
        rulePacks: fresh.rulePacks.map((item) => item.id === rulePackId
          ? { ...item, outline: item.outline.map((rule) => rule.id === ruleId ? { ...rule, title: input.title.trim(), summary: input.summary.trim() } : rule) }
          : item),
      }
    }, { reason: `手动调整规则摘要 ${ruleId}` })
    await syncWorkspaceProjectionV2(caseId)
    return updated
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.UPDATE_REVIEW_ITEM, async (_event, input: UpdateReviewItemRequest): Promise<ReviewCase> => {
    if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
    const caseId = requireString(input.caseId, 'caseId')
    const itemId = requireString(input.itemId, 'itemId')
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('申报事项名称不能为空且不能超过 160 字')
    if (typeof input.category !== 'string' || !input.category.trim() || input.category.length > 80) throw new Error('申报事项类别不能为空且不能超过 80 字')
    if (typeof input.declaredScore !== 'number' || !Number.isFinite(input.declaredScore) || input.declaredScore < 0 || input.declaredScore > 1000000) throw new Error('申报分值必须是 0 至 1000000 之间的数字')
    for (const [field, value, maxLength] of [
      ['level', input.level, 100],
      ['activityDate', input.activityDate, 80],
      ['organizer', input.organizer, 200],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) throw new Error(`申报事项${field}字段无效`)
    }
    const updated = await updateCase(caseId, (fresh) => {
      if (!fresh.items.some((item) => item.id === itemId)) throw new Error('申报事项已不存在，请刷新后重试')
      return {
        ...fresh,
        items: fresh.items.map((item) => item.id === itemId ? {
          ...item,
          title: input.title.trim(),
          category: input.category.trim(),
          declaredScore: input.declaredScore,
          ...(input.level?.trim() ? { level: input.level.trim() } : { level: undefined }),
          ...(input.activityDate?.trim() ? { activityDate: input.activityDate.trim() } : { activityDate: undefined }),
          ...(input.organizer?.trim() ? { organizer: input.organizer.trim() } : { organizer: undefined }),
          status: 'confirmed',
          identifiedBy: 'manual',
        } : item),
      }
    }, { reason: `人工修正申报事项 ${itemId}` })
    await syncWorkspaceProjectionV2(caseId)
    return updated
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.CONFIRM_RULE_PACK, async (_event, input: { caseId: string; rulePackId: string }): Promise<ReviewCase> => {
    const caseId = requireString(input?.caseId, 'caseId')
    const rulePackId = requireString(input?.rulePackId, 'rulePackId')
    const { confirmRulePackInCase } = require('./case-import') as typeof import('./case-import')
    return confirmRulePackInCase(caseId, rulePackId)
  })

  /** 导入文件到案卷（系统选择框 → 解析为 SourceDocument 并写回案卷） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.IMPORT_DOCUMENT,
    (_event, input: { caseId: string; role: SourceDocument['role']; requestId?: string }): Promise<ImportDocumentsResult> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!SOURCE_ROLES.has(input.role)) throw new Error(`参数 role 非法：${String(input.role)}`)
      const { BrowserWindow } = require('electron') as typeof import('electron')
      const sender = _event.sender
      return importDocumentsIntoCase({
        caseId: requireString(input.caseId, 'caseId'),
        role: input.role,
        parentWindow: BrowserWindow.fromWebContents(_event.sender) ?? undefined,
        requestId: typeof input.requestId === 'string' ? input.requestId : undefined,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send(REVIEW_IPC_CHANNELS.IMPORT_DOCUMENT_PROGRESS, progress)
        },
      })
    },
  )

  /** 开发版 UI 自动化/模型验收入口；正式构建仍只允许由系统文件选择框授权路径。 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.IMPORT_DOCUMENT_FROM_PATH,
    async (_event, input: { caseId: string; sourcePath: string; role: SourceDocument['role']; requestId?: string }): Promise<SourceDocument> => {
      if (app.isPackaged) throw new Error('路径直导仅在开发版可用')
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!SOURCE_ROLES.has(input.role)) throw new Error(`参数 role 非法：${String(input.role)}`)
      const sourcePath = requireString(input.sourcePath, 'sourcePath')
      const sender = _event.sender
      return importDocumentFromPath({
        caseId: requireString(input.caseId, 'caseId'),
        sourcePath,
        role: input.role,
        requestId: typeof input.requestId === 'string' ? input.requestId : undefined,
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send(REVIEW_IPC_CHANNELS.IMPORT_DOCUMENT_PROGRESS, progress)
        },
      })
    },
  )

  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_IMAGE_PREVIEW_PATH, (_event, input: { caseId: string; documentId: string; blockId: string }): string | null => {
    if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
    const caseId = requireString(input.caseId, 'caseId')
    const documentId = requireString(input.documentId, 'documentId')
    const blockId = requireString(input.blockId, 'blockId')
    const reviewCase = getCase(caseId)
    const document = reviewCase?.documents.find((item) => item.id === documentId)
    const block = document?.blocks.find((item) => item.id === blockId)
    if (!reviewCase || !document || !block || block.kind !== 'image') return null

    const { existsSync, realpathSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { isAbsolute, join, relative, resolve, sep } = require('node:path') as typeof import('node:path')
    const caseRoot = resolve(getReviewCasesDir(), caseId)
    const assetPath = block.imageAssetPath ?? join('source-docs', `${document.id}-${document.fileName}`)
    const candidate = isAbsolute(assetPath) ? resolve(assetPath) : resolve(caseRoot, assetPath)
    try {
      if (!existsSync(candidate)) return null
      const rootReal = realpathSync(caseRoot)
      const assetReal = realpathSync(candidate)
      const insidePath = relative(rootReal, assetReal)
      if (!insidePath || insidePath === '..' || insidePath.startsWith(`..${sep}`) || isAbsolute(insidePath)) return null
      const info = statSync(assetReal)
      if (!info.isFile() || info.size > 50 * 1024 * 1024) return null
      return assetReal
    } catch {
      return null
    }
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_WORKSPACE_DOCUMENT_PREVIEW_PATH, (_event, input: { caseId: string; documentVersionId: string }): string | null => {
    if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
    const caseId = requireString(input.caseId, 'caseId')
    const documentVersionId = requireString(input.documentVersionId, 'documentVersionId')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(caseId)) throw new Error('参数 caseId 非法')
    const { readAggregate } = require('./case-store-v2') as typeof import('./case-store-v2')
    const aggregate = readAggregate(caseId)
    const caseRoot = require('node:path').resolve(getReviewCasesDir(), caseId) as string
    return resolveCaseDocumentPreviewPath(caseRoot, aggregate, documentVersionId)
  })

  /** 从当前审核输入中移除一份或某一角色的全部材料；保留案卷内原件。 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.REMOVE_DOCUMENTS,
    (_event, input: { caseId: string; role: SourceDocument['role']; documentIds?: string[] }): Promise<ReviewCase> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!SOURCE_ROLES.has(input.role)) throw new Error(`参数 role 非法：${String(input.role)}`)
      if (input.documentIds !== undefined && (!Array.isArray(input.documentIds) || input.documentIds.some((id) => typeof id !== 'string'))) {
        throw new Error('参数 documentIds 类型非法')
      }
      return removeDocumentsFromCase({
        caseId: requireString(input.caseId, 'caseId'),
        role: input.role,
        ...(input.documentIds !== undefined ? { documentIds: input.documentIds.map((id) => requireString(id, 'documentId')) } : {}),
      })
    },
  )

  /** 更新同一材料栏的呈现与审核顺序。 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.REORDER_DOCUMENTS,
    (_event, input: { caseId: string; role: SourceDocument['role']; documentIds: string[] }): Promise<ReviewCase> => {
      if (!input || typeof input !== 'object') throw new Error('参数 input 缺失或类型非法')
      if (!SOURCE_ROLES.has(input.role)) throw new Error(`参数 role 非法：${String(input.role)}`)
      if (!Array.isArray(input.documentIds) || input.documentIds.some((id) => typeof id !== 'string')) {
        throw new Error('参数 documentIds 类型非法')
      }
      return reorderDocumentsInCase({
        caseId: requireString(input.caseId, 'caseId'),
        role: input.role,
        documentIds: input.documentIds.map((id) => requireString(id, 'documentId')),
      })
    },
  )

  /** 查询最近一次运行及输入有效性（M0/H09：恢复 + 过期标记） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.LATEST_RUN, (_event, caseId: string) => {
    if (typeof caseId !== 'string' || caseId.length === 0) throw new Error('参数 caseId 非法')
    // 惰性引入避免与 run-service 的模块初始化顺序耦合（与 GET_RUN 同款做法）
    const { getLatestRunStatus } = require('./run-service') as typeof import('./run-service')
    return getLatestRunStatus(caseId)
  })

  // ===== V2 通道（M5：全部薄委托，服务层见 review-v2 系列文件） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_TEMPLATES_V2, () => {
    const { listTemplates } = require('./template-store') as typeof import('./template-store')
    return listTemplates()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_TEMPLATE_VERSIONS_V2, () => {
    const { listTemplateVersions } = require('./template-store') as typeof import('./template-store')
    return listTemplateVersions()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_ARCHIVED_TEMPLATES_V2, () => {
    const { listArchivedTemplates } = require('./template-store') as typeof import('./template-store')
    return listArchivedTemplates()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.REORDER_TEMPLATES_V2, (_e, templateIds: string[]) => {
    if (!Array.isArray(templateIds) || templateIds.some((id) => typeof id !== 'string')) throw new Error('模板顺序参数非法')
    const { reorderTemplates } = require('./template-store') as typeof import('./template-store')
    return reorderTemplates(templateIds)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.REMOVE_TEMPLATE_V2, (_e, templateId: string) => {
    if (typeof templateId !== 'string' || !templateId) throw new Error('参数 templateId 非法')
    const { removeTemplateFromLibrary } = require('./template-store') as typeof import('./template-store')
    removeTemplateFromLibrary(templateId)
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESTORE_TEMPLATE_V2, (_e, templateId: string) => {
    if (typeof templateId !== 'string' || !templateId) throw new Error('参数 templateId 非法')
    const { restoreTemplateToLibrary } = require('./template-store') as typeof import('./template-store')
    return restoreTemplateToLibrary(templateId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_TEMPLATE_V2, (_e, templateId: string, version?: number) => {
    if (typeof templateId !== 'string' || !templateId) throw new Error('参数 templateId 非法')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    return getTemplate(templateId, version)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.PUBLISH_TEMPLATE_V2, (_e, templateId: string, version: number) => {
    if (typeof templateId !== 'string' || !templateId || !Number.isFinite(version)) throw new Error('参数非法')
    const { publishTemplate } = require('./template-store') as typeof import('./template-store')
    return publishTemplate(templateId, version)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_RUNS_V2, (_e, caseId: string) => {
    assertSafeReviewStorageId(caseId, 'caseId')
    const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    const { reconcilePiReviewRunsWithReadReceipts } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
    return reconcilePiReviewRunsWithReadReceipts(caseId, listRunsV2(caseId))
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_RUN_V2, (_e, input: { caseId: string; runId: string }) => {
    assertSafeReviewStorageId(input?.caseId, 'caseId')
    assertSafeReviewStorageId(input?.runId, 'runId')
    const { getRunV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    return getRunV2(input.caseId, input.runId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CANCEL_RUN_V2, (_e, runId: string) => {
    if (typeof runId !== 'string' || !runId) throw new Error('参数 runId 非法')
    const { cancelRunV2 } = require('./run-service-v2') as typeof import('./run-service-v2')
    cancelRunV2(runId)
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.MIGRATE_CASE_V2, async (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { getCase } = require('./case-store') as typeof import('./case-store')
    const { migrateCaseToV2 } = require('./migration') as typeof import('./migration')
    const v1 = getCase(caseId)
    if (!v1) throw new Error(`案卷不存在: ${caseId}`)
    const result = migrateCaseToV2(v1)
    if (result.caseV2) await ensureWorkspaceAggregateV2(caseId)
    return result
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BOOT_CHECK_V2, () => {
    const { runBootCheckV2 } = require('./boot-check') as typeof import('./boot-check')
    return runBootCheckV2()
  })

  // ===== N1d：V2 应用命令（薄委托 application-service / fixture） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.SEED_FIXTURE_V2, () => {
    const { seedComprehensiveFixture, publishComprehensiveFixture } = require('./fixtures/comprehensive-fixture') as typeof import('./fixtures/comprehensive-fixture')
    const { getTemplate, saveDraft, publishTemplate } = require('./template-store') as typeof import('./template-store')
    seedComprehensiveFixture({ getTemplate, saveDraft })
    publishComprehensiveFixture({ getTemplate, saveDraft, publish: publishTemplate })
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_CASE_V2, (_e, input: { caseId: string; templateId: string; version: number; payload: unknown; actor: import('@profer/shared').Actor }) => {
    if (!input?.templateId) throw new Error('参数非法')
    assertSafeReviewStorageId(input?.caseId, 'caseId')
    const { createCaseFromTemplate } = require('./application-service') as typeof import('./application-service')
    return createCaseFromTemplate(input.templateId, input.version, input.payload as never, input.actor, input.caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_AGGREGATE_V2, (_e, caseId: string) => {
    assertSafeReviewStorageId(caseId, 'caseId')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    return getCaseV2Aggregate(caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.UPDATE_FIELDS_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { updateFields } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return updateFields(input.caseId, command as unknown as Parameters<typeof updateFields>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.EXPORT_REPORT_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    // 薄委托共享导出服务（08 设计：IPC 与 Agent 工具同服务函数）
    const { exportCaseReport } = require('./report-export-v2-service') as typeof import('./report-export-v2-service')
    return exportCaseReport(caseId)
  })
  // ===== C1：审核操作可信指派（显式指派是 Agent 写权限唯一来源） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.ASSIGNMENT_CREATE_V2, (_e, input: { sessionId: string; turnId: string; caseId?: string; templateId?: string; templateVersion?: number; actions: string[]; workRole?: 'reviewer' | 'student' }) => {
    if (!input || typeof input !== 'object' || !input.sessionId || !input.turnId) throw new Error('指派必须绑定会话与用户轮次')
    const { createAssignment } = require('./review-agent-assignment') as typeof import('./review-agent-assignment')
    return createAssignment({ sessionId: input.sessionId, turnId: input.turnId, caseId: input.caseId, templateId: input.templateId, templateVersion: input.templateVersion, actions: input.actions as never, workRole: input.workRole })
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.ASSIGNMENT_REVOKE_V2, (_e, assignmentId: string) => {
    if (typeof assignmentId !== 'string' || !assignmentId) throw new Error('参数 assignmentId 非法')
    const { revokeAssignment } = require('./review-agent-assignment') as typeof import('./review-agent-assignment')
    return revokeAssignment(assignmentId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.ASSIGNMENT_LIST_V2, (_e, sessionId?: string) => {
    const { listAssignments } = require('./review-agent-assignment') as typeof import('./review-agent-assignment')
    return listAssignments(sessionId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CASE_TIMELINE_V2, (_e, input: { caseId: string; filterOperator?: 'human' | 'agent' | 'mock' | 'school' | 'system' | 'unknown' }) => {
    if (!input || typeof input !== 'object' || typeof input.caseId !== 'string' || !input.caseId) throw new Error('参数 caseId 非法')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const { buildCaseTimeline } = require('./case-timeline') as typeof import('./case-timeline')
    const { listRunsV2 } = require('./run-store-v2') as typeof import('./run-store-v2')
    const { reconcilePiReviewRunsWithReadReceipts } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
    const aggregate = getCaseV2Aggregate(input.caseId)
    if (!aggregate) throw new Error(`案卷聚合不存在: ${input.caseId}`)
    const runs = reconcilePiReviewRunsWithReadReceipts(input.caseId, listRunsV2(input.caseId))
    return buildCaseTimeline(aggregate, runs, input.filterOperator)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_RUN_OBSERVATIONS_V2, (_e, caseId: string) => {
    assertSafeReviewStorageId(caseId, 'caseId')
    const { listRunsV2, readArtifact } = require('./run-store-v2') as typeof import('./run-store-v2')
    const runs = listRunsV2(caseId).filter((run) => run.status === 'completed' || run.status === 'partially-completed')
    if (runs.length === 0) return []
    // 取最近完成运行的 extract 产物观察（真实模型抽取结果，含 sourceRefs 与 confirmed 标记）
    const runId = runs[0]!.id
    const artifact = readArtifact<{ observations?: Array<{ subjectId: string; fieldKey: string; value: unknown; sourceRefs?: Array<{ documentVersionId: string; quote?: string }>; extractedBy?: string; confirmed?: boolean; confidence?: number }> }>(caseId, runId, 'node-auto-check-extract')
    return (artifact?.observations ?? []) as Array<Record<string, unknown>>
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_WORKSPACE_RUN_VALIDITY_V2, (_e, input: { caseId: string; runId: string }) => {
    if (!input?.caseId || !input?.runId) throw new Error('参数非法')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const { isWorkspaceRunStaleV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    const aggregate = getCaseV2Aggregate(input.caseId)
    return !aggregate || isWorkspaceRunStaleV2(aggregate, input.runId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CORRECT_OBSERVATION_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { correctObservation } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return correctObservation(input.caseId, command as unknown as Parameters<typeof correctObservation>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SET_EVIDENCE_LINK_V2, (_e, input: { caseId: string; command: import('@profer/shared').ReviewCommandV2<unknown> }) => {
    const { setEvidenceLink } = require('./application-service') as typeof import('./application-service')
    const command = input.command as unknown as { requestId: string; actor: import('@profer/shared').Actor; expectedRevision: number; payload: unknown }
    return setEvidenceLink(input.caseId, command as unknown as Parameters<typeof setEvidenceLink>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RECORD_WORKSPACE_DISPOSITION_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { recordWorkspaceDispositionV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    return recordWorkspaceDispositionV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof recordWorkspaceDispositionV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.OPEN_WORKSPACE_SUPPLEMENT_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { openWorkspaceSupplementV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    return openWorkspaceSupplementV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof openWorkspaceSupplementV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.ACKNOWLEDGE_WORKSPACE_MATERIAL_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { acknowledgeWorkspaceMaterialV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    return acknowledgeWorkspaceMaterialV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof acknowledgeWorkspaceMaterialV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.DECIDE_WORKSPACE_CASE_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { decideWorkspaceCaseV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    return decideWorkspaceCaseV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof decideWorkspaceCaseV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RECORD_WORKSPACE_SUBJECT_ADJUDICATION_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { recordWorkspaceSubjectAdjudicationV2 } = require('./workspace-business-service-v2') as typeof import('./workspace-business-service-v2')
    return recordWorkspaceSubjectAdjudicationV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof recordWorkspaceSubjectAdjudicationV2>[1])
  })

  // ===== N3b：业务闭环命令（薄委托 stage-workflow） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.RECORD_STAGE_DECISION_V2, (_e, input: { caseId: string; command: Record<string, unknown>; templateId: string; version: number }) => {
    const { recordStageDecision } = require('./stage-workflow') as typeof import('./stage-workflow')
    const { getTemplate } = require('./template-store') as typeof import('./template-store')
    const template = getTemplate(input.templateId, input.version)
    if (!template) throw new Error(`模板不存在: ${input.templateId}@${input.version}`)
    return recordStageDecision(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof recordStageDecision>[1], template)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESOLVE_SUPPLEMENT_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { resolveSupplementV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return resolveSupplementV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof resolveSupplementV2>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESPOND_SUPPLEMENT_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { respondSupplementV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return respondSupplementV2(input.caseId, input.command as unknown as Parameters<typeof respondSupplementV2>[1])
  })
  // ===== G02：V2 批次复用 Pi 审核 Agent 与同一审核工具链 =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_BATCH_V2, async (_e, batchId: string) => {
    if (typeof batchId !== 'string' || !batchId) throw new Error('参数 batchId 非法')
    const { runBatchQueue } = require('./batch-store') as typeof import('./batch-store')
    const { assembleAndRunReview } = require('./run-async-service') as typeof import('./run-async-service')
    const completed = await runBatchQueue(batchId, {
      runCase: async (caseId: string) => {
        const run = await assembleAndRunReview(caseId)
        return { status: run.status }
      },
    })
    if (completed.automation && completed.automation.mode !== 'assist') {
      const { runBatchAutomation } = require('./batch-automation-service') as typeof import('./batch-automation-service')
      await runBatchAutomation(batchId)
    }
    const { readBatchStateV2 } = require('./batch-store') as typeof import('./batch-store')
    return readBatchStateV2(batchId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_REVIEW_V2, async (_e, caseId: string) => {
    assertSafeReviewStorageId(caseId, 'caseId')
    // 薄委托共享运行服务（08 设计：IPC 与 Agent 工具同服务函数；人工发起 local-user）
    const { assembleAndRunReview } = require('./run-async-service') as typeof import('./run-async-service')
    return assembleAndRunReview(caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.PREPARE_PI_REVIEW_V2, (_event, input: { caseId: string; sessionId: string; turnId: string; resumeRunId?: string; inheritReadReceipts?: boolean }) => {
    if (!input || typeof input.caseId !== 'string' || typeof input.sessionId !== 'string' || typeof input.turnId !== 'string'
      || (input.resumeRunId !== undefined && typeof input.resumeRunId !== 'string')
      || (input.inheritReadReceipts !== undefined && typeof input.inheritReadReceipts !== 'boolean')) {
      throw new Error('审核案卷、Pi 会话和用户消息标识均为必填')
    }
    const { getAgentSessionMeta } = require('../agent-session-manager') as typeof import('../agent-session-manager')
    const session = getAgentSessionMeta(input.sessionId)
    if (!session) throw new Error('项目 Pi 会话不存在')
    if (session.agentRuntime && session.agentRuntime !== 'pi') throw new Error('审核工作台只能使用项目 Pi Agent')
    const presetId = session.presetReference?.presetId ?? session.presetId
    if (presetId !== 'review-operator') throw new Error('审核会话必须使用审核操作员预设')
    const { preparePiReviewRunV2 } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
    return preparePiReviewRunV2(input)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_PI_REVIEW_SESSION_V2, (_event, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { getPiReviewSessionForCase } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
    return getPiReviewSessionForCase(caseId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.ABORT_PI_REVIEW_V2, (_event, input: { caseId: string; sessionId: string; assignmentId: string; runId: string }) => {
    if (!input?.caseId || !input.sessionId || !input.assignmentId || !input.runId) throw new Error('审核取消参数不完整')
    const { getPiReviewBindingForSession, finishPiReviewRunV2 } = require('./pi-case-review-service') as typeof import('./pi-case-review-service')
    const binding = getPiReviewBindingForSession(input.sessionId)
    if (!binding || binding.caseId !== input.caseId || binding.runId !== input.runId || binding.assignmentId !== input.assignmentId) return false
    const { revokeAssignment } = require('./review-agent-assignment') as typeof import('./review-agent-assignment')
    finishPiReviewRunV2(binding, { status: 'failed', error: 'Pi 审核启动失败，授权已撤销' })
    revokeAssignment(binding.assignmentId)
    return true
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.CAST_RATING_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { castRating } = require('./rating-service') as typeof import('./rating-service')
    return castRating(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof castRating>[1])
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.RESOLVE_APPEAL_V2, (_e, input: { caseId: string; command: Record<string, unknown> }) => {
    const { resolveAppealV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return resolveAppealV2(input.caseId, bindLocalReviewerCommand(input.command) as unknown as Parameters<typeof resolveAppealV2>[1])
  })

  // ===== N4b：模板向导（无代码创建：政策先行 → 模板草稿 → 发布走 PUBLISH_TEMPLATE_V2） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_POLICY_V2, (_e, input: { policyId: string; title: string; content: string; enteredBy: string }) => {
    if (!input?.policyId || !input?.content) throw new Error('参数非法')
    const { canonicalContentHash, compileOwnerRules, publishPolicy, savePolicyDraft } = require('./policy-store') as typeof import('./policy-store')
    const record = {
      policyId: input.policyId, version: 1, title: input.title, contentHash: canonicalContentHash(input.content), content: input.content,
      compiledRules: compileOwnerRules(input.content, input.policyId, 1),
      origin: { kind: 'owner-statement' as const, text: '向导录入', enteredBy: String(input.enteredBy ?? 'local-user'), enteredAt: new Date().toISOString() },
      status: 'draft' as const,
      confirmations: [{ actorId: String(input.enteredBy ?? 'local-user'), role: 'template-owner' as const, at: new Date().toISOString(), note: '向导录入确认' }],
    }
    savePolicyDraft(record)
    publishPolicy(input.policyId, 1)
    return { policyId: input.policyId, version: 1, contentHash: record.contentHash }
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SAVE_TEMPLATE_DRAFT_V2, (_e, template: import('@profer/shared').TemplateVersion) => {
    if (!template?.templateId) throw new Error('参数非法')
    const { saveDraft } = require('./template-store') as typeof import('./template-store')
    return saveDraft(template)
  })

  // ===== N5b：批次管理（薄委托 batch-store） =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.CREATE_BATCH_V2, (_e, input: { batch: import('@profer/shared').ReviewBatch }) => {
    const { createBatchV2 } = require('./batch-store') as typeof import('./batch-store')
    return createBatchV2(input.batch)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_BATCH_V2, (_e, batchId: string) => {
    const { readBatchStateV2 } = require('./batch-store') as typeof import('./batch-store')
    return readBatchStateV2(batchId)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_BATCHES_V2, () => {
    const { listBatchStatesV2 } = require('./batch-store') as typeof import('./batch-store')
    return listBatchStatesV2()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BATCH_ACTION_V2, (_e, input: { action: 'finalize' | 'reopen' | 'retry' | 'recover' | 'configure-automation' | 'finalize-completed'; batchId: string; newBatchId?: string; reason?: string; snapshot?: Record<string, unknown>; caseIds?: string[]; mode?: import('@profer/shared').BatchAutomationMode; confirmed?: boolean }) => {
    if (!input || typeof input.batchId !== 'string' || !input.batchId) throw new Error('无效批次操作')
    const { reopenBatch, retryBatchCases, recoverInterruptedBatch } = require('./batch-store') as typeof import('./batch-store')
    // Legacy free-form renderer snapshots are NOT authoritative decisions.
    // Use the central verified finalization service instead.
    if (input.action === 'finalize') throw new Error('原始快照定稿入口已禁用，请使用核验并定稿')
    if (input.action === 'reopen') return reopenBatch(input.batchId, input.newBatchId ?? `${input.batchId}-r${Date.now().toString(36)}`, input.reason ?? '人工重开')
    if (input.action === 'retry') return retryBatchCases(input.batchId, input.caseIds ?? [])
    if (input.action === 'recover') return recoverInterruptedBatch(input.batchId)
    if (input.action === 'configure-automation') {
      const { configureBatchAutomation } = require('./batch-store') as typeof import('./batch-store')
      if (!input.mode) throw new Error('需要指定批次自动化策略')
      return configureBatchAutomation(input.batchId, input.mode, input.confirmed === true)
    }
    if (input.action === 'finalize-completed') {
      const { finalizeCompletedBatch } = require('./batch-automation-service') as typeof import('./batch-automation-service')
      return finalizeCompletedBatch(input.batchId)
    }
    throw new Error('未知批次操作')
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BATCH_AUTO_PROCESS_V2, (_e, batchId: string) => {
    if (typeof batchId !== 'string' || !batchId) throw new Error('参数 batchId 非法')
    const { runBatchAutomation } = require('./batch-automation-service') as typeof import('./batch-automation-service')
    return runBatchAutomation(batchId)
  })
  // Local-human batch group operation. The backend recomputes the preview and
  // reruns each case's existing transaction guards; the renderer supplies no actor.
  ipcMain.handle(REVIEW_IPC_CHANNELS.BATCH_GROUP_PREVIEW_V2, (_e, input: import('@profer/shared').BatchGroupActionRequest) => {
    const { previewBatchGroupAction } = require('./batch-group-action-service') as typeof import('./batch-group-action-service')
    return previewBatchGroupAction(input)
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.BATCH_GROUP_APPLY_V2, (_e, input: import('@profer/shared').BatchGroupApplyRequest) => {
    const { applyBatchGroupAction } = require('./batch-group-action-service') as typeof import('./batch-group-action-service')
    return applyBatchGroupAction(input)
  })

  ipcMain.handle(REVIEW_IPC_CHANNELS.LIST_CASES_V2, () => {
    const { listAggregatesV2 } = require('./case-store-v2') as typeof import('./case-store-v2')
    return listAggregatesV2()
  })

  // ===== G01：材料登记与提交 =====
  ipcMain.handle(REVIEW_IPC_CHANNELS.PICK_REGISTER_MATERIAL_V2, async (_e, input: { caseId: string; role: 'application' | 'evidence' | 'rule' | 'attachment'; materialSlotId?: string }) => {
    if (!input?.caseId) throw new Error('参数 caseId 非法')
        const { BrowserWindow, dialog } = require('electron') as typeof import('electron')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const aggregate = getCaseV2Aggregate(input.caseId)
    if (!aggregate) throw new Error(`案卷不存在: ${input.caseId}`)
    // 逐文件读取聚合 revision 串行登记（事务天然串行；对话框一次性返回多选）
    const actor = { actorId: 'local-user', actorSource: 'local' as const, role: 'reviewer' as const }
    const { registerMaterial } = require('./material-service') as typeof import('./material-service')
    const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    const versionIds: string[] = []
    for (const sourcePath of result.filePaths) {
      const fresh = getCaseV2Aggregate(input.caseId)!
      const outcome = (await registerMaterial(input.caseId, {
        requestId: `reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        actor,
        expectedRevision: fresh.caseV2.revision,
        payload: { sourcePath, role: input.role, materialSlotId: input.materialSlotId },
      })) as { ok: boolean; message?: string }
      if (!outcome.ok) throw new Error(outcome.message ?? '登记失败')
      const updated = getCaseV2Aggregate(input.caseId)!
      versionIds.push(updated.caseV2.documents[updated.caseV2.documents.length - 1]!.versionId)
    }
    return versionIds
  })
  // 拖拽登记：渲染层经 webUtils.getPathForFile 拿到本地路径后逐个登记（同一事务链）
  ipcMain.handle(REVIEW_IPC_CHANNELS.REGISTER_MATERIAL_PATH_V2, async (_e, input: { caseId: string; sourcePath: string; role: 'application' | 'evidence' | 'rule' | 'attachment'; materialSlotId?: string; fileName?: string; replacesVersionIds?: string[] }) => {
    if (!input || typeof input.sourcePath !== 'string' || !input.sourcePath) throw new Error('参数 sourcePath 非法')
    if (input.fileName !== undefined) {
      const { basename } = require('node:path') as typeof import('node:path')
      if (typeof input.fileName !== 'string' || !input.fileName || basename(input.fileName) !== input.fileName) throw new Error('参数 fileName 非法')
    }
    if (input.replacesVersionIds !== undefined && (!Array.isArray(input.replacesVersionIds) || input.replacesVersionIds.some((value) => typeof value !== 'string'))) throw new Error('参数 replacesVersionIds 非法')
    const { registerMaterial } = require('./material-service') as typeof import('./material-service')
    const { getCaseV2Aggregate } = require('./application-service') as typeof import('./application-service')
    const fresh = getCaseV2Aggregate(input.caseId)
    if (!fresh) throw new Error(`案卷不存在: ${input.caseId}`)
    const actor = { actorId: 'local-user', actorSource: 'local' as const, role: 'reviewer' as const }
    const outcome = await registerMaterial(input.caseId, {
      requestId: `reg-drop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      actor,
      expectedRevision: fresh.caseV2.revision,
      payload: {
        sourcePath: input.sourcePath,
        role: input.role,
        materialSlotId: input.materialSlotId,
        ...(input.fileName ? { fileName: input.fileName } : {}),
        ...(input.replacesVersionIds ? { replacesVersionIds: input.replacesVersionIds } : {}),
      },
    })
    if (!outcome.ok) throw new Error(outcome.message ?? '登记失败')
    return outcome.entity?.versionId ?? outcome.aggregate.caseV2.documents.at(-1)?.versionId
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SUBMIT_CASE_V2, (_e, caseId: string) => {
    if (typeof caseId !== 'string' || !caseId) throw new Error('参数 caseId 非法')
    const { submitCaseV2 } = require('./stage-workflow') as typeof import('./stage-workflow')
    return submitCaseV2(caseId)
  })

  /** 删除案卷 */
  ipcMain.handle(REVIEW_IPC_CHANNELS.DELETE_CASE, (_event, caseId: string): void => {
    deleteCase(caseId)
  })

  // ===== AI 生成（左/中栏）=====

  /** 生成规则大纲（左栏；无出口时降级返回 fixture 大纲） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.GENERATE_RULE_OUTLINE,
    async (_event, request: GenerateRuleOutlineRequest): Promise<RuleOutlineItem[]> => {
      const outline = await generateRuleOutline(request)
      await syncWorkspaceProjectionV2(request.caseId)
      return outline
    },
  )

  /** 识别可审核条目（中栏；无出口时降级返回已有条目） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.EXTRACT_ITEMS, async (_event, caseId: string): Promise<ReviewItem[]> => {
    const items = await extractItems(caseId)
    await syncWorkspaceProjectionV2(caseId)
    return items
  })

  // ===== 审核运行（右栏）=====

  /**
   * 执行审核运行。
   *
   * 引擎选择：网关可用 → 'ai'（内部失败仍会降级 mock）；
   * 网关不可用 → 直接走确定性模拟引擎（决策 D6，保证离线可演示）。
   */
  ipcMain.handle(REVIEW_IPC_CHANNELS.RUN_REVIEW, (_event, caseId: string): Promise<ReviewRun> => {
    const engine = getReviewModelGatewayStatus().available ? 'ai' : 'mock-engine'
    return startReviewRun(caseId, engine)
  })

  /** 查询单次运行状态 */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.GET_RUN,
    (_event, input: { caseId: string; runId: string }): ReviewRun | undefined => {
      return startReviewRunLookup(input)
    },
  )

  // ===== 审核助手 =====

  /** 助手对话（无出口时降级静态解答 degraded:true） */
  ipcMain.handle(
    REVIEW_IPC_CHANNELS.ASSISTANT_CHAT,
    (_event, request: AssistantChatRequest): Promise<{ content: string; references: string[]; degraded: boolean }> => {
      if (!request || typeof request !== 'object') throw new Error('参数 request 缺失或类型非法')
      if (!Array.isArray(request.history)) throw new Error('参数 history 必须是消息数组')
      // 只允许 user/assistant 角色（阻断渲染层伪造 system 消息的提示词注入面）
      const history = request.history.filter(
        (message) => !!message && (message.role === 'user' || message.role === 'assistant'),
      )
      return reviewAssistantChat({ ...request, history })
    },
  )

  // ===== 报告与网关自检 =====

  /** 导出预审报告（JSON + Markdown） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.EXPORT_REPORT, (_event, caseId: string): Promise<ExportReportResult> => {
    return exportReport(caseId)
  })

  /** 查询当前可用模型出口（白名单自检） */
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_MODEL_GATEWAY_STATUS, (): ReviewModelGatewayStatus => {
    return getReviewModelGatewayStatus()
  })

  /** 审核模块使用自己的 Agent 模型选择；密钥仍由全局渠道配置管理。 */
  ipcMain.handle(REVIEW_IPC_CHANNELS.GET_MODULE_SETTINGS_V2, (): ReviewModuleSettingsV2 => {
    const { getReviewModuleSettings } = require('./module-settings-store') as typeof import('./module-settings-store')
    return getReviewModuleSettings()
  })
  ipcMain.handle(REVIEW_IPC_CHANNELS.SAVE_MODULE_SETTINGS_V2, (_event, input: ReviewModuleSettingsV2): ReviewModuleSettingsV2 => {
    if (!input || typeof input !== 'object' || !('agentModelSelection' in input)) throw new Error('审核设置参数非法')
    const selection = input.agentModelSelection
    if (selection !== null) {
      if (!selection || typeof selection !== 'object'
        || typeof selection.channelId !== 'string' || !selection.channelId
        || typeof selection.modelId !== 'string' || !selection.modelId) {
        throw new Error('审核模型选择参数非法')
      }
      const { listChannels } = require('../channel-manager') as typeof import('../channel-manager')
      const channel = listChannels().find((candidate) => candidate.id === selection.channelId)
      if (!channel || channel.enabled !== true || !(REVIEW_MODEL_PROVIDERS as readonly string[]).includes(channel.provider)) {
        throw new Error('审核渠道不可用，请选择已启用的 OpenAI 兼容或本地模型渠道')
      }
      if (!channel.models?.some((model) => model.id === selection.modelId && model.enabled !== false)) {
        throw new Error('审核模型不可用，请选择该渠道中已启用的模型')
      }
    }
    const { saveReviewModuleSettings } = require('./module-settings-store') as typeof import('./module-settings-store')
    return saveReviewModuleSettings({ agentModelSelection: selection })
  })

  console.log('[审核专区] IPC 处理器注册完成')
}

/** GET_RUN 的实现（独立函数，避免 handler 内联依赖） */
function startReviewRunLookup(input: { caseId: string; runId: string }): ReviewRun | undefined {
  // 延迟 import 避免与 startReviewRun 的命名耦合；直接复用 run-service 查询
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- 主进程内同步查询，无需动态加载
  const { getRun } = require('./run-service') as typeof import('./run-service')
  return getRun(input.caseId, input.runId)
}

// saveCase 供后续"案卷修正写回"迭代使用；runAiReview 由 run-service 调用，此处不直接使用
void saveCase
void runAiReview
