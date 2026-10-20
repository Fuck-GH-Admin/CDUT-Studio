/**
 * R30–R32 B-owned, genuinely operable multi-step UI on top of the existing
 * B1 author wizard and B3 route panel. C Main owns all trusted reads/writes.
 * Absent connector => honest "not installed", never a fixture disguised as
 * a real School/Principal/Case. The user can still inspect explicit blockers.
 */
import { useEffect,useRef,useState,type ReactNode } from 'react'
import {
 buildB32ProductView,pageB32Checks,pageB32Issues,assertB32StillCurrent,
 type B32ProductRead,type B29HumanAuthorIntent,type B29UnmatchedAuthorDraft,
} from './review-v3-product-workflow'
import type { B26IssueKind } from '../../../main/lib/review/review-v3-b4-bulk-evidence-workbench'
import type { B3RouteState } from '../../../main/lib/review/review-intake-routing-adapter-v3-b3'
import type { B1AuthorDocument } from '../../../main/lib/review/review-template-plan-adapter-v3-b1'
import { prepareB33PristineReopenLookup } from './review-v3-b33-author-reopen'

export interface B32ProductPorts {
 /** C Main read: B30 complete materials + B20 author/Source + B27 + B26. */
 onReadCurrent?:()=>Promise<B32ProductRead>
 /** C Main must recheck current B2 full set before constructing R29. */
 onPrepareUnmatchedDraft?:(intent:B29HumanAuthorIntent)=>Promise<B29UnmatchedAuthorDraft>
 /** Technical proposal, never a school/Case/Run/SourceLedger mutation. */
 onProposeRemediation?:(request:{
  issueId:string;currentSnapshot:string;observation:string;
  candidateOnly:true;businessWriteAllowed:false
 })=>Promise<void>
}
export interface ReviewV3ProductWorkspaceProps {
 scope:string;caseCandidateId:string
 route:B3RouteState
 ports:B32ProductPorts
 renderRoute:(onOpenAuthor:()=>void,route:B3RouteState)=>ReactNode
 renderAuthor:(draft:B1AuthorDocument|undefined)=>ReactNode
 canReadLatestAuthor?:boolean
}
type Tab='materials'|'routing'|'checks'|'sources'|'author'
const btn='rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40'
const field='w-full rounded border border-border bg-background px-2 py-2 text-sm'
const visibleRole=(role:string):string=>role==='application'?'申请材料':
 role==='supporting'?'支撑材料':'未分配用途'
const kindNames:Record<B26IssueKind,string>={
 ORIGINAL_RAW_NOT_OBSERVED:'原件字节未复核',
 ORIGINAL_VERSION_CONFLICT:'原件版本冲突',
 UNVERIFIED_SOURCE_APPLICABILITY:'来源政策适用性未知',
 UNSCOPED_OBJECT_AND_CASE:'审核对象和案卷边界缺失',
 HIGH_RISK_CLAUSE_REQUIRES_INDEPENDENT_GOLD:'高风险规则缺校方独立 Gold',
}
const repairGuidance:Record<B26IssueKind,string>={
 ORIGINAL_RAW_NOT_OBSERVED:'重新取得原始文件，逐字节比对冻结 SHA256，不得用同名文件代替',
 ORIGINAL_VERSION_CONFLICT:'同时保留冻结版和现存版，由人核对差异和真实发行者',
 UNVERIFIED_SOURCE_APPLICABILITY:'复核原文段落、documentVersionId、locator、适用日期及校方发布者',
 UNSCOPED_OBJECT_AND_CASE:'明确申请对象、Subject、所办事项和逐对象适用条件',
 HIGH_RISK_CLAUSE_REQUIRES_INDEPENDENT_GOLD:'请求具备权限的学校人员独立给出正例、负例和规则有效性核对',
}
const disabled=<p className="rounded border border-amber-500/40 p-3 text-sm" role="status">
  真实 C Main/B20/B30 读接口尚未安装或当前未取得可信读取。
  本界面不会把测试数据、旧快照或候选预览当作生产审核结果。
