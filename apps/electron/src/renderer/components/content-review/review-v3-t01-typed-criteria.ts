/**
 * T01 author-side contract for typed template checks, independent of Main/IPC.
 *
 * The shared TemplateCriterionSpec currently has no typed numeric clause.
 * The optional deterministicConstraint property is retained by TemplateVersion JSON
 * storage and portability. Local-L owns the eventual shared DTO and trusted
 * publication/installation validation; T04 consumes these descriptors to build
 * RuleSpec/PlanBinding and to evaluate actual facts.
 */
import type { ConditionAST, FieldSpec, TemplateCriterionSpec, TemplateVersion } from '@profer/shared'

export interface T01OwnerStatement {
  kind: 'owner-statement'
  text: string
  enteredBy: string
  enteredAt: string
}

/** A check on a *confirmed* numeric case field; NOT an input-form max. */
export interface T01NumberLimit {
  schemaVersion: 1
  kind: 'field-number-limit'
  fieldKey: string
  fieldScope: 'case'
  operator: 'lte' | 'gte'
  threshold: number
  unit?: string
  ownerStatement?: T01OwnerStatement
}

export type T01CriterionWithConstraint = TemplateCriterionSpec & {
  deterministicConstraint?: T01NumberLimit
}

export interface T01PublishedNumericCheck {
  templateId: string
  templateVersion: number
  sectionId: string
  criterionId: string
  ruleId: string
  title: string
  requirement: string
  targetScope: 'case'
  constraint: Omit<T01NumberLimit, 'ownerStatement'> & { ownerStatement: T01OwnerStatement }
  policyVersionId: string
  priority: number
}

export interface T01PublishedMaterialRequirement {
  templateId: string
  templateVersion: number
  slotId: string
  sectionId?: string
  minCount: number
  requiredAt: 'submission' | 'decision'
  requiredWhen?: ConditionAST
}

export function readT01NumberLimit(criterion: TemplateCriterionSpec): T01NumberLimit | undefined {
  const raw = (criterion as T01CriterionWithConstraint).deterministicConstraint
  return raw?.kind === 'field-number-limit' ? raw : undefined
}

export function setT01NumberLimit(
  criterion: TemplateCriterionSpec,
  constraint: Omit<T01NumberLimit, 'ownerStatement'>,
): TemplateCriterionSpec {
  return {
    ...criterion,
    execution: 'deterministic',
    dataCheck: undefined,
    deterministicConstraint: { ...constraint, ownerStatement: undefined },
  } as T01CriterionWithConstraint
}

export function confirmT01NumberLimit(
  criterion: TemplateCriterionSpec,
  source: T01OwnerStatement,
): TemplateCriterionSpec {
  const constraint = readT01NumberLimit(criterion)
  if (!constraint) throw new Error('T01_NUMBER_LIMIT_REQUIRED')
  if (!source.text.trim() || !source.enteredBy.trim() || !Number.isFinite(Date.parse(source.enteredAt))) {
    throw new Error('T01_OWNER_STATEMENT_REQUIRED')
  }
  return { ...criterion, deterministicConstraint: { ...constraint, ownerStatement: source } } as T01CriterionWithConstraint
}

export function validateT01TypedCriteria(template: TemplateVersion): string[] {
  const errors: string[] = []
  for (const section of template.sections ?? []) {
    for (const criterion of section.criteria) {
      const raw = (criterion as T01CriterionWithConstraint).deterministicConstraint
      if (raw === undefined) continue
      const location = `分项「${section.name}」标准「${criterion.title}」`
      if (!raw || raw.schemaVersion !== 1 || raw.kind !== 'field-number-limit') {
        errors.push(`${location} 的确定性条件格式无法识别`)
        continue
      }
      const field: FieldSpec | undefined = template.fields.find(item =>
        item.key === raw.fieldKey && item.kind === 'number' && (item.scope ?? 'subject') === raw.fieldScope,
      )
      if (!field || raw.fieldScope !== 'case' || criterion.targetScope !== 'case') {
        errors.push(`${location} 必须引用有效的案卷级数字字段`)
      }
      if (criterion.execution !== 'deterministic' || criterion.dataCheck) {
        errors.push(`${location} 的数值条件不能同时声明其他执行方式或工作簿检查`)
      }
      if (!['lte', 'gte'].includes(raw.operator) || typeof raw.threshold !== 'number' ||
          !Number.isFinite(raw.threshold)) {
        errors.push(`${location} 的比较符或阈值无效`)
      }
      const owner = raw.ownerStatement
      if (!owner || owner.kind !== 'owner-statement' || !owner.text?.trim() ||
          !owner.enteredBy?.trim() || !Number.isFinite(Date.parse(owner.enteredAt))) {
        errors.push(`${location} 需要负责人确认依据与署名，才能作为确定性规则发布`)
      }
    }
  }
  return errors
}

/**
 * T01-to-T04 projection. Does not assert that Main has published, bound or run this
 * template. Main must load and verify the exact published version before installing.
 */
export function collectT01ConfirmedNumericChecks(template: TemplateVersion): T01PublishedNumericCheck[] {
  const errors = validateT01TypedCriteria(template)
  if (errors.length) throw new Error(`T01_RULES_NOT_CONFIRMED: ${errors.join('；')}`)
  return (template.sections ?? []).flatMap(section =>
    section.criteria.flatMap((criterion, index) => {
      const c = readT01NumberLimit(criterion)
      if (!c?.ownerStatement) return []
      return [{
        templateId: template.templateId,
        templateVersion: template.version,
        sectionId: section.id,
        criterionId: criterion.id,
        ruleId: `section-${section.id}-${criterion.id}`,
        title: criterion.title,
        requirement: criterion.requirement,
        targetScope: 'case' as const,
        constraint: { ...c, ownerStatement: c.ownerStatement },
        policyVersionId: `template-owner:${template.templateId}@${template.version}`,
        priority: section.order * 1000 + index + 1,
      }]
    }),
  )
}

/** Minimum-count material requirements for T04/Main to bind to real DocumentVersions. */
export function collectT01RequiredMaterials(template: TemplateVersion): T01PublishedMaterialRequirement[] {
  return template.materialSlots.filter(slot => slot.minCount > 0).map(slot => ({
    templateId: template.templateId,
    templateVersion: template.version,
    slotId: slot.id,
    ...(slot.sectionId ? { sectionId: slot.sectionId } : {}),
    minCount: slot.minCount,
    requiredAt: slot.requiredAt ?? 'submission',
    ...(slot.requiredWhen ? { requiredWhen: slot.requiredWhen } : {}),
  }))
}
