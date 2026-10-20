/**
 * C-owned renderer entry for B's actual B1 candidate author and Main IPC.
 * The saved B1 revision survives app restart; no school publication is implied.
 */
import * as React from 'react'
import { ReviewV3AuthorWizard, emptyB1AuthorDocument } from '../review-v3-dev-b/ReviewV3AuthorWizard'
import type { B1AuthorDocument } from '../../../main/lib/review/review-template-plan-adapter-v3-b1'
import type { B1CandidateReadResponse } from '../review-v3-dev-b/review-v3-author-revision-read'

export function ReviewV3LocalCandidateWorkbench():React.ReactElement {
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
  const start=():void=>{
    if(loaded && !window.confirm('新建编辑器会舍弃尚未保存的修改，确定继续？'))return
    setLoaded(null);setKey(k=>k+1);setError('');setMessage('本地未发布候选草稿')
  }
  return <div className="mx-auto max-w-5xl space-y-4 px-4 pb-8">
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