</p>
export function ReviewV3ProductWorkspace({
 scope,caseCandidateId,route,ports,renderRoute,renderAuthor,canReadLatestAuthor=false,
}:ReviewV3ProductWorkspaceProps):ReactNode {
 const [tab,setTab]=useState<Tab>('materials')
 const [read,setRead]=useState<B32ProductRead|null>(null)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const [checkPage,setCheckPage]=useState(0)
 const [materialPage,setMaterialPage]=useState(0)
 const [reopenTemplateId,setReopenTemplateId]=useState('')
 const [sourcePage,setSourcePage]=useState(0)
 const [domain,setDomain]=useState('')
 const [issueKind,setIssueKind]=useState('')
 const [selectedIssue,setSelectedIssue]=useState('')
 const [observation,setObservation]=useState('')
 const [localEvents,setLocalEvents]=useState<string[]>([])
 const [editor,setEditor]=useState<{key:string;document:B1AuthorDocument|undefined}|null>(null)
 const [authorIntent,setAuthorIntent]=useState({
  templateId:'',name:'',purpose:'',scenario:'',objectKey:'',
  humanRequirement:'',reviewerRole:'reviewer',recordedBy:'human-author',
 })
 const currentScope=useRef(scope)
 const operation=useRef(false)
 const generation=useRef(0)
 currentScope.current=scope
 useEffect(()=>{
  generation.current+=1
  setTab('materials');setRead(null);setError('');setNotice('')
  setEditor(null);setLocalEvents([]);setSelectedIssue('')
  setCheckPage(0);setSourcePage(0);setMaterialPage(0)
 },[scope])
 const fetchCurrent=async():Promise<void>=>{
  if(!ports.onReadCurrent){setRead(null);setError('B_PRODUCT_MAIN_READ_NOT_INSTALLED');return}
  if(operation.current)return
  operation.current=true;setBusy(true);setError('');setNotice('')
  const startScope=currentScope.current,epoch=generation.current
  try{
   const result=await ports.onReadCurrent()
   if(startScope!==currentScope.current||generation.current!==epoch)return
   if(result.caseCandidateId!==caseCandidateId)
    throw new Error('B_PRODUCT_READ_DIFFERENT_CASE')
   buildB32ProductView(result)
   setRead(result);setCheckPage(0);setSourcePage(0);setMaterialPage(0)
   setNotice('当前材料/候选源已重新读取；不表示正式学校审核通过')
  }catch(e){if(startScope===currentScope.current){
   setRead(null);setError(e instanceof Error?e.message:String(e))
  }}finally{operation.current=false;if(startScope===currentScope.current)setBusy(false)}
 }
 useEffect(()=>{void fetchCurrent()},[scope,ports.onReadCurrent])
 let view:ReturnType<typeof buildB32ProductView>|null=null
 try{if(read)view=buildB32ProductView(read)}
 catch(e){view=null}
 const connected=view?.mainConnected===true
 const checks=pageB32Checks(view?.checks??[],checkPage*25)
 const materialRows=view?.materials??[]
 const materialStart=materialPage*25
 const visibleMaterials=materialRows.slice(materialStart,materialStart+25)
 const issueList=pageB32Issues(read?.historical??null,sourcePage*25,25,{
  domain:domain||undefined,kind:issueKind?issueKind as B26IssueKind:undefined,
 })
 const issue=issueList.items.find(x=>x.id===selectedIssue)||
  read?.historical?.issues.find(x=>x.id===selectedIssue)
 const recordRepair=async():Promise<void>=>{
  if(!read||!connected||!ports.onReadCurrent||!ports.onProposeRemediation||
     !issue||!observation.trim()||operation.current){
   setError('B_PRODUCT_REPAIR_PORT_OR_HUMAN_EVIDENCE_REQUIRED');return
  }
  operation.current=true;setBusy(true);setError('');setNotice('')
  const startScope=currentScope.current,epoch=generation.current
  try{
   const before=await ports.onReadCurrent()
   if(startScope!==currentScope.current||epoch!==generation.current)return
   assertB32StillCurrent(read,before)
   if(!before.historical||!before.historical.issues.some(x=>x.id===issue.id))
    throw new Error('B_PRODUCT_ISSUE_NO_LONGER_CURRENT')
   await ports.onProposeRemediation({
     issueId:issue.id,currentSnapshot:before.historical.snapshotSha256,
     observation:observation.trim(),candidateOnly:true,businessWriteAllowed:false,
   })
   // Re-read after the proposal; old preview is never marked "fixed".
   const after=await ports.onReadCurrent()
   if(startScope!==currentScope.current||epoch!==generation.current)return
   buildB32ProductView(after)
   setRead(after);setObservation('');setSelectedIssue('')
   setLocalEvents(prev=>[
    '已提交待复核技术观察：'+issue.id+'；之后已重新读取当前来源；不代表审核或 Gold 通过',
    ...prev].slice(0,50))
   setNotice('已完成技术修复提案并重新读取；UNKNOWN 只有权威证据才可真正解除')
  }catch(e){if(startScope===currentScope.current){
   setRead(null);setError(e instanceof Error?e.message:String(e))
  }}finally{operation.current=false;if(startScope===currentScope.current)setBusy(false)}
 }
 const createTemporary=async():Promise<void>=>{
  if(!read||!connected||!view?.availableForHumanAuthor||
     !ports.onPrepareUnmatchedDraft||!ports.onReadCurrent||operation.current){
   setError('B_PRODUCT_R29_MAIN_OR_SOURCE_NOT_READY');return
  }
  const intent:B29HumanAuthorIntent={...authorIntent,userConfirmedAuthoring:true}
  operation.current=true;setBusy(true);setError('');setNotice('')
  const startScope=currentScope.current,epoch=generation.current
  try{
   const fresh=await ports.onReadCurrent()
   if(startScope!==currentScope.current||epoch!==generation.current)return
   assertB32StillCurrent(read,fresh)
   if(fresh.route.status!=='unmatched')throw new Error('B_PRODUCT_MATCH_STATE_CHANGED')
   const candidate=await ports.onPrepareUnmatchedDraft(intent)
   if(startScope!==currentScope.current||epoch!==generation.current)return
   const again=await ports.onReadCurrent()
   assertB32StillCurrent(fresh,again)
   if(candidate.schemaVersion!=='review-v3-b29-unmatched-author-draft/1'||
      candidate.caseCandidateId!==caseCandidateId||
      candidate.ownerId!==again.inventory?.ownerId||
      candidate.ownerGeneration!==again.inventory.ownerGeneration||
      candidate.publicationAllowed!==false||
      candidate.businessWriteAllowed!==false||
      candidate.planCondition!=='unknown'||candidate.document.status!=='candidate-held'||
      candidate.descriptor.publicationAllowed!==false)
    throw new Error('B_PRODUCT_R29_DRAFT_UNTRUSTED')
   // A returned R29 author candidate MUST account for every current B30
   // physical original. A caller may not omit the second ZIP or swap its
   // Subject/version while keeping a plausible compiled B1 descriptor.
   const all=again.inventory.sources
   const byId=new Map(candidate.sourceCandidates.map(x=>[x.candidateId,x]))
   if(byId.size!==all.length||candidate.sourceCandidates.length!==all.length||
      all.some(original=>{
       const source=byId.get(original.candidateId)
       return !source||source.rawSha256!==original.rawSha256||
        source.documentVersionId!==original.documentVersionId||
        source.role!==original.role
      })||candidate.subjectId!==all[0]?.subjectId||
      candidate.document.sources.length!==all.length||
      candidate.descriptor.bindingDetails.some(x=>
       x.applicability!=='unknown'||x.sourceIds.length!==all.length))
     throw new Error('B_PRODUCT_R29_SOURCE_SET_INCOMPLETE_OR_CHANGED')
   setRead(again)
   setEditor({key:candidate.snapshotSha256,document:candidate.document})
   setTab('author')
   setNotice('已取得第 51 套候选草稿；可修改、保存修订、技术试跑和候选冻结，不能正式发布')
  }catch(e){if(startScope===currentScope.current)
    setError(e instanceof Error?e.message:String(e))
  }finally{operation.current=false;if(startScope===currentScope.current)setBusy(false)}
 }
 const openAuthor=():void=>{
  if(editor){setTab('author');setError('B_PRODUCT_ACTIVE_AUTHOR_MUST_SAVE_OR_BACKUP_BEFORE_SWITCH');return}
  setError('');setNotice('')
  if(read?.route.status==='unmatched'&&connected){
   setEditor(null);setTab('author')
  }else{
   setEditor({key:'manual-'+scope,document:undefined});setTab('author')
  }
 }
 return <section className="space-y-4 rounded-lg border border-border p-4"
  data-testid="review-v3-r30-r32-product-workspace">
  <header className="space-y-2">
   <h2 className="text-lg font-semibold">审核输入与候选工作台 · R30–R32</h2>
   <p className="text-sm text-muted-foreground">全量材料 → 业务匹配或临时模板 → Check×Subject×Source → UNKNOWN 处理 → 人工复核候选。所有步骤均非正式建案、审批或校规发布。</p>
   <p className="text-xs">会话 {caseCandidateId} · {connected?'Main 来源只读数据已返回（仍需 C 在 IPC 响应处复核）':'Main 未接通'} · {read?.readVersion??'无当前读取版本'}</p>
   <nav className="flex flex-wrap gap-2" aria-label="审核输入工作流">
    {([
      ['materials','1 原件'],['routing','2 匹配'],['checks','3 Check'],
      ['sources','4 来源缺口'],['author','5 作者候选'],
    ] as const).map(([id,label])=><button key={id} type="button"
     className={btn} aria-current={tab===id?'step':undefined}
     onClick={()=>setTab(id)}>{label}</button>)}
    <button type="button" className={btn} disabled={busy||!ports.onReadCurrent}
      onClick={()=>void fetchCurrent()}>重新读取当前材料与审核来源</button>
   </nav>
  </header>
  {busy&&<p role="status" className="text-sm">正在执行来源读取或候选请求…</p>}
  {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}
  {!connected&&disabled}
  <div hidden={tab!=='materials'} className="space-y-3">
   <h3 className="font-semibold">全部已暂存原件 · {view?.totalStaged??0}</h3>
   <p className="text-xs text-muted-foreground">ZIP 内每个已暂存条目均独立列出，不能只显示第一份材料。文件 SHA 为技术原字节身份，不是学校盖章。</p>
   <p className="text-sm">申请材料 {view?.applications??0} · ZIP 条目 {view?.zipEntries??0} · 未分配用途 {view?.unassigned??0}</p>
   {view?.warnings.map(w=><p key={w} className="rounded border border-border p-2 text-sm" role="status">{w}</p>)}
   <div className="max-h-80 space-y-2 overflow-y-auto">
    {visibleMaterials.map(m=><article key={m.candidateId} className="rounded border border-border p-3 text-sm">
     <strong>{m.fileName}</strong> · {visibleRole(m.role)} · {m.sourceType==='ZIP_ENTRY'?'ZIP 原件条目':'直接材料'}
     <p>Subject：{m.subjectId??'尚未确认'} · 版本：{m.documentVersionId}</p>
     <p className="break-all text-xs text-muted-foreground">原字节 SHA256：{m.rawSha256}</p>
     <p className="text-xs">{m.reviewReason}</p>
    </article>)}
   </div>
   <div className="flex items-center gap-3 text-sm">
    <button className={btn} disabled={materialPage===0} onClick={()=>setMaterialPage(p=>p-1)}>上一页</button>
    原件第 {materialPage+1} 页 · 当前页 {visibleMaterials.length} / 总 {materialRows.length} 项
    <button className={btn} disabled={materialStart+25>=materialRows.length} onClick={()=>setMaterialPage(p=>p+1)}>下一页</button>
   </div>
   {view?.totalStaged===0&&<p>当前没有可验证的完整暂存集合，不会推断出申请主体。</p>}
  </div>
  <div hidden={tab!=='routing'} className="space-y-3">
   {renderRoute(openAuthor,read?.route??route)}
  </div>
  <div hidden={tab!=='checks'} className="space-y-3">
   <h3 className="font-semibold">当前 Check × 目标 × 对象 × Subject × Source</h3>
   {read?.readiness&&<div className="rounded border border-border p-3 space-y-1 text-sm" role="status">
    <strong>候选处理优先事项（技术候选，不得自动审批）</strong>
    <p>路由：{read.readiness.technicalRoutingReady?'技术候选已形成':'仍须人工确认'} · 当前来源：{read.readiness.technicalSourcesLinked?'仅技术来源相连':'需复核原件/解析/角色'}</p>
    {read.readiness.actions.slice(0,20).map((a,i)=><p key={i} className="text-xs">{a.action}: {a.reason} · Check {a.checkKey??'整案'} · Source {a.sourceId??'未知'}</p>)}
    {read.readiness.actions.length>20&&<p>其余 {read.readiness.actions.length-20} 项仍需独立复核；不能因为视图分页而清零</p>}
   </div>}
   <p className="text-sm">当前 {checks.total} 个逐对象 Check；其中 UNKNOWN 或物理来源未确认 {view?.checks.filter(x=>x.unresolved).length??0} 个。历史原文的 3,875 项 Check 与当前作者候选不是同一个业务列表。</p>
   {checks.items.map(row=><article key={row.key} className="rounded border border-border p-3 space-y-1 text-sm">
    <p className="font-medium">{row.checkKey} · {row.applicability==='unknown'?'UNKNOWN：待核业务条件':row.applicability+'（仅技术候选）'}</p>
    <p>Target {row.targetKey} · Object {row.objectKey} · Subject {row.subjectId}</p>
    {row.sources.map(s=><div key={s.sourceId} className="border-t border-border pt-1 text-xs">
     <p>SourceRef {s.sourceId} · {s.state} · {s.reason}</p>
     <p>版本 {s.documentVersionId??'未知'} · Parser {s.parseRevision??'未确认'} · Block {s.parserBlockId??'未确认'}</p>
     <p>定位：{s.locator}</p>
     <p className="break-all">字节：{s.rawSha256??'无当前来源哈希'}</p>
    </div>)}
   </article>)}
   <div className="flex items-center gap-3 text-sm">
    <button className={btn} disabled={checkPage===0} onClick={()=>setCheckPage(p=>p-1)}>上一页</button>
    第 {checkPage+1} 页 · 共 {checks.total} 项
    <button className={btn} disabled={checks.nextOffset===null} onClick={()=>setCheckPage(p=>p+1)}>下一页</button>
   </div>
  </div>
  <div hidden={tab!=='sources'} className="space-y-3">
   <h3 className="font-semibold">历史来源和人工复核工作台</h3>
   <p className="text-sm">冻结原文已核 49/50，G08-T03 原件仍缺；历史 UNKNOWN 来源 4,163、G01 范围 34、高风险规则独立 Gold 未完成。观察材料不会使这些状态自动归零。</p>
   <p className="text-xs">当前工作台有 {read?.historical?.issues.length??0} 项待核记录（无 B26 接入时不假报为空）。</p>
   {read?.historical&&<div className="flex flex-wrap gap-2 text-xs" role="status">
    {Object.entries(kindNames).map(([id,label])=><span key={id} className="rounded border border-border p-2">{label}：{read.historical!.issues.filter(x=>x.kind===id).length}</span>)}
   </div>}
   <div className="flex flex-wrap gap-2">
    <select aria-label="领域过滤" className={field} value={domain} onChange={e=>{setDomain(e.target.value);setSourcePage(0);setSelectedIssue('')}}>
     <option value="">所有领域</option>
     {['G01','G02','G03','G04','G05','G06','G07','G08'].map(x=><option key={x} value={x}>{x}</option>)}
    </select>
    <select aria-label="缺口类型" className={field} value={issueKind} onChange={e=>{setIssueKind(e.target.value);setSourcePage(0);setSelectedIssue('')}}>
     <option value="">全部原因</option>
     {Object.entries(kindNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}
    </select>
   </div>
   <p>筛选后 {issueList.total} 条，按任务粒度分页展示。</p>
   {issueList.items.map(x=><button key={x.id} type="button" className="block w-full rounded border border-border p-3 text-left text-sm hover:bg-muted"
    onClick={()=>{setSelectedIssue(x.id);setObservation('')}}>
    <strong>{x.domain} · {x.templateId} · {kindNames[x.kind]}</strong>
    <p>{x.checkId??'整个模板'} · {x.sourceId??x.ruleId??'无明细来源'}</p>
    <p>{x.reason} · {x.state}</p>
   </button>)}
   <div className="flex items-center gap-3 text-sm">
    <button className={btn} disabled={sourcePage===0} onClick={()=>setSourcePage(p=>p-1)}>上一页</button>
    第 {sourcePage+1} 页
    <button className={btn} disabled={issueList.nextOffset===null} onClick={()=>setSourcePage(p=>p+1)}>下一页</button>
   </div>
   {issue&&<div className="space-y-2 rounded border border-border p-3">
    <h4 className="font-semibold">修复任务：{kindNames[issue.kind]}</h4>
    <p className="text-sm">Check：{issue.checkId??'模板原文'}；SourceRef：{issue.sourceId??'无'}；规则：{issue.ruleId??'无'}</p>
    <p className="text-sm">推荐处理：{repairGuidance[issue.kind]}</p>
    <textarea aria-label="人工证据观察说明" className={field} rows={3} value={observation}
      onChange={e=>setObservation(e.target.value)} placeholder="填写证据版本、定位、Subject 或校方核验动作；不会自动关闭 UNKNOWN"/>
    <button type="button" className={btn}
     disabled={busy||!ports.onProposeRemediation||!ports.onReadCurrent||!connected||!observation.trim()}
     onClick={()=>void recordRepair()}>提交技术观察并重新读取（不作学校审批）</button>
    {!ports.onProposeRemediation&&<p className="text-xs">人工修复持久化接口未安装；本界面不会虚构处理历史。</p>}
   </div>}
   {localEvents.length>0&&<div className="space-y-1">
    <h4 className="font-medium">本次会话的操作回执（非持久业务历史）</h4>
    {localEvents.map((event,i)=><p key={i} className="text-xs">{event}</p>)}
   </div>}
  </div>
  <div hidden={tab!=='author'} className="space-y-3">
   <h3 className="font-semibold">第 51 套自建候选 / 既有 B1 编辑器</h3>
   {!editor&&<div className="space-y-2 rounded border border-border p-3">
    <p className="text-sm">仅当完整真实材料确实 unmatched，且用户主动确认时，才能从本批材料生成独立候选。模板名称、目的、对象、条件、Check 均可在生成后继续使用原有 B1 编辑器修改。</p>
    {([
     ['templateId','候选模板 ID'],['name','名称'],['purpose','审核目的'],
     ['scenario','业务场景'],['objectKey','本次审核对象'],
     ['humanRequirement','待核 Check 内容'],
     ['reviewerRole','人工复核角色'],
    ] as const).map(([key,label])=><label key={key} className="block text-sm">{label}
     <input className={field} value={authorIntent[key]}
      onChange={e=>setAuthorIntent(p=>({...p,[key]:e.target.value}))}/>
    </label>)}
    <button className={btn} type="button"
     disabled={busy||!view?.availableForHumanAuthor||!ports.onPrepareUnmatchedDraft||!ports.onReadCurrent}
     onClick={()=>void createTemporary()}>确认生成待审核临时模板（不保存、不发布）</button>
    {!ports.onPrepareUnmatchedDraft&&<p className="text-xs">
      第 51 套真实 Main/B2 输入适配尚未接线。不能从 Renderer 填写的材料 ID 自行伪造模板来源。
    </p>}
   </div>}
   <div className="rounded border border-border p-3 space-y-2">
    <h4 className="font-medium">重开已保存的第 51 套或其它候选修订</h4>
    <p className="text-xs">仅打开未编辑的候选 ID 查询页。进入后由用户在原 B1 作者界面主动点击读取最新修订，C Main 必须验证持久作者链；不直接导入浏览器旧快照。</p>
    <label className="block text-sm">候选模板 ID
     <input className={field} value={reopenTemplateId} onChange={e=>setReopenTemplateId(e.target.value)}/>
    </label>
    <button className={btn} type="button" disabled={busy||!connected||!ports.onReadCurrent||!canReadLatestAuthor||editor!==null}
     onClick={()=>{
      try{
       if(editor!==null||!canReadLatestAuthor)throw new Error('B_PRODUCT_AUTHOR_REOPEN_NOT_AUTHORIZED_OR_ACTIVE')
       const blank=prepareB33PristineReopenLookup(reopenTemplateId)
       setEditor({key:'reopen-'+reopenTemplateId,document:blank})
       setError('');setNotice('仅打开候选修订查询页。请在 B1 作者中主动用 C Main 读取最新修订；没有自动恢复或覆盖。')
      }catch(e){setError(e instanceof Error?e.message:String(e))}
     }}>打开可信修订查询（不自动恢复）</button>
    {!canReadLatestAuthor&&<p className="text-xs">C Main 的持久作者修订读取未安装，不允许假恢复。</p>}
    {editor&&<p className="text-xs">当前作者编辑器已打开。为避免舍弃未保存修改，不能直接切换其它作者候选。</p>}
   </div>
   {/* Keep existing B1 wizard mounted across navigation to protect edits. */}
   {editor&&<div className="space-y-2">
    <p className="text-xs">草稿改动须在原 B1 编辑器明确保存、修订和冻结。刷新 Main 源不会悄悄覆盖作者编辑。</p>
    <div key={editor.key}>{renderAuthor(editor.document)}</div>
   </div>}
  </div>
  <footer className="border-t border-border pt-2 text-xs text-muted-foreground">
   所有候选只能用于技术试跑或人工复核；School Gold/Policy、C Main 可信授权、正式 Case/Plan/Run/Decision/发布一律不由此界面签发。
  </footer>
 </section>
}
