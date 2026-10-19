import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REVIEW_C0_SCHEMA_VERSION, REVIEW_IPC_CHANNELS, type CanonicalPlan,
  type ReviewCaseV2,
} from '@profer/shared'
import { setMainWindow } from '../main-window-state'
import { createAggregate, readAggregate } from './case-store-v2'
import { bindCanonicalPlanV3, describeRemovedPlanBindings } from './plan-binding-v3'
import { registerReviewIpc } from './review-ipc'
import {
  installCMainV3AuthorPlanAuthorities,
  type CMainV3AuthorPlanAuthorities,
} from './review-v3-main-author-plan-ipc'
import type {
  CMainB1AuthorRevision,CMainB1CandidateDocument,
} from './review-v3-main-author-revision-read'

const root=join(import.meta.dir,'../../../../../../work/tmp',`c-v3-electron-main-wire-${Date.now()}`)
process.env.PROFER_CONFIG_DIR=root
afterAll(()=>{setMainWindow(null);rmSync(root,{recursive:true,force:true})})
const handlers=(globalThis.__proferElectronTestHooks as typeof globalThis.__proferElectronTestHooks & {
  ipcMainHandlers:Map<string,(...args:unknown[])=>unknown>
}).ipcMainHandlers
const frame={processId:777,routingId:3}
const sender={id:91,mainFrame:frame,isDestroyed:()=>false}
const main={isDestroyed:()=>false,webContents:sender}
const event={sender,senderFrame:frame}
const invoke=(key:string,payload:unknown,ev:unknown=event)=>{
  const h=handlers.get(key);if(!h)throw Error('Handler not registered: '+key)
  return h(ev,payload)
}
type Draft=CMainB1CandidateDocument & {fields:string[]}
const document:Draft={schemaVersion:'review-b1/1',templateId:'template51',status:'candidate-held',fields:['a']}
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
const authorRecord=():CMainB1AuthorRevision<Draft>=>({
  schemaVersion:'review-b1-draft/1',templateId:'template51',
  revision:1,authorId:'client-author-is-untrusted',savedAt:'2026-10-20T00:00:00Z',
  document:structuredClone(document),digest:hash(JSON.stringify(document)),
})
let serial=0
function plan(id:string,n:number,full:boolean):CanonicalPlan {
  const plan:CanonicalPlan={
    schemaVersion:REVIEW_C0_SCHEMA_VERSION,planId:id+'-plan-'+n,
    fingerprint:String(n).repeat(64),templateId:'template51',templateVersion:'1',
    moduleDigests:['a'.repeat(64)],
    bindings:[{checkKey:'check-kept',targetKey:'subject:s1',objectKey:'obj1',
      subjectId:'s1',applicability:'applicable',
      sourceVersionIds:['v1'],conditionFingerprint:'d'.repeat(64)}],
  }
  if(full)plan.bindings.push({...plan.bindings[0]!,checkKey:'check-removed'})
  return plan
}
async function fixture() {
  const id='c-electron-main-plan-'+ ++serial
  const old=plan(id,1,true),next=plan(id,2,false)
  const raw=Buffer.from('real-case-source-'+id)
  const sourceDir=join(root,'review-cases',id,'source-docs','v1')
  mkdirSync(sourceDir,{recursive:true})
  writeFileSync(join(sourceDir,'original.txt'),raw)
  const now='2026-10-20T00:00:00Z'
  const rec:ReviewCaseV2={
    id,title:'User case',templateId:'template51',templateVersion:1,
    objectType:'document',caseFields:{},stage:'reviewing',revision:0,
    createdAt:now,updatedAt:now,
    subjects:[{id:'s1',type:'item',title:'A',fields:{},sourceRefs:[],
      correction:'user-confirmed',status:'identified'}],
    documents:[{documentId:'d1',versionId:'v1',contentHash:hash(raw),byteHash:hash(raw),
      role:'application',fileName:'original.txt',mimeType:'text/plain',
      sizeBytes:raw.length,assetPath:'source-docs/v1/original.txt',
      parseRevision:1,parseStatus:'parsed',blocks:[],usage:'registered',active:true}],
  }
  await createAggregate(id,rec)
  const artifacts=join(root,'issued-plan-artifacts',id)
  mkdirSync(artifacts,{recursive:true})
  const pubs=new Map<string,{sha:string;status:'published'|'revoked'}>()
  for(const pl of [old,next]){
    const bytes=Buffer.from(JSON.stringify({
      schemaVersion:'review-v3-published-plan-artifact/1',
      publicationId:'school-verified-fixture',canonicalPlan:pl,
    }))
    writeFileSync(join(artifacts,pl.fingerprint+'.json'),bytes)
    pubs.set(pl.fingerprint,{sha:hash(bytes),status:'published'})
  }
  let epoch=1,grantEnabled=true,allowedRead=true,validPublisher=true
  let readerCalls=0
  let onRead:()=>void=()=>{}
  const issued={
    artifactRoot:artifacts,
    getCurrentPublication:(p:CanonicalPlan)=>{
      const reg=pubs.get(p.fingerprint)
      return reg?{
        schemaVersion:'review-v3-plan-publication/1' as const,
        publicationId:'school-verified-fixture',issuerAuthorityId:'issuer-test',
        publishedSourceCommit:'a'.repeat(40),status:reg.status,
        fingerprint:p.fingerprint,artifactSha256:reg.sha,
      }:undefined
    },
    assertAuthorizedPublication:()=>{
      if(!validPublisher)throw Error('SCHOOL_PUBLISHER_REVOKED')
    },
  }
  const authority:CMainV3AuthorPlanAuthorities<Draft>={
    getAuthorGrant:()=>grantEnabled?{ownerId:'author-owner',generation:epoch,authorityEpoch:'author-'+epoch}:undefined,
    canReadAuthor:(principal,scope)=>allowedRead&&principal==='local-reviewer'&&scope==='template51',
    readLatestB1AuthorRevision:async()=>{readerCalls++;const doc=authorRecord();onRead();return doc},
    getCaseGrant:()=>grantEnabled?{ownerId:'case-owner',generation:epoch,authorityEpoch:'case-'+epoch}:undefined,
    canUpgradeCase:(principal,scope)=>grantEnabled&&principal==='local-reviewer'&&scope===id,
    publishedPlanSource:issued,
  }
  const install=()=>installCMainV3AuthorPlanAuthorities(authority)
  const bound=await bindCanonicalPlanV3(id,{
    requestId:'seed-'+id,actor:{actorId:'local-reviewer',actorSource:'local',role:'reviewer'},
    expectedRevision:0,payload:old,
  },(p,aggregate)=>{
    const registration=issued.getCurrentPublication(p)
    expect(registration?.status).toBe('published')
    expect(aggregate.caseV2.id).toBe(id)
  })
  expect(bound.ok).toBe(true)
  const payload={
    caseId:id,requestId:'change-'+id,expectedRevision:1,
    payload:{plan:next,previousFingerprint:old.fingerprint,
      acknowledgement:'Human confirms removal',
      removalAck:{previousFingerprint:old.fingerprint,nextFingerprint:next.fingerprint,
        acknowledgedRemovedIdentities:describeRemovedPlanBindings(old,next)}},
  }
  return {
    id,old,next,payload,install,
    changeEpoch:()=>{epoch++},
    revokeGrant:()=>{grantEnabled=false},
    revokeRead:()=>{allowedRead=false},
    revokePublisher:()=>{validPublisher=false},
    revokeOld:()=>{const e=pubs.get(old.fingerprint)!;pubs.set(old.fingerprint,{...e,status:'revoked'})},
    onRead:(fn:()=>void)=>{onRead=fn},reads:()=>readerCalls,
  }
}
describe('C-MAIN-WIRE-R01 real registered Electron Main/Preload contract',()=>{
  test('real registration and uninstalled authority reject both operations',async()=>{
    handlers.clear()
    setMainWindow(main as never)
    registerReviewIpc()
    expect(handlers.has(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3)).toBe(true)
    expect(handlers.has(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3)).toBe(true)
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,{
      templateId:'template51',
    }))).rejects.toThrow('INDEPENDENT_AUTHORITIES_NOT_INSTALLED')
    const f=await fixture()
    await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,
      f.payload))).rejects.toThrow('INDEPENDENT_AUTHORITIES_NOT_INSTALLED')
    expect(readAggregate(f.id)?.receiptLog).toHaveLength(1)
  })
  test('candidate read only through Main verified window/mainFrame and current B1 owner grant',async()=>{
    const f=await fixture(),dispose=f.install()
    try {
      const result=await invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51',expectedRevision:1}) as {state:string;displayOnly:boolean;revision:number}
      expect(result).toMatchObject({state:'candidate-held',displayOnly:true,revision:1})
      expect(f.reads()).toBe(2)
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51',actor:{role:'school'}}))).rejects.toThrow('RENDERER_CREDENTIAL_CLAIM')
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51'}, {sender,senderFrame:{...frame}}))).rejects.toThrow('SENDER_UNTRUSTED')
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51'}, {sender:{...sender},senderFrame:frame}))).rejects.toThrow('SENDER_UNTRUSTED')
      f.revokeRead()
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51'}))).rejects.toThrow('NOT_AUTHORIZED')
    }finally{dispose()}
  })
  test('async Owner rotation blocks author read after B1 full history await',async()=>{
    const f=await fixture(),dispose=f.install()
    try{
      f.onRead(()=>f.changeEpoch())
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,
        {templateId:'template51'}))).rejects.toThrow('MAIN_CONTEXT_REVOKED')
    }finally{dispose()}
  })
  test('real published source and old/new physical Case bytes produce one durable UpgradePlan Receipt',async()=>{
    const f=await fixture(),dispose=f.install()
    try{
      const good=await invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,f.payload) as {ok:boolean}
      expect(good.ok).toBe(true)
      const snapshot=readAggregate(f.id)!
      expect(snapshot.caseV2.revision).toBe(2)
      expect(snapshot.canonicalPlan?.fingerprint).toBe(f.next.fingerprint)
      expect(snapshot.canonicalPlanHistory?.[0]?.fingerprint).toBe(f.old.fingerprint)
      expect(snapshot.receiptLog).toHaveLength(2)
      const replay=await invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,f.payload) as {ok:boolean}
      expect(replay.ok).toBe(true)
      expect(readAggregate(f.id)?.receiptLog).toHaveLength(2)
      const collision=await invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,{
        ...f.payload,payload:{...f.payload.payload,acknowledgement:'different'},
      }) as {ok:boolean;code:string}
      expect(collision).toMatchObject({ok:false,code:'REQUEST_ID_COLLISION'})
    }finally{dispose()}
  })
  test('renderer fake principal, revoked Main grant, or removed old publication never write Case',async()=>{
    const f=await fixture(),dispose=f.install()
    try{
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,{
        ...f.payload,principal:{role:'school'},
      }))).rejects.toThrow('RENDERER_CREDENTIAL_CLAIM')
      expect(readAggregate(f.id)?.receiptLog).toHaveLength(1)
      f.revokeGrant()
      await expect(Promise.resolve(invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,
        f.payload))).rejects.toThrow('TRUSTED_GRANT_UNAVAILABLE')
      f.revokeOld()
      expect(readAggregate(f.id)?.receiptLog).toHaveLength(1)
    }finally{dispose()}
    const g=await fixture(),other=g.install()
    try{
      g.revokeOld()
      const denied=await invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,g.payload) as {ok:boolean}
      expect(denied.ok).toBe(false)
      expect(readAggregate(g.id)?.receiptLog).toHaveLength(1)
    }finally{other()}
  })
  test('removed Check not acknowledged cannot convert candidate UI confirm into formal Case write',async()=>{
    const f=await fixture(),dispose=f.install()
    try{
      const onlyUI=await invoke(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,{
        ...f.payload,payload:{...f.payload.payload,removalAck:undefined},
      }) as {ok:boolean}
      expect(onlyUI.ok).toBe(false)
      expect(readAggregate(f.id)?.receiptLog).toHaveLength(1)
    }finally{dispose()}
  })
})
