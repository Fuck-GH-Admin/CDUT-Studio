/**
 * Dev-C C-MAIN-WIRE-R01: actual Electron Main author read and Plan upgrade
 * handlers, fail-closed until independent B1 vault and policy authorities are
 * explicitly installed by privileged Main composition.
 *
 * No renderer can install a source, mint a school issuer, grant a Case Owner,
 * choose the Actor, or change the author vault's candidate-held status.
 * The handler is registered in the real review-ipc.ts and is only reachable
 * through the main-frame-only Preload reviewAPI.
 */
import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import {
  REVIEW_IPC_CHANNELS, type Actor, type CanonicalPlan,
  type CaseAggregateV2,
} from '@profer/shared'
import { getMainWindow } from '../main-window-state'
import { assertC0ReviewMainSender } from './review-c0-authority'
import {
  CMainTrustedAuthorRevisionRead,
  type CMainB1AuthorRevision, type CMainB1CandidateDocument,
  type CMainAuthorReadIdentity,
} from './review-v3-main-author-revision-read'
import {
  upgradeCanonicalPlanV3,
  type CMainUpgradeRemovalAck,
} from './plan-binding-v3'
import {
  C2MainPublishedPlanProvenance,
  type C2MainPublishedPlanSource,
} from './review-v3-main-plan-provenance'
import { assertSafeReviewStorageId } from './review-storage-id'

const refuse=(reason:string):never=>{throw new Error('C_MAIN_V3_IPC_'+reason)}
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128
const own=(v:unknown,key:string)=>!!v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,key)

/** Provided ONLY by privileged Main's actual Owner/grant registry. */
export interface CMainV3Grant {
  readonly ownerId:string
  readonly generation:number
  /** Rotates on revoke, logout, new Owner or window generation. */
  readonly authorityEpoch:string
}

/**
 * Requires independently trusted, live sources. None are synthesized from
 * local-device reviewer identity, Renderer payload or B candidate documents.
 */
export interface CMainV3AuthorPlanAuthorities<T extends CMainB1CandidateDocument=CMainB1CandidateDocument> {
  getAuthorGrant(templateId:string):CMainV3Grant|undefined
  canReadAuthor(principalId:string,templateId:string,grant:CMainV3Grant):boolean
  readLatestB1AuthorRevision(templateId:string):Promise<CMainB1AuthorRevision<T>|undefined>
    |CMainB1AuthorRevision<T>|undefined
  getCaseGrant(caseId:string):CMainV3Grant|undefined
  canUpgradeCase(principalId:string,caseId:string,grant:CMainV3Grant):boolean
  /** Independent issued school/published artifact registry; B candidates denied. */
  readonly publishedPlanSource:C2MainPublishedPlanSource
}

let authorities:CMainV3AuthorPlanAuthorities|undefined

/** Main-only composition hook; no IPC method/renderer handler installs this. */
export function installCMainV3AuthorPlanAuthorities(
  next:CMainV3AuthorPlanAuthorities,
):()=>void {
  if(authorities) refuse('AUTHORITIES_ALREADY_INSTALLED')
  if(!next || typeof next.getAuthorGrant!=='function' ||
     typeof next.canReadAuthor!=='function' ||
     typeof next.readLatestB1AuthorRevision!=='function' ||
     typeof next.getCaseGrant!=='function' ||
     typeof next.canUpgradeCase!=='function' ||
     !next.publishedPlanSource) refuse('INDEPENDENT_AUTHORITIES_REQUIRED')
  // Fail immediately if publisher is only a fake/malformed dependency;
  // actual current source checks remain inside serialized Case CAS.
  new C2MainPublishedPlanProvenance(next.publishedPlanSource)
  authorities=next
  return ()=>{if(authorities===next) authorities=undefined}
}
function requireAuthority():CMainV3AuthorPlanAuthorities {
  if(!authorities) return refuse('INDEPENDENT_AUTHORITIES_NOT_INSTALLED')
  return authorities
}

