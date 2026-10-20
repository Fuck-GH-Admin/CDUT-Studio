import { useMemo, useState } from 'react'
import { Button } from '@profer/ui/primitives/button'
import {
  previewT06PhysicalImport, planT06PhysicalImport,
  type T06PhysicalSelection, type T06GroupChoice, type T06PhysicalCommitRequest, type T06CommitReceipt,
} from './review-v3-t06-physical-intake'

/** To be bound by L to the native picker + trusted Main case/material/batch writer. */
export interface T06PhysicalMainApi {
  pickT06PhysicalSource(input: { sourceKind: 'folder' | 'zip' }): Promise<T06PhysicalSelection | null>
  commitT06PhysicalImport(input: T06PhysicalCommitRequest): Promise<T06CommitReceipt>
}

export function ReviewV3T06PhysicalImport({
  api, templateId, templateVersion, batchName, existingCases, onCommitted,
}: {
  api?: T06PhysicalMainApi
  templateId: string
  templateVersion: number
  batchName: string
  existingCases: Array<{ caseId: string; title: string }>
  onCommitted: (receipt: T06CommitReceipt) => void
}): JSX.Element {
  const [source, setSource] = useState<T06PhysicalSelection | null>(null)
  const [stripRoot, setStripRoot] = useState(false)
  const [rootAssignments, setRootAssignments] = useState<Record<string, string>>({})
  const [decisions, setDecisions] = useState<Record<string, T06GroupChoice>>({})
  const [requestId, setRequestId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<T06CommitReceipt | null>(null)
  const preview = useMemo(() => source ? previewT06PhysicalImport(source, {
    stripCommonRoot: stripRoot, rootFileGroups: rootAssignments,
  }) : null, [source, stripRoot, rootAssignments])
  const selected = useMemo(() => Object.fromEntries((preview?.groups ?? []).map(group => [
    group.groupId, decisions[group.groupId] ?? { action: 'create', title: group.name, applicant: '' },
  ])) as Record<string, T06GroupChoice>, [preview, decisions])
  const plan = useMemo(() => preview && planT06PhysicalImport(preview, selected, {
    requestId, templateId, templateVersion, batchName,
    knownCaseIds: existingCases.map(x => x.caseId),
  }), [preview, selected, requestId, templateId, templateVersion, batchName, existingCases])

  async function pick(kind: 'folder' | 'zip'): Promise<void> {
    if (!api) return
    setPending(true); setError('')
    try {
      const next = await api.pickT06PhysicalSource({ sourceKind: kind })
      if (next) {
        setSource(next); setRequestId(crypto.randomUUID()); setReceipt(null)
        setDecisions({}); setRootAssignments({}); setStripRoot(kind === 'folder')
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  function choose(groupId: string, value: T06GroupChoice): void {
    setDecisions(old => ({ ...old, [groupId]: value })); setReceipt(null)
  }
  async function commit(): Promise<void> {
    if (!api || !plan?.request || pending) return
    setPending(true); setError('')
    try {
      const result = await api.commitT06PhysicalImport(plan.request)
      setReceipt(result); onCommitted(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <section className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-xs font-semibold">真实文件夹 / ZIP 分案入库</p>
        <p className="text-[11px] text-muted-foreground">每个子目录是一份候选案卷；先确认身份，再逐案登记真实原件和创建批次。</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" type="button" variant="outline" disabled={!api || pending} onClick={() => void pick('folder')}>选择文件夹</Button>
        <Button size="sm" type="button" variant="outline" disabled={!api || pending} onClick={() => void pick('zip')}>选择 ZIP</Button>
      </div>
    </div>
    {!api && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
      待本地 Main 接通物理来源选择与持久化事务；当前按钮不会以清单绑定冒充原件入库。
    </p>}
    {preview && <>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={stripRoot} disabled={!!receipt} onChange={e => {
          setStripRoot(e.target.checked); setDecisions({}); setReceipt(null)
        }} />忽略全部原件共有的顶层目录
      </label>
      <p className="text-xs">{preview.source.entries.length} 份原件 · {preview.groups.length} 组 · 未归属 {preview.unassignedCount}</p>
      {preview.errors.map((e, i) => <p key={i} role="alert" className="text-xs text-destructive">{e}</p>)}
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {preview.groups.map(group => {
          const choice: T06GroupChoice = selected[group.groupId] ?? { action: 'create', title: group.name, applicant: '' }
          return <div className="space-y-2 rounded border bg-background p-2" key={group.groupId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">{group.name} · {group.entries.length} 个文件</span>
              <select className="rounded border bg-background p-1 text-xs" value={choice.action} disabled={!!receipt}
                aria-label={group.name + ' 分案方式'} onChange={e => {
                  const action = e.target.value
                  choose(group.groupId, action === 'exclude' ? { action: 'exclude' } :
                    action === 'existing' ? { action: 'existing', caseId: '' } :
                    { action: 'create', title: group.name, applicant: '' })
                }}>
                <option value="create">新建案卷</option><option value="existing">绑定已有案卷</option><option value="exclude">排除</option>
              </select>
            </div>
            {group.unassigned && <label className="block text-[11px] text-amber-700 dark:text-amber-300">
              根目录文件必须明确归属，填写案卷组：
              <input value={rootAssignments[group.entries[0]?.entryId ?? ''] ?? ''} disabled={!!receipt} className="mt-1 w-full rounded border bg-background p-1"
                onChange={e => setRootAssignments(old => ({ ...old, [group.entries[0]?.entryId ?? '']: e.target.value }))}/>
            </label>}
            {choice.action === 'create' && <div className="grid gap-2 sm:grid-cols-2">
              <input className="rounded border bg-background p-1.5 text-xs" aria-label={group.name + ' 标题'}
                value={choice.title} disabled={!!receipt} placeholder="案卷标题" onChange={e => choose(group.groupId, { ...choice, title: e.target.value })}/>
              <input className="rounded border bg-background p-1.5 text-xs" aria-label={group.name + ' 申请人'}
                value={choice.applicant} disabled={!!receipt} placeholder="申请人/组织（必须确认）" onChange={e => choose(group.groupId, { ...choice, applicant: e.target.value })}/>
            </div>}
            {choice.action === 'existing' && <select className="w-full rounded border bg-background p-1.5 text-xs"
              value={choice.caseId} disabled={!!receipt} onChange={e => choose(group.groupId, { action: 'existing', caseId: e.target.value })}>
              <option value="">选择本模板版本的已有案卷</option>
              {existingCases.map(x => <option value={x.caseId} key={x.caseId}>{x.title} · {x.caseId}</option>)}
            </select>}
            <p className="truncate text-[11px] text-muted-foreground" title={group.entries.map(e => e.relativePath).join('\n')}>
              {group.entries.slice(0, 3).map(e => e.relativePath).join('；')}{group.entries.length > 3 ? '…' : ''}
            </p>
          </div>
        })}
      </div>
      {plan?.errors.map((e, i) => <p className="text-[11px] text-amber-700 dark:text-amber-300" key={i}>{e}</p>)}
      <Button type="button" size="sm" disabled={!api || !plan?.request || pending || !!receipt}
        onClick={() => void commit()}>{pending ? '处理真实原件中…' : '确认分案并创建审核批次'}</Button>
    </>}
    {receipt && <div role="status" className="space-y-1 text-xs">
      <p>完成 {receipt.cases.filter(x => x.status === 'done').length} 案；
        失败 {receipt.cases.filter(x => x.status === 'failed').length} 案。</p>
      {receipt.batchId ? <p>已创建批次：{receipt.batchId}</p> : <p>批次未创建：{receipt.batchError ?? '没有完整导入的案卷'}</p>}
      {receipt.cases.some(x => x.status === 'failed') && <p className="text-amber-700 dark:text-amber-300">部分案卷可能已写入材料；请查看现存案卷再重新选取原件，避免把同一批次当作全新导入。</p>}
      {receipt.cases.filter(x => x.status === 'failed').map(x => <p key={x.groupId} className="text-destructive">
        {x.groupId}：{x.error}（已登记 {x.documents.length} 份，后续可恢复）</p>)}
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}
