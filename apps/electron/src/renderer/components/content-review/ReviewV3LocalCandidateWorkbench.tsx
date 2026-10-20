/**
 * C-owned renderer entry for B's actual B1 candidate author and Main IPC.
 * The saved B1 revision survives app restart; no school publication is implied.
 */
import * as React from 'react'
import { useSetAtom } from 'jotai'
import { reviewWorkspaceSectionAtom } from '@/atoms/review-atoms'
import { reviewV2AggregateAtom } from './V2CasePanel'
import { ReviewV3LocalManualItem } from './ReviewV3LocalManualItem'
import { ReviewV3LocalPiControls } from './ReviewV3LocalPiControls'
import { ReviewV3CandidateIntakeSurface } from '../review-v3-dev-b/ReviewV3CandidateIntakeSurface'
import type { C11MainLocalProductRead } from '../../../main/lib/review/review-v3-main-local-product-intake'
import { ReviewV3AuthorWizard, emptyB1AuthorDocument } from '../review-v3-dev-b/ReviewV3AuthorWizard'
import type { B1AuthorDocument } from '../../../main/lib/review/review-template-plan-adapter-v3-b1'
import type { B1CandidateReadResponse } from '../review-v3-dev-b/review-v3-author-revision-read'

export function ReviewV3LocalCandidateWorkbench():React.ReactElement {
  const goToCase=useSetAtom(reviewWorkspaceSectionAtom)
  const showCase=useSetAtom(reviewV2AggregateAtom)
  const [caseTitle,setCaseTitle]=React.useState('本地人工审核')
  const [caseApplicant,setCaseApplicant]=React.useState('本机用户')
  const [caseYear,setCaseYear]=React.useState(String(new Date().getFullYear()))
  const [localCaseId,setLocalCaseId]=React.useState('')
  const [savedCases,setSavedCases]=React.useState<Array<{id:string;title:string}>>([])
  const [materialsEpoch,setMaterialsEpoch]=React.useState(0)
  const [product,setProduct]=React.useState<C11MainLocalProductRead|null>(null)
  const [productError,setProductError]=React.useState('')
  const readProduct=React.useCallback(async()=>{
    if(!localCaseId)throw new Error('请先创建或选择本机案卷')
    const data=await window.reviewAPI.readLocalNativeProductV3(localCaseId)
    setProduct(data);setProductError('')
    return data.read
  },[localCaseId])
  React.useEffect(()=>{
    setProduct(null);setProductError('')
    if(!localCaseId)return
    let mounted=true
    void window.reviewAPI.readLocalNativeProductV3(localCaseId)
      .then(data=>{if(mounted)setProduct(data)})
      .catch(e=>{if(mounted)setProductError(e instanceof Error?e.message:String(e))})
    return ()=>{mounted=false}
  },[localCaseId,materialsEpoch])
  const [caseBusy,setCaseBusy]=React.useState(false)
  const [caseNotice,setCaseNotice]=React.useState('')
  const [caseError,setCaseError]=React.useState('')
  const [templateId,setTemplateId]=React.useState('')
  const [loaded,setLoaded]=React.useState<{document:B1AuthorDocument;revision:number}|null>(null)
  const [key,setKey]=React.useState(0)
  const [busy,setBusy]=React.useState(false)
  const [error,setError]=React.useState('')
  const [message,setMessage]=React.useState('')
  const readLatest=React.useCallback(async (id:string):Promise<B1CandidateReadResponse>=>{
    const response=await window.reviewAPI.readCurrentAuthorRevisionV3({templateId:id})
    return {schemaVersion:'review-b1-author-read/1',templateId:response.templateId,
      revision:response.revision,digest:response.sourceDigest,
      document:response.document as B1AuthorDocument,candidateStatus:'candidate-held'}
  },[])
  const reopen=async ():Promise<void>=>{
    if(busy)return
    if(loaded && !window.confirm('切换作者修订可能舍弃编辑器中尚未保存的修改，确定继续？'))return
    setBusy(true);setError('');setMessage('')
    try{
      const source=await readLatest(templateId.trim())
      setLoaded({document:source.document,revision:source.revision})
      setKey(k=>k+1)
      setMessage('已从 Main 重新读取本机保存的候选修订 '+source.revision)
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  const listSavedCases=async ():Promise<void>=>{
    if(caseBusy)return
    setCaseBusy(true);setCaseError('')
    try{
      const cases=await window.reviewAPI.listCases()
      setSavedCases(cases.map(item=>({id:item.id,title:item.title})))
      setCaseNotice('已列出本地已保存案卷（含只读历史）；选择后可以重新打开。')
    }catch(e){setCaseError(e instanceof Error?e.message:String(e))}
    finally{setCaseBusy(false)}
  }
  const createCase=async ():Promise<void>=>{
    if(caseBusy)return
    setCaseBusy(true);setCaseError('');setCaseNotice('')
    try{
      const created=await window.reviewAPI.createCase({
        title:caseTitle.trim(),type:'自定义审核',
        applicant:caseApplicant.trim(),academicYear:caseYear.trim(),
        reviewTemplate:null,
      })
      setLocalCaseId(created.id)
      setSavedCases([])
      setCaseNotice('本机原生案卷已创建：'+created.id+'；未绑定校方模板，请先导入材料并人工审核。')
    }catch(e){setCaseError(e instanceof Error?e.message:String(e))}
    finally{setCaseBusy(false)}
  }
  const importMaterial=async (role:'application'|'evidence'):Promise<void>=>{
    if(caseBusy||!localCaseId)return
    setCaseBusy(true);setCaseError('');setCaseNotice('')
    try{
      const imported=await window.reviewAPI.importDocument({caseId:localCaseId,role})
      if(imported.canceled){setCaseNotice('已取消选择，没有导入原件')}
      else{
        setMaterialsEpoch(x=>x+1)
        setCaseNotice((role==='application'?'申请原件':'证明材料')+'：成功导入 '+imported.documents.length+' 份；失败 '+imported.failures.length+' 份')
        if(imported.failures.length)
          setCaseError(imported.failures.map(x=>x.fileName+': '+x.message).join('；').slice(0,500))
      }
    }catch(e){setCaseError(e instanceof Error?e.message:String(e))}
    finally{setCaseBusy(false)}
  }
  const exportLocalMd=async ():Promise<void>=>{
    if(caseBusy||!localCaseId)return
    setCaseBusy(true);setCaseError('');setCaseNotice('')
    try{
      const fresh=await window.reviewAPI.getAggregateV2(localCaseId)
      if(!fresh||fresh.caseV2.id!==localCaseId)
        throw new Error('案卷不存在；请重新读取当前原生案卷')
      const exported=await window.reviewAPI.exportReportV2(localCaseId)
      setCaseNotice('已生成本地 Markdown 报告（草稿未审核不代表审批）：'+exported.file)
    }catch(e){setCaseError(e instanceof Error?e.message:String(e))}
    finally{setCaseBusy(false)}
  }
  const openCase=async ():Promise<void>=>{
    if(caseBusy||!localCaseId)return
    setCaseBusy(true);setCaseError('')
    try{
      const aggregate=await window.reviewAPI.openAggregateV2(localCaseId)
      if(!aggregate)throw new Error('未找到该原生案卷；请确认本机案卷 ID。')
      showCase(aggregate)
      goToCase('case-v2')
    }catch(e){setCaseError(e instanceof Error?e.message:String(e))}
    finally{setCaseBusy(false)}
  }
  const start=():void=>{
    if(loaded && !window.confirm('新建编辑器会舍弃尚未保存的修改，确定继续？'))return
    setLoaded(null);setKey(k=>k+1);setError('');setMessage('本地未发布候选草稿')
  }
  return <div className="mx-auto max-w-5xl space-y-4 px-4 pb-8">
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-base font-semibold">新建本地审核案卷与原件导入</h2>
      <p className="text-xs text-muted-foreground">调用已有 C 原生案卷存储与系统文件选择器。候选模板与原生案卷目前分别保存，未签学校政策，也不自动生成正式 Run。</p>
      <div className="flex flex-wrap gap-2">
        <input aria-label="本地案卷标题" value={caseTitle} onChange={e=>setCaseTitle(e.target.value)}
          className="min-w-44 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" placeholder="案卷标题"/>
        <input aria-label="申请主体" value={caseApplicant} onChange={e=>setCaseApplicant(e.target.value)}
          className="min-w-32 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" placeholder="申请主体"/>
        <input aria-label="学年" value={caseYear} onChange={e=>setCaseYear(e.target.value)}
          className="w-24 rounded border border-border bg-background px-2 py-1.5 text-sm" placeholder="学年"/>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy||!caseTitle.trim()||!caseApplicant.trim()||!caseYear.trim()}
          onClick={()=>void createCase()}>创建原生无绑定案卷</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="当前本机案卷 ID" className="min-w-44 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="本机已有案卷 ID 可直接粘贴重开" value={localCaseId} onChange={e=>setLocalCaseId(e.target.value)}/>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy} onClick={()=>void listSavedCases()}>列出本机历史案卷</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy||!localCaseId} onClick={()=>void importMaterial('application')}>选择并导入真实申请材料</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy||!localCaseId} onClick={()=>void importMaterial('evidence')}>选择并导入证明材料</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy||!localCaseId} onClick={()=>void openCase()}>打开案卷历史/人工流程</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={caseBusy||!localCaseId} onClick={()=>void exportLocalMd()}>导出本地 MD 报告</button>
      </div>
      {savedCases.length>0&&<select aria-label="从历史案卷重开" value="" 
        onChange={e=>{setLocalCaseId(e.target.value);setCaseNotice('已选择历史案卷 '+e.target.value) }}
        className="w-full rounded border border-border bg-background px-2 py-2 text-sm">
        <option value="">选择一份本机历史案卷</option>
        {savedCases.map(c=><option key={c.id} value={c.id}>{c.title} · {c.id}</option>)}
      </select>}
      {caseNotice&&<p role="status" className="text-xs">{caseNotice}</p>}
      {caseError&&<p role="alert" className="text-xs text-red-600">{caseError}</p>}
    </div>
    <div className="space-y-2 rounded-lg border border-border p-4">
      <h2 className="text-base font-semibold">本地候选审核模板 · 第 51 套</h2>
      <p className="text-xs text-muted-foreground">自定义审核目的不在既有 50 套时，可直接编辑、编译、保存和冻结候选。所有记录仅在本机，不代表校方发布、学校政策核验或正式审批。</p>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="重开候选模板 ID" className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="输入已保存模板 ID" value={templateId} onChange={e=>setTemplateId(e.target.value)} />
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50" disabled={busy||!templateId.trim()}
          onClick={()=>void reopen()}>读取本机最新修订</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={start}>新建候选</button>
      </div>
      {message&&<p role="status" className="text-xs">{message}</p>}
      {error&&<p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
    {localCaseId&&<div className="space-y-2">
      {productError&&<p role="alert" className="text-xs text-red-600">
        当前材料 Main 读取失败：{productError}（未返回候选结果）
      </p>}
      <button type="button" className="rounded border border-border px-3 py-1.5 text-sm"
        onClick={()=>void readProduct().catch(e=>setProductError(e instanceof Error?e.message:String(e)))}>
        从真实原件刷新 50+1 候选工作台
      </button>
      {product&&<ReviewV3CandidateIntakeSurface
        key={localCaseId+'-'+product.sessionKey}
        caseCandidateId={localCaseId} sessionKey={product.sessionKey}
        route={product.read.route} manualCatalog={product.catalog}
        onRequestRefresh={async()=>{await readProduct()}}
        onInterrupt={async()=>{
          const data=await window.reviewAPI.interruptLocalNativeProductV3(localCaseId)
          setProduct(data)
        }}
        onManualChoice={async choice=>{
          const ack=await window.reviewAPI.chooseLocalNativeProductTemplateV3({
            caseId:localCaseId,templateId:choice.templateId,templateVersion:choice.templateVersion})
          await readProduct()
          return ack
        }}
        author={{
          onSaveDraft:(document,expectedRevision)=>
            window.reviewAPI.saveLocalCandidateAuthorV3({document,expectedRevision}),
          onPreview:document=>window.reviewAPI.previewLocalCandidateAuthorV3({document}),
          onFreezeCandidate:(document,expectedRevision)=>
            window.reviewAPI.freezeLocalCandidateAuthorV3({document,expectedRevision}),
          onReadLatestCandidate:async id=>readLatest(id),
        }}
        product={{
          onReadCurrent:readProduct,
          onPrepareUnmatchedDraft:intent=>window.reviewAPI.prepareLocalNativeUnmatchedV3({
            caseId:localCaseId,intent,
          }),
        }}
      />}
    </div>}
    <ReviewV3LocalManualItem key={localCaseId+'-'+materialsEpoch} caseId={localCaseId} />
    <ReviewV3LocalPiControls key={localCaseId} caseId={localCaseId} />
    <ReviewV3AuthorWizard key={key} initialDraft={loaded?.document??emptyB1AuthorDocument()}
      initialRevision={loaded?.revision??0}
      onSaveDraft={(document,expectedRevision)=>
        window.reviewAPI.saveLocalCandidateAuthorV3({document,expectedRevision})}
      onPreview={document=>window.reviewAPI.previewLocalCandidateAuthorV3({document})}
      onFreezeCandidate={(document,expectedRevision)=>
        window.reviewAPI.freezeLocalCandidateAuthorV3({document,expectedRevision})}
      onReadLatestCandidate={(id)=>readLatest(id)}
    />
  </div>
}
