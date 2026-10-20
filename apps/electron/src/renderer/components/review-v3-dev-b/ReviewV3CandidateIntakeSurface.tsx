/**
 * B1+B3 independent candidate workspace: visible review of 20s routing and
 * a no-code author entry. Not mounted in the C-owned Case workbench and does
 * not issue ApplyMaterial, InstallPlan, Case, Run or Policy publisher calls.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  B3ManualCatalogEntry, B3RouteState,
} from '../../../main/lib/review/review-intake-routing-adapter-v3-b3'
import { buildB3RouteView, requireB3VisibleManualChoice } from './review-v3-route-view'
import { ReviewV3AuthorWizard, type B1AuthorWizardProps } from './ReviewV3AuthorWizard'
import { ReviewV3ProductWorkspace, type B32ProductPorts } from './ReviewV3ProductWorkspace'

export interface B3TechnicalChoice {
  proposalOnly: true
  caseCandidateId: string
  sessionKey: string
  templateId: string
  templateVersion: string
}
export interface B3RoutePanelProps {
  /** Main is responsible for creating and changing this scope on every new Owner/Case. */
  caseCandidateId: string
  sessionKey: string
  route: B3RouteState
  manualCatalog: readonly B3ManualCatalogEntry[]
  /** Polling only asks Main to recompute; Renderer never decides timeout success. */
  onRequestRefresh: () => void
  onInterrupt: () => void
  onManualChoice: (choice: B3TechnicalChoice) => Promise<void> | void
  onOpenCustomAuthor: () => void
}
const action = 'rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50'
export function ReviewV3RouteReviewPanel(props:B3RoutePanelProps):ReactNode {
  const {caseCandidateId,sessionKey,route,manualCatalog}=props
  const view=buildB3RouteView(route,manualCatalog)
  const scope=sessionKey+'::'+caseCandidateId
  const scopeRef=useRef(scope)
  scopeRef.current=scope
  const refreshRef=useRef(props.onRequestRefresh)
  refreshRef.current=props.onRequestRefresh
  const [chosenKey,setChosenKey]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  useEffect(()=>{
    setChosenKey('');setBusy(false);setError('');setNotice('')
  },[scope])
  useEffect(()=>{
    if(route.status!=='countdown')return
    const handle=setInterval(()=>refreshRef.current(),500)
    return ()=>clearInterval(handle)
  },[route.status,scope])
  const options=view.eligible
  const selected=options.find(x=>JSON.stringify([x.templateId,x.templateVersion])===chosenKey)
  const manual=async():Promise<void>=>{
    if(!selected || busy)return
    const startScope=scope
    setBusy(true);setError('');setNotice('')
    try {
      const technical=requireB3VisibleManualChoice(manualCatalog,selected.templateId,selected.templateVersion)
      await props.onManualChoice({
        proposalOnly:true,caseCandidateId,sessionKey,...technical,
      })
      if(scopeRef.current===startScope)
        setNotice('已提交技术模板候选，等待 Main 对身份、材料与模板权限再次核验；尚未创建案卷')
    }catch(reason){
      if(scopeRef.current===startScope)
        setError(reason instanceof Error?reason.message:String(reason))
    }finally {
      if(scopeRef.current===startScope)setBusy(false)
    }
  }
  return <section className="space-y-4 rounded-lg border border-border p-4"
    data-testid="review-v3-b3-route-panel">
    <header className="space-y-1">
      <h2 className="text-xl font-semibold">材料业务类型确认</h2>
      <p className="text-sm font-medium">{view.heading}</p>
      <p className="text-sm text-muted-foreground">{view.guidance}</p>
      <p className="text-xs text-muted-foreground">
        状态：{route.status} · 当前输入会话：{caseCandidateId} · 仅供技术候选使用
      </p>
    </header>
    {route.status==='unmatched' && <div className="space-y-2 rounded border border-border p-3"
      role="status" aria-label="无匹配模板">
      <p className="font-medium">这批材料尚无可验证的匹配模板</p>
      <p className="text-sm text-muted-foreground">
        20 秒自动建议已停止，不会把未知业务强行套用到已有模板。
        可继续人工选择正确模板，或自行编制一份待审核候选；均不会直接建案或发布。
      </p>
      <button type="button" className={action} disabled={busy}
        onClick={props.onOpenCustomAuthor}>创建新的候选审核模板（非正式发布）</button>
    </div>}
    {route.status==='countdown' && <div className="space-y-2" role="status"
      aria-label="自动建议倒计时">
      <p>剩余约 <strong>{view.remainingSeconds} 秒</strong>；此处仅展示 Main 计算的剩余时间</p>
      <progress className="w-full" max={20} value={20-Math.min(20,view.remainingSeconds)}/>
      <button type="button" className={action} onClick={props.onInterrupt}>
        停止自动选择，改为人工确认
      </button>
    </div>}
    {route.status==='default-selected' && <div className="rounded border border-border p-3"
      role="status">
      <p>倒计时已结束。{view.suggested
        ? '技术候选：'+view.suggested.name+'（'+view.suggested.templateVersion+'）'
        : '当前建议已不可用，请人工重新选择。'}</p>
      <p className="text-xs text-muted-foreground">
        只表示路由建议，不代表已建案或审核结果。任何后续动作仍由 Main 重新授权。
      </p>
    </div>}
    <div className="space-y-2">
      <h3 className="font-semibold">人工选择已有业务模板</h3>
      <label className="block space-y-1 text-sm">
        <span>可供技术选择的模板</span>
        <select className="w-full rounded border border-border bg-background px-2 py-2"
          value={chosenKey} onChange={e=>{setChosenKey(e.target.value);setError('');setNotice('')}}>
          <option value="">请选择模板及版本</option>
          {options.map(t=><option key={JSON.stringify([t.templateId,t.templateVersion])}
            value={JSON.stringify([t.templateId,t.templateVersion])}>
            {t.name} · {t.templateVersion}
          </option>)}
        </select>
      </label>
      <button type="button" className={action} disabled={!selected||busy}
        onClick={()=>void manual()}>提交选择给 Main 再核验（不建案）</button>
      <p className="text-xs text-muted-foreground">当前展示 {options.length+view.held.length} 套候选版本；可提交 {options.length} 套，待人工复核 {view.held.length} 套。</p>
      {view.held.length>0 && <details className="rounded border border-border p-3 text-sm">
        <summary className="cursor-pointer">查看尚不可提交的 {view.held.length} 套候选（来源/政策授权待核）</summary>
        <ul className="mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-5">
         {view.held.map(item=><li key={item.templateId+'@'+item.templateVersion}>
          {item.name} · {item.templateId} · {item.templateVersion} · 待人工复核，不可直接提交
         </li>)}
        </ul>
      </details>}
      <button type="button" className={action} disabled={busy}
        onClick={props.onOpenCustomAuthor}>没有匹配模板？自建审核业务（候选）</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-500">提交失败：{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <p className="text-xs text-muted-foreground">
      所有选择均为 input-only / candidate-held 技术操作。材料角色、Subject 和政策权限不得从此界面推断。
    </p>
  </section>
}
export interface B1B3CandidateWorkspaceProps extends Omit<B3RoutePanelProps,'onOpenCustomAuthor'> {
  /** Must be wired to the Main-authenticated B1 author service before real use. */
  author:B1AuthorWizardProps
  /** R30–32 optional C Main-backed full input workbench; legacy route UI unchanged if absent. */
  product?:B32ProductPorts
}
export function ReviewV3CandidateIntakeSurface(props:B1B3CandidateWorkspaceProps):ReactNode {
  const [section,setSection]=useState<'route'|'author'>('route')
  const scope=props.sessionKey+'::'+props.caseCandidateId
  useEffect(()=>{setSection('route')},[scope])
  if(props.product)return <ReviewV3ProductWorkspace
    key={scope} scope={scope} caseCandidateId={props.caseCandidateId}
    canReadLatestAuthor={Boolean(props.author.onReadLatestCandidate)}
    route={props.route} ports={props.product}
    renderRoute={(open,liveRoute)=><ReviewV3RouteReviewPanel {...props}
      route={liveRoute} onOpenCustomAuthor={open}/>}
    renderAuthor={(draft)=><ReviewV3AuthorWizard key={scope+'::'+(draft?.templateId??'blank')}
      {...props.author} initialDraft={draft}
      initialRevision={0}/>}
  />
  if(section==='author')return <div className="space-y-3"
    data-testid="review-v3-b1-b3-author-entry">
    <button type="button" className={action} onClick={()=>setSection('route')}>
      返回材料类型确认
    </button>
    <ReviewV3AuthorWizard key={scope} {...props.author}/>
  </div>
  return <ReviewV3RouteReviewPanel key={scope} {...props} onOpenCustomAuthor={()=>setSection('author')}/>
}