/** Actual C0 verified live browser sender and stable per-frame identity. */
function liveFrame(event:IpcMainInvokeEvent):{
  principalId:string;sessionId:string;windowId:string;frameId:string;
} {
  assertC0ReviewMainSender(event)
  const main=getMainWindow()
  if(!main || main.isDestroyed()) return refuse('MAIN_WINDOW_CLOSED')
  const f=event.senderFrame
  if(!f || !Number.isSafeInteger(f.processId) || !Number.isSafeInteger(f.routingId)) {
    return refuse('PHYSICAL_FRAME_ID_MISSING')
  }
  return {
    principalId:'local-reviewer',
    sessionId:'local-main-webcontents:'+event.sender.id,
    windowId:'main-webcontents:'+main.webContents.id,
    frameId:f.processId+':'+f.routingId,
  }
}
function checkGrant(g:CMainV3Grant|undefined):CMainV3Grant {
  if(!g || !safe(g.ownerId) || !safe(g.authorityEpoch) ||
     !Number.isSafeInteger(g.generation) || g.generation<0) {
    return refuse('TRUSTED_GRANT_UNAVAILABLE')
  }
  return structuredClone(g)
}
function sameGrant(a:CMainV3Grant,b:CMainV3Grant):boolean {
  return a.ownerId===b.ownerId && a.generation===b.generation &&
    a.authorityEpoch===b.authorityEpoch
}
function liveAuthorIdentity(
  event:IpcMainInvokeEvent,templateId:string,
  authority:CMainV3AuthorPlanAuthorities,
):CMainAuthorReadIdentity {
  const frame=liveFrame(event)
  const grant=checkGrant(authority.getAuthorGrant(templateId))
  return {
    ...frame,ownerId:grant.ownerId,ownerGeneration:grant.generation,
    authorityEpoch:grant.authorityEpoch,
  }
}
/** Only the real Electron handler, no anonymous caseId/path overload. */
export async function handleCMainAuthorLatestRead(
  event:IpcMainInvokeEvent,
  input:unknown,
) {
  liveFrame(event)
  if(!input || typeof input!=='object'||Array.isArray(input)) {
    return refuse('AUTHOR_REQUEST_INVALID')
  }
  if(own(input,'actor')||own(input,'principal')||own(input,'authorId')||
     own(input,'sourceIdentity')||own(input,'publication')) return refuse('RENDERER_CREDENTIAL_CLAIM')
  const data=input as Record<string,unknown>
  if(typeof data.templateId!=='string') return refuse('TEMPLATE_REQUIRED')
  const scope=data.templateId
  const expected=data.expectedRevision
  if(expected!==undefined&&(!Number.isSafeInteger(expected)||typeof expected!=='number')) {
    return refuse('EXPECTED_REVISION_INVALID')
  }
  const authority=requireAuthority()
  const port=new CMainTrustedAuthorRevisionRead({
    currentIdentity:()=>liveAuthorIdentity(event,scope,authority),
    canRead:(id,templateId)=>{
      const live=liveAuthorIdentity(event,templateId,authority)
      return id.principalId===live.principalId && id.sessionId===live.sessionId &&
        id.windowId===live.windowId&&id.frameId===live.frameId &&
        id.ownerId===live.ownerId&&id.ownerGeneration===live.ownerGeneration &&
        id.authorityEpoch===live.authorityEpoch &&
        authority.canReadAuthor(id.principalId,templateId,{
          ownerId:id.ownerId,generation:id.ownerGeneration,authorityEpoch:id.authorityEpoch,
        })
    },
    readLatestAuthorRevision:id=>authority.readLatestB1AuthorRevision(id),
  })
  return port.readLatestAuthorRevision(scope,expected as number|undefined)
}
export interface CMainV3UpgradeIntent {
  caseId:string
  requestId:string
  expectedRevision:number
  payload:{
    plan:CanonicalPlan
    previousFingerprint:string
    acknowledgement:string
    removalAck?:CMainUpgradeRemovalAck
  }
}
function assertCaseInput(input:unknown):CMainV3UpgradeIntent {
  if(!input||typeof input!=='object'||Array.isArray(input))return refuse('UPGRADE_INTENT_INVALID')
  for(const name of ['actor','principal','owner','publisher','sourceIdentity','schoolRole']) {
    if(own(input,name))return refuse('RENDERER_CREDENTIAL_CLAIM')
  }
  const c=input as Record<string,unknown>
  assertSafeReviewStorageId(c.caseId,'caseId')
  if(!safe(c.requestId)||!Number.isSafeInteger(c.expectedRevision)||Number(c.expectedRevision)<0||
     !c.payload||typeof c.payload!=='object'||Array.isArray(c.payload)) {
    return refuse('UPGRADE_CONTRACT_INVALID')
  }
  const payload=c.payload as Record<string,unknown>
  if(typeof payload.previousFingerprint!=='string'||typeof payload.acknowledgement!=='string'||
     !payload.plan||typeof payload.plan!=='object'||Array.isArray(payload.plan)||
     own(payload,'actor')||own(payload,'principal')||own(payload,'publication')) {
    return refuse('UPGRADE_PAYLOAD_INVALID')
  }
  return input as CMainV3UpgradeIntent
}
function actorOf(principal:string):Actor {
  return {actorId:principal,actorSource:'local',role:'reviewer'}
}
export async function handleCMainUpgradeCanonicalPlan(
  event:IpcMainInvokeEvent,input:unknown,
) {
  const atStart=liveFrame(event)
  const data=assertCaseInput(input)
  const authority=requireAuthority()
  const initial=checkGrant(authority.getCaseGrant(data.caseId))
  if(!authority.canUpgradeCase(atStart.principalId,data.caseId,initial))
    return refuse('CASE_UPGRADE_UNAUTHORIZED')
  const publisher=new C2MainPublishedPlanProvenance(authority.publishedPlanSource)
  const recheck=(aggregate:CaseAggregateV2):void=>{
    const now=liveFrame(event)
    const latest=checkGrant(authority.getCaseGrant(data.caseId))
    if(JSON.stringify(now)!==JSON.stringify(atStart)||
      !sameGrant(initial,latest)||
      aggregate.caseV2.id!==data.caseId||
      !authority.canUpgradeCase(now.principalId,data.caseId,latest)) {
      refuse('CASE_UPGRADE_REVOKED_AT_COMMIT')
    }
  }
  return upgradeCanonicalPlanV3(data.caseId,{
    requestId:data.requestId,expectedRevision:data.expectedRevision,
    actor:actorOf(atStart.principalId),payload:data.payload,
  },(plan,aggregate)=>{
    recheck(aggregate)
    publisher.assertPublishedPlanForCase(plan,aggregate)
    recheck(aggregate)
  },(aggregate,actor)=>{
    recheck(aggregate)
    if(actor.actorId!==atStart.principalId)refuse('ACTOR_CHANGED_AT_COMMIT')
  })
}

/** Actual Main hook registered unconditionally; missing authorities deny. */
export function registerCMainV3AuthorPlanIpc():void {
  ipcMain.handle(REVIEW_IPC_CHANNELS.AUTHOR_READ_LATEST_V3,handleCMainAuthorLatestRead)
  ipcMain.handle(REVIEW_IPC_CHANNELS.UPGRADE_CANONICAL_PLAN_V3,handleCMainUpgradeCanonicalPlan)
}
