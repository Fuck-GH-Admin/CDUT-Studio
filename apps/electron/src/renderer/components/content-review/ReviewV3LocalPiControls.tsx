/**
 * C local native Case -> existing genuine V2/Pi background service entry.
 * The Main service decides whether the selected Case/Plan/model is eligible.
 * A RUNNING technical phase is never a business Check PASS or C11 Host receipt.
 */
import * as React from 'react'
import type {ReviewBackgroundPiRunState} from '@profer/shared'

export function ReviewV3LocalPiControls({caseId}:{caseId:string}):React.ReactElement{
  const [state,setState]=React.useState<ReviewBackgroundPiRunState|null>(null)
  const [busy,setBusy]=React.useState(false)
  const [error,setError]=React.useState('')
  const [notice,setNotice]=React.useState('')
  const refresh=React.useCallback(async()=>{
    if(!caseId)return
    const value=await window.reviewAPI.getBackgroundPiReviewStateV2(caseId)
    if(value.caseId!==caseId)throw new Error('MAIN_PI_CASE_SCOPE_MISMATCH')
    setState(value)
  },[caseId])
  React.useEffect(()=>{
    setState(null);setError('');setNotice('')
    if(!caseId)return
    let live=true
    void window.reviewAPI.getBackgroundPiReviewStateV2(caseId)
      .then(x=>{if(live&&x.caseId===caseId)setState(x)})
      .catch(e=>{if(live)setError(e instanceof Error?e.message:String(e))})
    return()=>{live=false}
  },[caseId])
  const execute=async(kind:'start'|'stop'|'refresh'):Promise<void>=>{
    if(!caseId||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      if(kind==='start'){
        // Real Main creates a review-owned Pi session, authenticates model
        // configuration and persists a V2 Run/assignment before dispatch.
        const next=await window.reviewAPI.startBackgroundPiReviewV2({caseId})
        if(next.caseId!==caseId)throw new Error('MAIN_PI_START_CASE_SCOPE_MISMATCH')
        setState(next)
        setNotice('已接收 Main 后台执行回执；仅显示真实运行阶段，不代表审核通过')
      }else if(kind==='stop'){
        if(!state?.runId)throw new Error('没有 Main 当前 Run ID，不能停止未知运行')
        const next=await window.reviewAPI.stopBackgroundPiReviewV2({caseId,runId:state.runId})
        if(next.caseId!==caseId)throw new Error('MAIN_PI_STOP_CASE_SCOPE_MISMATCH')
        setState(next)
        setNotice('停止请求已由 Main 处理；实际状态以运行账本为准')
      }else{
        await refresh()
        setNotice('已重新读取 Main 实际后台 Pi 状态')
      }
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  return <section className="space-y-2 rounded border border-border p-3">
    <h3 className="text-sm font-semibold">现有真实 Pi 后台审核 · 原生案卷</h3>
    <p className="text-xs text-muted-foreground">直接调用已安装的 Main V2/Pi 会话与 Run 账本；需案卷具有实际可执行的模板/材料、并已在审核设置中配置模型。未发布候选模板、未绑定的原生草稿或失败运行不自动放行。此入口不是新 C11 物理 Host/学校审批。</p>
    <p className="text-xs">当前案卷：{caseId||'尚未创建'} · Main 阶段：{state?.phase??'未读取'}
      {' · '}Run：{state?.runId??'未创建'}
      {' · '}运行状态：{state?.runStatus??'未取得'}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded border border-border px-3 py-1 text-sm disabled:opacity-40"
        disabled={!caseId||busy} onClick={()=>void execute('start')}>使用现有 Main Pi 启动审核</button>
      <button type="button" className="rounded border border-border px-3 py-1 text-sm disabled:opacity-40"
        disabled={!caseId||busy||!state?.runId}
        onClick={()=>void execute('stop')}>停止当前真实 Run</button>
      <button type="button" className="rounded border border-border px-3 py-1 text-sm disabled:opacity-40"
        disabled={!caseId||busy} onClick={()=>void execute('refresh')}>刷新后台状态</button>
    </div>
    {notice&&<p role="status" className="text-xs">{notice}</p>}
    {error&&<p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>
}
