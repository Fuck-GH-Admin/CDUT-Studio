import { expect, test } from 'bun:test'
import type { CaseAggregateV2, ReviewRunV2, TemplateVersion } from '@profer/shared'
import { makeT08CaseReport } from './review-v3-t08-case-report'

test('T08 student report renders public field key-values, not object placeholders or internal fields', () => {
  const aggregate = {
    caseV2: {
      id: 'case-report-1',
      documents: [],
      subjects: [{ id: 'subject-1', title: '事项 A', fields: {
        publicNote: { value: '申请完成' },
        internalNote: { value: '内部核验说明' },
      } }],
    },
    decisions: [],
    dispositions: [],
    supplements: [],
  } as unknown as CaseAggregateV2
  const run = {
    id: 'run-report-1',
    caseId: 'case-report-1',
    inputManifest: { hash: 'manifest-1', documentVersions: [] },
    status: 'completed',
    templateId: 'template-1',
    templateVersion: 1,
    coverage: { effectiveVerdicts: 0, plannedChecks: 0, pendingChecks: 0 },
    checks: [],
    opinions: [],
  } as unknown as ReviewRunV2
  const template = {
    fields: [
      { key: 'publicNote', visibility: 'public' },
      { key: 'internalNote', visibility: 'internal' },
    ],
  } as unknown as TemplateVersion
  const student = makeT08CaseReport({ aggregate, run, template, audience: 'student', stale: false })
  expect(student.markdown).toContain('publicNote：申请完成')
  expect(student.markdown).not.toContain('[object Object]')
  expect(student.markdown).not.toContain('内部核验说明')
  expect(student.json).not.toContain('internalNote')
  const reviewer = makeT08CaseReport({ aggregate, run, template, audience: 'reviewer', stale: false })
  expect(reviewer.markdown).toContain('internalNote：内部核验说明')
})
