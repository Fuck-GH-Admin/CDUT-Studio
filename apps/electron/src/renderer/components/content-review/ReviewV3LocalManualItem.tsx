/**
 * C-owned local human Check intake for a real native Case + current document.
 * Uses the EXISTING native Case CAS and source-version checks, not a second
 * result store, synthetic technical Run or school Decision.
 */
import * as React from 'react'
import type { CaseAggregateV2 } from '@profer/shared'

export function ReviewV3LocalManualItem({caseId}:{caseId:string}):React.ReactElement{
  const [aggregate,setAggregate]=React.useState<CaseAggregateV2|null>(null)
  const [sourceVersionId,setSourceVersionId]=React.useState('')
  const [sourceBlockId,setSourceBlockId]=React.useState('')
  const [title,setTitle]=React.useState('')
  const [category,setCategory]=React.useState('人工声明')
  const [declaredScore,setDeclaredScore]=React.useState('0')
  const [busy,setBusy]=React.useState(false)
  const [notice,setNotice]=React.useState('')
  const [error,setError]=React.useState('')
  const retry=React.useRef<{signature:string;requestId:string}|null>(null)
  const sources=(aggregate?.caseV2.documents??[]).filter(doc=>
    doc.role==='application'&&doc.active!==false&&
    Number.isSafeInteger(doc.parseRevision)&&doc.parseRevision>=0)
  const chosen=sources.find(doc=>doc.versionId===sourceVersionId)
  const refresh=React.useCallback(async():Promise<void>=>{
    if(!caseId){setAggregate(null);setSourceVersionId('');return}
    const latest=await window.reviewAPI.getAggregateV2(caseId)
    if(!latest||latest.caseV2.id!==caseId)
      throw new Error('找不到本机原生案卷：'+caseId)
    setAggregate(latest)
    setSourceVersionId(current=>
      latest.caseV2.documents.some(doc=>doc.versionId===current&&doc.active!==false&&doc.role==='application')
        ? current
        : latest.caseV2.documents.find(doc=>doc.role==='application'&&doc.active!==false)?.versionId??'')
    setSourceBlockId('')
  },[caseId])
  React.useEffect(()=>{
    let mounted=true
    setAggregate(null);setError('');setNotice('');retry.current=null
    if(!caseId)return
    void window.reviewAPI.getAggregateV2(caseId).then(latest=>{
      if(!mounted)return
      setAggregate(latest??null)
      setSourceVersionId(latest?.caseV2.documents.find(doc=>doc.role==='application'&&doc.active!==false)?.versionId??'')
    }).catch(e=>{if(mounted)setError(e instanceof Error?e.message:String(e))})
    return()=>{mounted=false}
  },[caseId])
  const archive=async(documentId:string):Promise<void>=>{
    if(busy||!caseId||!window.confirm('归档这份材料的当前版本？原件、历史记录会保留；它支持的旧证据将失效。'))return
    setBusy(true);setError('');setNotice('')
    try{
      await window.reviewAPI.removeDocuments({caseId,role:'application',documentIds:[documentId]})
      setNotice('已归档材料当前版本。原件历史仍保留；补件请使用上方系统选择器重新导入。')
      await refresh()
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  const submit=async():Promise<void>=>{
    if(!caseId||busy||!aggregate||!chosen||!title.trim()||!category.trim())return
    const score=Number(declaredScore)
    if(!Number.isFinite(score)||score<0||score>1000000){
      setError('声明分数必须为 0 至 1000000 的有限数字');return
    }
    setBusy(true);setError('');setNotice('')
    const intent={
      documentVersionId:chosen.versionId,title:title.trim(),category:category.trim(),
      declaredScore:score,...(sourceBlockId?{sourceBlockId}:{})
    }
    const signature=JSON.stringify([caseId,intent])
    if(retry.current?.signature!==signature)
      retry.current={signature,requestId:'ui-local-manual-'+crypto.randomUUID()}
    try{
      // Always derive the revision from the CURRENT authoritative aggregate,
      // not a Renderer-owned revision counter. Native writer revalidates source.
      const fresh=await window.reviewAPI.getAggregateV2(caseId)
      if(!fresh||fresh.caseV2.id!==caseId||
         !fresh.caseV2.documents.some(doc=>
           doc.versionId===chosen.versionId&&doc.role==='application'&&
           doc.active!==false))
        throw new Error('原件已替换或案卷已变更，先刷新材料再登记')
      await window.reviewAPI.createNativeReviewItemV3({
        caseId,requestId:retry.current.requestId,
        expectedRevision:fresh.caseV2.revision,...intent,
      })
      retry.current=null
      setNotice('已通过真实原件版本登记人工声明（尚未审核认定）')
      await refresh()
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  return <section className="space-y-2 rounded-lg border border-border p-4">
    <h3 className="font-semibold">人工登记 Check / 申报事项</h3>
    <p className="text-xs text-muted-foreground">仅基于已导入的当前原件登记人工声明与来源版本。不会把模型推断、分数或申报声明当作正式审批。</p>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs">案卷 {caseId||'尚未选择'} · 原件 {sources.length} · 当前声明 {aggregate?.caseV2.subjects.length??0}</span>
      <button className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40" disabled={busy||!caseId}
        onClick={()=>void refresh().catch(e=>setError(e instanceof Error?e.message:String(e)))}>刷新当前原件</button>
    </div>
    {sources.length>0&&<div className="space-y-1">
      {sources.map(doc=><div key={doc.versionId} className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{doc.fileName} · 版本 {doc.versionId.slice(0,12)}</span>
        <button type="button" className="rounded border border-border px-2 py-1 disabled:opacity-40"
          disabled={busy} onClick={()=>void archive(doc.documentId)}>归档旧版</button>
      </div>)}
    </div>}
    <select aria-label="选用真实申请材料" className="w-full rounded border border-border bg-background p-2 text-sm" value={sourceVersionId}
      onChange={e=>{setSourceVersionId(e.target.value);setSourceBlockId('');retry.current=null}}>
      {!sources.length&&<option value="">请先导入真实申请材料</option>}
      {sources.map(doc=><option value={doc.versionId} key={doc.versionId}>{doc.fileName} · {doc.versionId.slice(0,12)}</option>)}
    </select>
    <select aria-label="原件来源定位" className="w-full rounded border border-border bg-background p-2 text-sm" value={sourceBlockId}
      onChange={e=>{setSourceBlockId(e.target.value);retry.current=null}}>
      <option value="">文件级来源（不虚构精确段落）</option>
      {(chosen?.blocks??[]).filter(block=>block.blockId&&typeof block.text==='string')
        .map(block=><option value={block.blockId} key={block.blockId}>{block.text.slice(0,80)||block.blockId}</option>)}
    </select>
    <div className="flex flex-wrap gap-2">
      <input aria-label="事项名称" className="min-w-44 flex-1 rounded border border-border bg-background p-2 text-sm"
        placeholder="如：学术竞赛获奖（待核验）" value={title} onChange={e=>setTitle(e.target.value)} />
      <input aria-label="申报类别" className="min-w-32 flex-1 rounded border border-border bg-background p-2 text-sm"
        value={category} onChange={e=>setCategory(e.target.value)} />
      <input aria-label="申报分数" type="number" min="0" max="1000000" className="w-24 rounded border border-border bg-background p-2 text-sm"
        value={declaredScore} onChange={e=>setDeclaredScore(e.target.value)} />
      <button className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        disabled={busy||!chosen||!title.trim()||!category.trim()||aggregate?.caseV2.stage!=='draft'}
        onClick={()=>void submit()}>登记真实来源人工事项</button>
    </div>
    {notice&&<p role="status" className="text-xs">{notice}</p>}
    {error&&<p role="alert" className="text-xs text-red-600">{error}</p>}
    {aggregate?.caseV2.stage!=='draft'&&<p className="text-xs text-muted-foreground">当前不是可编辑草稿，不能新增事项，请走正式变更或重审流程。</p>}
  </section>
}
