/**
 * 审核模块显式路由（界面重组阶段一）。
 *
 * 目标：全局只保留「案卷 / 待办 / 审核批次 / 审核模板」四个入口，
 * 其余页面都是进入对象后的局部页。这里只表达"在哪里"，不承载业务状态；
 * 业务数据仍由 Main 与既有按案缓存提供。
 */
import { atom } from 'jotai'

export type CaseTab = 'materials' | 'checks' | 'workflow' | 'reports' | 'history'
export type BatchTab = 'cases' | 'processing' | 'rating' | 'finalization'
export type TemplateTab = 'scope' | 'requirements' | 'criteria' | 'workflow' | 'publication'

/** 对象焦点：附属于当前路由，必须自带所属案卷/批次与版本，避免依赖"上次选中了谁"。 */
export interface ReviewFocus {
  kind: 'document' | 'subject' | 'check' | 'supplement' | 'appeal' | 'run' | 'rating-task'
  caseId?: string
  batchId?: string
  id?: string
  versionId?: string
}

export type ReviewRoute =
  | { page: 'cases' }
  | { page: 'case-new'; start: 'files' | 'template' | 'blank' }
  | { page: 'case'; caseId: string; tab: CaseTab }
  | { page: 'tasks'; view: 'actionable' | 'waiting' | 'resolved' }
  | { page: 'batches' }
  | { page: 'batch-new' }
  | { page: 'batch'; batchId: string; tab: BatchTab }
  | { page: 'templates' }
  | { page: 'template-new' }
  | { page: 'template'; templateId: string; version: number; tab: TemplateTab }

/** 返回上下文：只记一层来源，不做无限嵌套返回链。 */
export interface ReviewBackContext {
  from: ReviewRoute
  /** 列表筛选/滚动等可恢复信息 */
  restore?: Record<string, unknown>
}

export const reviewRouteAtom = atom<ReviewRoute>({ page: 'cases' })
export const reviewFocusAtom = atom<ReviewFocus | null>(null)
export const reviewBackContextAtom = atom<ReviewBackContext | null>(null)

/** 全局导航的当前四项；由路由推导，不单独存状态。 */
export type ReviewGlobalNav = 'cases' | 'tasks' | 'batches' | 'templates'

export function globalNavOf(route: ReviewRoute): ReviewGlobalNav {
  switch (route.page) {
    case 'tasks': return 'tasks'
    case 'batches':
    case 'batch-new':
    case 'batch': return 'batches'
    case 'templates':
    case 'template-new':
    case 'template': return 'templates'
    default: return 'cases'
  }
}

/** 进入对象页时的局部 tab；非对象页返回 null。 */
export function localTabOf(route: ReviewRoute): string | null {
  switch (route.page) {
    case 'case': return route.tab
    case 'batch': return route.tab
    case 'template': return route.tab
    default: return null
  }
}
