import * as React from 'react'
import type { D4ClientSelection, D4ClientTemplate, D2TargetBinding } from '@profer/shared'

/** 受控候选的场景输入；只改变案卷选择，不改写冻结作者态。 */
export function D4CaseSetup({ onChange }: { onChange: (value: D4ClientSelection | undefined) => void }): React.ReactElement {
  const [templates, setTemplates] = React.useState<D4ClientTemplate[]>([])
  const [templateId, setTemplateId] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [confirmed, setConfirmed] = React.useState(false)
  const [studentFixture, setStudentFixture] = React.useState(false)
  const [error, setError] = React.useState('')
  const template = templates.find(t => t.templateId === templateId)
  let selection: D4ClientSelection['selection'] | undefined
  try {
    const parsed = draft ? JSON.parse(draft) : undefined
    if (parsed && Array.isArray(parsed.targets) && parsed.targets.every((t: D2TargetBinding) => t && typeof t.title === 'string' && (!t.conditions || (Array.isArray(t.conditions) && t.conditions.every(c => c && typeof c.id === 'string' && typeof c.applicability === 'string'))))) selection = parsed
  } catch { /* 编辑时允许暂时不完整，禁止提交。 */ }

  React.useEffect(() => {
    let active = true
    void window.reviewAPI.listD4Templates().then(items => { if (active) setTemplates(items) })
      .catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  React.useEffect(() => {
    let value: D4ClientSelection | undefined
    try {
      const selected = JSON.parse(draft)
      if (confirmed && template && selected.templateId === template.templateId && selected.version === template.version && Array.isArray(selected.targets)) {
        value = { selection: selected, useControlledStudentFixture: studentFixture }
      }
    } catch { /* 非法 JSON 由提交状态直接提示。 */ }
    onChange(value)
  }, [draft, confirmed, studentFixture, template, onChange])

  const updateTarget = (index: number, patch: Partial<D2TargetBinding>): void => {
    if (!selection) return
    setDraft(JSON.stringify({ ...selection, targets: selection.targets.map((target, i) => i === index ? { ...target, ...patch } : target) }, null, 2))
    setConfirmed(false)
  }
  return <div className="space-y-3 rounded-lg bg-muted/40 p-3 text-sm" data-testid="d4-case-setup">
    <p className="text-amber-700 dark:text-amber-300">D4 候选 · 技术预审。初始值为受控合成示例，请逐对象核对。条件改变后须新建案卷。</p>
    <label className="block">D4 模板
      <select aria-label="D4 技术预审模板" className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={templateId} onChange={e => {
        const next = templates.find(t => t.templateId === e.target.value)
        setTemplateId(e.target.value); setDraft(next ? JSON.stringify(next.selection, null, 2) : ''); setConfirmed(false); setStudentFixture(false)
      }}>
        <option value="">选择受控 D4 候选（{templates.length} 套）…</option>
        {templates.map(t => <option key={t.templateId} value={t.templateId}>{t.domain} · {t.templateId} · {t.name}</option>)}
      </select>
    </label>
    {selection?.targets?.map((target, index) => <fieldset key={index} className="space-y-2 rounded-lg bg-background p-2">
      <legend className="px-1">对象 {index + 1} · {target.subjectId}</legend>
      <input aria-label={`对象 ${index + 1} 名称`} className="w-full rounded border bg-background p-1.5" value={target.title} onChange={e => updateTarget(index, { title: e.target.value })} />
      {target.kind === 'generic-object' && template && <>
        {template.primary.length > 0 && <label className="block">主场景（互斥）
          <select aria-label={`对象 ${index + 1} 主场景`} className="ml-2 rounded border bg-background p-1" value={target.scenario} onChange={e => updateTarget(index, { scenario: e.target.value })}>
            {template.primary.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>}
        <div className="grid grid-cols-2 gap-2">{target.conditions?.map((condition, ci) => <label key={condition.id}>{condition.id}
          <select aria-label={`对象 ${index + 1} 条件 ${condition.id}`} className="ml-1 rounded border bg-background p-1" value={condition.applicability} onChange={e => {
            const applicability = e.target.value as typeof condition.applicability
            updateTarget(index, { conditions: target.conditions!.map((c, i) => i === ci ? { ...c, applicability, decidedBy: applicability === 'unknown' ? 'undetermined' : 'reviewer' } : c) })
          }}>
            <option value="unknown">未知 · 待核</option><option value="applicable">适用</option><option value="not-applicable">不适用</option>
          </select>
        </label>)}</div>
      </>}
    </fieldset>)}
    {template && <details><summary className="cursor-pointer">对象标识与完整场景 JSON</summary>
      <textarea aria-label="D4 场景 JSON" className="mt-2 h-48 w-full rounded border bg-background p-2 font-mono text-xs" value={draft} onChange={e => { setDraft(e.target.value); setConfirmed(false) }} />
    </details>}
    {template?.controlledStudentFixture && <label className="flex gap-2"><input type="checkbox" checked={studentFixture} onChange={e => { setStudentFixture(e.target.checked); setConfirmed(false) }} />使用随包的受控合成学籍快照（姓名/证号独立字段；非正式学籍接口）</label>}
    {template && <label className="flex gap-2"><input aria-label="确认 D4 对象和条件" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对对象、场景、条件及其来源版本，按以上选择创建固定任务。</label>}
    {draft && !selection && <p role="alert" className="text-destructive">场景 JSON 格式不正确</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>
}
