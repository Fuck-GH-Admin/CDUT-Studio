/**
 * CSLab 远程学术算力网关
 *
 * 能力：
 * - 纯 ssh2 双跳（堡垒机 forwardOut）+ keyboard-interactive MFA/TOTP 透传；
 * - 统一计算契约 -> Slurm / PBS / LSF 批处理脚本；
 * - 确定性 UUID 作业名 + hpc_jobs.sqlite 重水合（断网数天也不丢作业）；
 * - 外科手术式回传：白名单轻量产物落库，重型轨迹只记 sftp:// 远程 URI。
 *
 * 红线：
 * - 状态未知就如实标 UNKNOWN，绝不伪造 COMPLETED；
 * - 重水合找不到作业时只提示「可安全重投」，不自动重复提交；
 * - 所有计时器 unref，任何失败都收敛为明确错误信息。
 */

import { Client } from 'ssh2'
import type { ConnectConfig, FileEntry, SFTPWrapper } from 'ssh2'
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, sep } from 'node:path'
import type {
  CsLabComputeContract,
  CsLabHpcArtifact,
  CsLabHpcBastionInput,
  CsLabHpcJob,
  CsLabHpcJobState,
  CsLabHpcMfaRequest,
  CsLabHpcProfileInput,
  CsLabHpcProfileSummary,
  CsLabHpcScheduler,
  CsLabHpcTestResult,
} from '@profer/shared'
import {
  deleteHpcProfileRow,
  findHpcJobByRemoteId,
  getHpcDatabase,
  getHpcJobRow,
  getHpcProfileRow,
  listActiveHpcJobRows,
  listHpcJobRows,
  listHpcProfileRows,
  toHpcJob,
  upsertHpcJobRow,
  upsertHpcProfileRow,
  type CsLabHpcJobRow,
  type CsLabHpcProfileRow,
} from './cslab-hpc-db'
import { assertLabId, resolveLabDir } from './cslab-paths'
import { copyFileWithHash, lockFileReadOnly } from './cslab-hash'
import {
  getCsLabDatabase,
  nextLabRevision,
  upsertEntity,
  withTransaction,
  type CsLabEntityRecord,
} from './cslab-db'
import { buildCsLabUri } from './cslab-uri'
import { ingestFiles } from './cslab-iron-cage'
import { decryptToken, encryptToken } from '../token-crypto'

// ===== 常量 =====

const MFA_TIMEOUT_MS = 90_000
const DEFAULT_POLL_MS = 30_000
const MAX_POLL_MS = 5 * 60_000
const HARVEST_MAX_BYTES = 500 * 1024 * 1024
const WHITELIST: RegExp[] = [
  /^OUTCAR$/i,
  /^OSZICAR$/i,
  /^CONTCAR$/i,
  /^POSCAR$/i,
  /^INCAR$/i,
  /^slurm-\d+\.out$/i,
  /.*\.log$/i,
  /.*\.png$/i,
  /.*\.pdf$/i,
]
const BLACKLIST: RegExp[] = [
  /^WAVECAR$/i,
  /^CHGCAR$/i,
  /^CHG$/i,
  /^AECCAR.*$/i,
  /.*\.lammpstrj$/i,
]

const TERMINAL_STATES: CsLabHpcJobState[] = [
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
]

export interface CsLabHpcSink {
  onJob?: (job: CsLabHpcJob) => void
  onMfa?: (request: CsLabHpcMfaRequest) => void
}

interface PendingMfa {
  resolve: (value: string) => void
  timer: NodeJS.Timeout
}

const pendingMfa = new Map<string, PendingMfa>()
const connections = new Map<string, { client: Client; labId: string }>()
const pollTimers = new Map<string, NodeJS.Timeout>()
/** 连续 UNKNOWN 上限：集群清理作业记录后不再无限轮询。 */
const MAX_UNKNOWN_POLLS = 10
const unknownPollCounts = new Map<string, number>()

function isTerminal(state: CsLabHpcJobState): boolean {
  return TERMINAL_STATES.includes(state)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 调度器 JobID 安全字符集：仅字母、数字、下划线、点、连字符，长度 ≤ 64。 */
const REMOTE_JOB_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/

/** 校验远程 JobID，阻断拼接进远程 Shell 的命令注入输入。 */
export function assertSafeRemoteJobId(jobId: string): string {
  const value = (jobId ?? '').trim()
  if (!REMOTE_JOB_ID_RE.test(value)) {
    throw new Error('远程 JobID 格式非法，已阻断潜在命令注入风险')
  }
  return value
}

function formatWalltime(hours: number, style: 'seconds' | 'minutes'): string {
  const totalSeconds = Math.max(60, Math.round(hours * 3600))
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  return style === 'seconds' ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`
}

// ===== 统一计算契约 -> 批处理脚本 =====

export interface SynthesizedBatch {
  script: string
  schedulerJobName: string
}

/** 队列名 / GPU 型号只允许调度器可接受的标识符字符，杜绝换行与 shell 控制字符。 */
const SAFE_SCHEDULER_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/

function assertSafeSchedulerIdentifier(
  value: string | undefined,
  label: string,
): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!SAFE_SCHEDULER_IDENTIFIER.test(trimmed)) {
    throw new Error(`${label}包含非法字符，已拦截潜在的批处理脚本注入`)
  }
  return trimmed
}

export function synthesizeBatchScript(
  profile: Pick<CsLabHpcProfileRow, 'scheduler' | 'remoteWorkDir'> & { queue?: string },
  contract: Pick<
    CsLabComputeContract,
    'nodes' | 'coresPerNode' | 'walltimeHours' | 'memoryGb' | 'gpus' | 'gpuType' | 'queue' | 'command'
  >,
  uuid: string,
): SynthesizedBatch {
  const nodes = Math.max(1, Math.round(contract.nodes))
  const cores = Math.max(1, Math.round(contract.coresPerNode))
  const walltimeHours = Number.isFinite(contract.walltimeHours)
    ? Math.max(0.01, contract.walltimeHours)
    : 1
  const memoryGb =
    contract.memoryGb && contract.memoryGb > 0 ? Math.round(contract.memoryGb) : undefined
  const gpus = contract.gpus && contract.gpus > 0 ? Math.round(contract.gpus) : undefined
  const gpuType = assertSafeSchedulerIdentifier(contract.gpuType, 'GPU 型号')
  const queue = assertSafeSchedulerIdentifier(contract.queue || profile.queue, '队列分区名')
  const jobName = `cslab-${uuid.slice(0, 8)}`
  const lines: string[] = ['#!/bin/bash']

  if (profile.scheduler === 'slurm') {
    lines.push(`#SBATCH --job-name=${jobName}`)
    lines.push(`#SBATCH --nodes=${nodes}`)
    lines.push(`#SBATCH --ntasks-per-node=${cores}`)
    lines.push(`#SBATCH --time=${formatWalltime(walltimeHours, 'seconds')}`)
    if (memoryGb) lines.push(`#SBATCH --mem=${memoryGb}G`)
    if (gpus) lines.push(`#SBATCH --gres=gpu:${gpuType || 'a100'}:${gpus}`)
    if (queue) lines.push(`#SBATCH -p ${queue}`)
  } else if (profile.scheduler === 'pbs') {
    const resources = [`select=${nodes}`, `ncpus=${cores}`]
    if (gpus) resources.push(`ngpus=${gpus}`)
    if (memoryGb) resources.push(`mem=${memoryGb}gb`)
    lines.push(`#PBS -N ${jobName}`)
    lines.push(`#PBS -l ${resources.join(':')}`)
    lines.push(`#PBS -l walltime=${formatWalltime(walltimeHours, 'seconds')}`)
    if (queue) lines.push(`#PBS -q ${queue}`)
  } else {
    lines.push(`#BSUB -J ${jobName}`)
    lines.push(`#BSUB -n ${nodes * cores}`)
    lines.push(`#BSUB -R "span[ptile=${cores}]"`)
    lines.push(`#BSUB -W ${formatWalltime(walltimeHours, 'minutes')}`)
    if (memoryGb) lines.push(`#BSUB -M ${memoryGb}G`)
    if (gpus) lines.push(`#BSUB -gpu "num=${gpus}:mode=exclusive_process"`)
    if (queue) lines.push(`#BSUB -q ${queue}`)
  }

  lines.push('')
  lines.push(`cd ${shellQuote(profile.remoteWorkDir)}`)
  lines.push(contract.command)
  lines.push('')

  return { script: lines.join('\n'), schedulerJobName: jobName }
}

// ===== 调度器状态归一化与 JSON 解析 =====

export function normalizeSchedulerState(raw: string, scheduler: CsLabHpcScheduler): CsLabHpcJobState {
  const value = (raw ?? '').trim().toUpperCase()
  if (!value) return 'UNKNOWN'

  if (scheduler === 'slurm') {
    // sacct 常返回 `CANCELLED by 1001` / `TIMEOUT` 等带后缀状态。
    if (value.startsWith('CANCELLED')) return 'CANCELLED'
    if (value.startsWith('TIMEOUT')) return 'TIMEOUT'
    if (value.startsWith('COMPLETED')) return 'COMPLETED'
    if (value.startsWith('FAILED')) return 'FAILED'
    if (['PENDING', 'PD', 'CF', 'CONFIGURING', 'REQUEUED', 'RF'].includes(value)) return 'PENDING'
    if (['RUNNING', 'R', 'COMPLETING', 'CG', 'SUSPENDED', 'S'].includes(value)) return 'RUNNING'
    if (['COMPLETED', 'CD'].includes(value)) return 'COMPLETED'
    if (['FAILED', 'F', 'NODE_FAIL', 'NF', 'BOOT_FAIL', 'BF', 'DEADLINE', 'DL', 'OUT_OF_MEMORY', 'OOM'].includes(value)) {
      return 'FAILED'
    }
    if (['TIMEOUT', 'TO'].includes(value)) return 'TIMEOUT'
    if (['CANCELLED', 'CA', 'PREEMPTED', 'PR'].includes(value)) return 'CANCELLED'
    return 'UNKNOWN'
  }

  if (scheduler === 'pbs') {
    if (['Q', 'H', 'W', 'T', 'S', 'QUEUED', 'HELD'].includes(value)) return 'PENDING'
    if (['R', 'E', 'B', 'RUNNING', 'EXITING'].includes(value)) return 'RUNNING'
    if (['C', 'COMPLETED'].includes(value)) return 'COMPLETED'
    if (['F', 'FAILED'].includes(value)) return 'FAILED'
    if (['X'].includes(value)) return 'CANCELLED'
    return 'UNKNOWN'
  }

  if (['PEND', 'PSUSP', 'USUSP', 'SSUSP', 'WAIT', 'PROV'].includes(value)) return 'PENDING'
  if (['RUN'].includes(value)) return 'RUNNING'
  if (['DONE'].includes(value)) return 'COMPLETED'
  if (['EXIT'].includes(value)) return 'FAILED'
  if (['ZOMBI'].includes(value)) return 'UNKNOWN'
  return 'UNKNOWN'
}

export interface ParsedSchedulerJob {
  jobId: string
  rawState: string
}

/** 解析各调度器的 JSON / 纯文本输出；解析不了返回空数组。 */
export function parseSchedulerJson(
  scheduler: CsLabHpcScheduler,
  stdout: string,
): ParsedSchedulerJob[] {
  const text = (stdout ?? '').trim()
  if (!text) return []

  if (scheduler === 'pbs') {
    try {
      const parsed = JSON.parse(text) as {
        Jobs?: Record<string, { job_state?: string }>
      }
      const jobs = parsed.Jobs ?? {}
      return Object.entries(jobs).map(([jobId, value]) => ({
        jobId: jobId.split('.')[0] ?? jobId,
        rawState: String(value.job_state ?? ''),
      }))
    } catch {
      return []
    }
  }

  if (scheduler === 'lsf') {
    try {
      const parsed = JSON.parse(text) as unknown
      const records = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : ((parsed as { records?: Array<Record<string, unknown>> }).records ?? [])
      return records
        .map((record) => ({
          jobId: String(record.JOBID ?? record.jobid ?? record['JOB_ID'] ?? ''),
          rawState: String(record.STAT ?? record.stat ?? ''),
        }))
        .filter((item) => item.jobId)
    } catch {
      return []
    }
  }

  // Slurm：优先 sacct --json，其次 `jobid|state` / `jobid state` 文本
  try {
    const parsed = JSON.parse(text) as {
      jobs?: Array<{ job_id?: number | string; state?: { current?: string[] | string } }>
    }
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
    return jobs
      .map((job) => {
        const state = job.state?.current
        return {
          jobId: String(job.job_id ?? ''),
          rawState: Array.isArray(state) ? String(state[0] ?? '') : String(state ?? ''),
        }
      })
      .filter((item) => item.jobId)
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [jobId, ...rest] = line.split(/[|\s]+/)
        return { jobId: jobId ?? '', rawState: rest.join(' ') }
      })
      .filter((item) => /^\d+/.test(item.jobId))
  }
}

function parseSubmitJobId(scheduler: CsLabHpcScheduler, stdout: string): string | null {
  const text = (stdout ?? '').trim()
  if (!text) return null
  if (scheduler === 'slurm') {
    return /Submitted batch job\s+(\d+)/i.exec(text)?.[1] ?? /(\d+)/.exec(text)?.[1] ?? null
  }
  if (scheduler === 'pbs') {
    const match = /(\d+(?:\.\w+)?)/.exec(text)
    return match?.[1]?.split('.')[0] ?? null
  }
  return /Job\s+<(\d+)>/i.exec(text)?.[1] ?? /(\d+)/.exec(text)?.[1] ?? null
}

// ===== 连接与 MFA =====

function readPrivateKey(path?: string): Buffer | undefined {
  if (!path) return undefined
  try {
    return readFileSync(path)
  } catch {
    throw new Error(`无法读取私钥文件：${path}`)
  }
}

function decryptOrUndefined(cipher?: string): string | undefined {
  if (!cipher) return undefined
  try {
    return decryptToken(cipher)
  } catch {
    return undefined
  }
}

function buildConnectConfig(profile: {
  host: string
  port: number
  username: string
  privateKeyPath?: string
  passphraseCipher?: string
}): ConnectConfig {
  const secret = decryptOrUndefined(profile.passphraseCipher)
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    tryKeyboard: true,
    readyTimeout: 25_000,
    keepaliveInterval: 10_000,
  }
  const privateKey = readPrivateKey(profile.privateKeyPath)
  if (privateKey) config.privateKey = privateKey
  if (secret) {
    config.passphrase = secret
    // 部分集群用密码而非密钥：keyboard-interactive 里复用同一密文。
    config.password = secret
  }
  return config
}

function requestMfa(labId: string, prompt: string, sink?: CsLabHpcSink): Promise<string> {
  const requestId = `mfa-${randomUUID().slice(0, 8)}`
  const event: CsLabHpcMfaRequest = {
    requestId,
    labId,
    prompt,
    deadline: Date.now() + MFA_TIMEOUT_MS,
  }
  sink?.onMfa?.(event)

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMfa.delete(requestId)
      reject(new Error('MFA 验证超时（90 秒）'))
    }, MFA_TIMEOUT_MS)
    timer.unref()
    pendingMfa.set(requestId, {
      resolve: (value: string) => {
        clearTimeout(timer)
        pendingMfa.delete(requestId)
        resolve(value)
      },
      timer,
    })
  })
}

export function answerHpcMfa(requestId: string, value: string): boolean {
  const pending = pendingMfa.get(requestId)
  if (!pending) return false
  pending.resolve(value.trim())
  return true
}

function attachKeyboardInteractive(
  client: Client,
  labId: string,
  secret: string | undefined,
  sink?: CsLabHpcSink,
): void {
  client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
    void (async () => {
      const answers: string[] = []
      for (const prompt of prompts) {
        const text = String(prompt.prompt ?? '')
        if (/passcode|duo|verification|otp|token|验证码|动态码/i.test(text)) {
          answers.push(await requestMfa(labId, text, sink))
        } else if (/pass(word)?|密码/i.test(text) && secret) {
          answers.push(secret)
        } else {
          answers.push('')
        }
      }
      finish(answers)
    })().catch(() => {
      try {
        finish([])
      } catch {
        // 连接可能已关闭。
      }
    })
  })
}

function connectionKey(labId: string, profileId: string): string {
  return `${labId}::${profileId}`
}

async function getConnection(
  labId: string,
  profile: CsLabHpcProfileRow,
  sink?: CsLabHpcSink,
): Promise<Client> {
  const key = connectionKey(labId, profile.id)
  const cached = connections.get(key)
  if (cached) return cached.client

  const config = buildConnectConfig(profile)
  const secret = decryptOrUndefined(profile.passphraseCipher)

  let bastionClient: Client | null = null
  if (profile.bastion) {
    const bastionConfig = buildConnectConfig({
      host: profile.bastion.host,
      port: profile.bastion.port ?? 22,
      username: profile.bastion.username,
      privateKeyPath: profile.bastion.privateKeyPath,
      passphraseCipher: profile.bastion.passphraseCipher,
    })
    const bastionSecret = decryptOrUndefined(profile.bastion.passphraseCipher)
    bastionClient = new Client()
    attachKeyboardInteractive(bastionClient, labId, bastionSecret, sink)
    bastionClient.on('error', (error: Error) => {
      console.warn('[CSLab HPC] 堡垒机连接异常:', error.message)
      connections.delete(key)
      bastionClient?.end()
    })
    await new Promise<void>((resolve, reject) => {
      bastionClient!.once('ready', () => resolve())
      bastionClient!.once('error', reject)
      bastionClient!.connect(bastionConfig)
    }).catch((error: unknown) => {
      bastionClient?.end()
      bastionClient = null
      throw new Error(
        `堡垒机连接失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })

    const socket = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
      bastionClient!.forwardOut(
        '127.0.0.1',
        0,
        profile.host,
        profile.port,
        (error, channel) => (error ? reject(error) : resolve(channel)),
      )
    }).catch((error: unknown) => {
      bastionClient?.end()
      bastionClient = null
      throw new Error(
        `堡垒机转发失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
    config.sock = socket
    // 第二跳复用同一套 keyboard-interactive 处理。
    const client = new Client()
    attachKeyboardInteractive(client, labId, secret, sink)
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve())
      client.once('error', reject)
      client.connect(config)
    }).catch((error: unknown) => {
      client.end()
      bastionClient?.end()
      throw new Error(
        `跳板机到计算节点的 SSH 握手失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
    client.on('close', () => {
      connections.delete(key)
      bastionClient?.end()
    })
    client.on('error', (error) => {
      console.warn('[CSLab HPC] SSH 连接异常:', error.message)
      connections.delete(key)
      // 计算节点异常时必须同步回收堡垒机跳板与转发通道，避免端口/句柄悬挂。
      bastionClient?.end()
      client.destroy()
    })
    connections.set(key, { client, labId })
    return client
  }

  const client = new Client()
  attachKeyboardInteractive(client, labId, secret, sink)
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve())
      client.once('error', reject)
      client.connect(config)
    })
  } catch (error) {
    client.end()
    throw new Error(`SSH 连接失败：${error instanceof Error ? error.message : String(error)}`)
  }
  client.on('close', () => connections.delete(key))
  client.on('error', (error) => {
    console.warn('[CSLab HPC] SSH 连接异常:', error.message)
    connections.delete(key)
    client.destroy()
  })
  connections.set(key, { client, labId })
  return client
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)))
  })
}

function execCommand(
  client: Client,
  command: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        stream.close()
        reject(new Error('远程命令执行超时'))
      }, timeoutMs)
      timer.unref()
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, code })
      })
    })
  })
}

// ===== SFTP 辅助 =====

function sftpWriteFile(sftp: SFTPWrapper, path: string, content: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, (error) => (error ? reject(error) : resolve()))
  })
}

function sftpReadDir(sftp: SFTPWrapper, path: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => (error ? reject(error) : resolve(list)))
  })
}

function sftpFastGet(sftp: SFTPWrapper, remote: string, local: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, (error) => (error ? reject(error) : resolve()))
  })
}

async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  const absolute = dir.startsWith('/')
  const parts = dir.split('/').filter(Boolean)
  let current = absolute ? '' : '.'
  for (const part of parts) {
    current = current ? `${current}/${part}` : `/${part}`
    await new Promise<void>((resolve) => {
      sftp.mkdir(current, () => resolve())
    })
  }
}

// ===== 档案 =====

function toProfileSummary(profile: CsLabHpcProfileRow): CsLabHpcProfileSummary {
  return {
    id: profile.id,
    labId: profile.labId,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    scheduler: profile.scheduler,
    remoteWorkDir: profile.remoteWorkDir,
    hasPrivateKey: !!profile.privateKeyPath,
    hasPassphrase: !!profile.passphraseCipher,
    hasBastion: !!profile.bastion,
    updatedAt: profile.updatedAt,
  }
}

export function listHpcProfiles(labIdInput: string): CsLabHpcProfileSummary[] {
  const labId = assertLabId(labIdInput)
  return listHpcProfileRows(getHpcDatabase(labId), labId).map(toProfileSummary)
}

function encryptOptional(value?: string): string | undefined {
  return value && value.trim() ? encryptToken(value) : undefined
}

export function saveHpcProfile(input: CsLabHpcProfileInput): CsLabHpcProfileSummary {
  const labId = assertLabId(input.labId)
  const db = getHpcDatabase(labId)
  const name = input.name?.trim()
  const host = input.host?.trim()
  const username = input.username?.trim()
  const remoteWorkDir = input.remoteWorkDir?.trim()
  if (!name) throw new Error('档案名称不能为空')
  if (!host) throw new Error('集群主机不能为空')
  if (!username) throw new Error('登录用户名不能为空')
  if (!remoteWorkDir) throw new Error('远端工作目录不能为空')
  if (input.privateKeyPath) {
    try {
      readFileSync(input.privateKeyPath)
    } catch {
      throw new Error(`私钥文件不可读：${input.privateKeyPath}`)
    }
  }

  const id = input.id?.trim() || `hpc-${randomUUID().slice(0, 8)}`
  const existing = getHpcProfileRow(db, id)

  const bastion: CsLabHpcBastionInput | undefined = input.bastion
  const bastionRecord = bastion
    ? {
        host: bastion.host.trim(),
        port: bastion.port ?? 22,
        username: bastion.username.trim(),
        privateKeyPath: bastion.privateKeyPath?.trim() || undefined,
        // 未重新输入口令时沿用旧密文，避免编辑档案导致认证失效。
        passphraseCipher:
          encryptOptional(bastion.passphrase) ?? existing?.bastion?.passphraseCipher,
      }
    : undefined

  const row: CsLabHpcProfileRow = {
    id,
    labId,
    name,
    host,
    port: input.port ?? 22,
    username,
    scheduler: input.scheduler,
    remoteWorkDir,
    privateKeyPath: input.privateKeyPath?.trim() || undefined,
    passphraseCipher: encryptOptional(input.passphrase) ?? existing?.passphraseCipher,
    bastion: bastionRecord,
    updatedAt: Date.now(),
  }
  upsertHpcProfileRow(db, row)
  // 档案变更后旧连接立即失效。
  const cached = connections.get(connectionKey(labId, id))
  if (cached) {
    cached.client.end()
    connections.delete(connectionKey(labId, id))
  }
  return toProfileSummary(row)
}

export function deleteHpcProfile(labIdInput: string, profileId: string): void {
  const labId = assertLabId(labIdInput)
  const cached = connections.get(connectionKey(labId, profileId))
  if (cached) {
    cached.client.end()
    connections.delete(connectionKey(labId, profileId))
  }
  deleteHpcProfileRow(getHpcDatabase(labId), profileId)
}

export async function testHpcConnection(
  labIdInput: string,
  profileId: string,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcTestResult> {
  const labId = assertLabId(labIdInput)
  const profile = getHpcProfileRow(getHpcDatabase(labId), profileId)
  if (!profile) return { ok: false, message: '集群档案不存在' }
  const startedAt = Date.now()
  try {
    const client = await getConnection(labId, profile, sink)
    const result = await execCommand(client, 'echo cslab-ok')
    if (!result.stdout.includes('cslab-ok')) {
      return { ok: false, message: `远程回显异常：${result.stderr || result.stdout}` }
    }
    return {
      ok: true,
      message: '连接成功',
      latencyMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '连接失败',
      latencyMs: Date.now() - startedAt,
    }
  }
}

// ===== 作业 =====

export function listHpcJobs(labIdInput: string): CsLabHpcJob[] {
  const labId = assertLabId(labIdInput)
  return listHpcJobRows(getHpcDatabase(labId), labId).map(toHpcJob)
}

function publishJob(row: CsLabHpcJobRow, sink?: CsLabHpcSink): CsLabHpcJob {
  const job = toHpcJob(row)
  sink?.onJob?.(job)
  return job
}

function schedulePoll(labId: string, key: string, sink?: CsLabHpcSink, delay = DEFAULT_POLL_MS): void {
  const existing = pollTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    void refreshHpcJob(labId, key, sink)
      .then((job) => {
        if (job.state === 'UNKNOWN') {
          const count = (unknownPollCounts.get(key) ?? 0) + 1
          unknownPollCounts.set(key, count)
          if (count >= MAX_UNKNOWN_POLLS) {
            abandonPolling(labId, key, sink, count)
            return
          }
        } else {
          unknownPollCounts.delete(key)
        }
        if (!isTerminal(job.state)) {
          const next = Math.min(MAX_POLL_MS, delay * 2)
          schedulePoll(labId, key, sink, next)
        }
      })
      .catch((error: unknown) => {
        console.warn('[CSLab HPC] 作业轮询失败:', error)
        schedulePoll(labId, key, sink, Math.min(MAX_POLL_MS, delay * 2))
      })
  }, delay)
  timer.unref()
  pollTimers.set(key, timer)
}

function stopPoll(key: string): void {
  const timer = pollTimers.get(key)
  if (timer) clearTimeout(timer)
  pollTimers.delete(key)
  unknownPollCounts.delete(key)
}

/**
 * 连续多次无法确认状态后停止轮询。
 * 红线：状态仍如实保留 UNKNOWN，绝不伪造终态；只追加可操作提示。
 */
function abandonPolling(labId: string, key: string, sink?: CsLabHpcSink, count = 0): void {
  stopPoll(key)
  const db = getHpcDatabase(labId)
  const row = getHpcJobRow(db, key)
  if (!row) return
  const next: CsLabHpcJobRow = {
    ...row,
    lastCheckedAt: Date.now(),
    message: `连续 ${count} 次未能从调度器确认状态，已停止自动轮询；可手动刷新或重新投递`,
  }
  upsertHpcJobRow(db, next)
  publishJob(next, sink)
}

export async function submitHpcJob(
  input: CsLabComputeContract,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcJob> {
  const labId = assertLabId(input.labId)
  const db = getHpcDatabase(labId)
  const profile = getHpcProfileRow(db, input.profileId)
  if (!profile) throw new Error('集群档案不存在')
  if (!input.command?.trim()) throw new Error('作业命令不能为空')
  if (!Number.isFinite(input.nodes) || input.nodes < 1) throw new Error('节点数必须 ≥ 1')
  if (!Number.isFinite(input.coresPerNode) || input.coresPerNode < 1) {
    throw new Error('每节点核数必须 ≥ 1')
  }

  const uuid = randomUUID()
  const key = input.jobKey?.trim() || `job-${uuid.slice(0, 8)}`
  const { script, schedulerJobName } = synthesizeBatchScript(
    { scheduler: profile.scheduler, remoteWorkDir: profile.remoteWorkDir },
    input,
    uuid,
  )

  const client = await getConnection(labId, profile, sink)
  const sftp = await getSftp(client)
  await ensureRemoteDir(sftp, profile.remoteWorkDir)
  for (const file of input.inputs ?? []) {
    if (!/^[\w.\-]+$/.test(file.name)) throw new Error(`输入文件名非法：${file.name}`)
    await sftpWriteFile(sftp, `${profile.remoteWorkDir}/${file.name}`, file.text)
  }
  // 脚本名按作业唯一化，避免同一 remoteWorkDir 下并发提交互相覆盖。
  const scriptName = `batch-${uuid.slice(0, 8)}.sh`
  await sftpWriteFile(sftp, `${profile.remoteWorkDir}/${scriptName}`, script)

  const submitCommand =
    profile.scheduler === 'slurm'
      ? `cd ${shellQuote(profile.remoteWorkDir)} && sbatch ${scriptName}`
      : profile.scheduler === 'pbs'
        ? `cd ${shellQuote(profile.remoteWorkDir)} && qsub ${scriptName}`
        : `cd ${shellQuote(profile.remoteWorkDir)} && bsub < ${scriptName}`

  const result = await execCommand(client, submitCommand)
  if (result.code !== 0) {
    throw new Error(`作业提交失败：${result.stderr || result.stdout || `退出码 ${result.code}`}`)
  }
  const parsedJobId = parseSubmitJobId(profile.scheduler, result.stdout)
  if (!parsedJobId) {
    throw new Error(`未能解析 JobID：${result.stdout || result.stderr}`)
  }
  const jobId = assertSafeRemoteJobId(parsedJobId)

  const row: CsLabHpcJobRow = {
    key,
    labId,
    profileId: profile.id,
    jobId,
    jobName: schedulerJobName,
    uuid,
    state: 'PENDING',
    remoteWorkDir: profile.remoteWorkDir,
    submittedAt: Date.now(),
    lastCheckedAt: Date.now(),
    artifacts: [],
  }
  // 先落盘再轮询：即使提交后立刻断网，重水合仍能找回上下文。
  upsertHpcJobRow(db, row)
  schedulePoll(labId, key, sink)
  return publishJob(row, sink)
}

async function queryRemoteState(
  labId: string,
  profile: CsLabHpcProfileRow,
  row: CsLabHpcJobRow,
  sink?: CsLabHpcSink,
): Promise<{ state: CsLabHpcJobState; rawState: string }> {
  const client = await getConnection(labId, profile, sink)
  if (!row.jobId) return { state: 'UNKNOWN', rawState: '' }
  // 查询命令同样拼接远程 Shell，脏 JobID 必须在拼接前拒止。
  const jobId = assertSafeRemoteJobId(row.jobId)

  const commands: string[] =
    profile.scheduler === 'slurm'
      ? [
          `sacct -j ${jobId} --json`,
          `squeue -j ${jobId} -h -o "%T"`,
          `sacct -j ${jobId} -X -n -o State`,
        ]
      : profile.scheduler === 'pbs'
        ? [`qstat -f -Fjson ${jobId}`, `qstat -f ${jobId}`]
        : [`bjobs -json -o "jobid stat" ${jobId}`, `bjobs -o "jobid stat" ${jobId}`]

  for (const command of commands) {
    const result = await execCommand(client, command, 30_000).catch(() => null)
    if (!result || result.code !== 0) continue
    const parsed = parseSchedulerJson(profile.scheduler, result.stdout)
    if (parsed.length === 0) {
      const trimmed = result.stdout.trim()
      if (trimmed && profile.scheduler !== 'pbs') {
        const state = normalizeSchedulerState(trimmed.split(/\s+/)[0] ?? '', profile.scheduler)
        if (state !== 'UNKNOWN') return { state, rawState: trimmed }
      }
      continue
    }
    const matched = parsed.find((item) => item.jobId === jobId) ?? parsed[0]
    if (!matched) continue
    const state = normalizeSchedulerState(matched.rawState, profile.scheduler)
    if (state !== 'UNKNOWN') return { state, rawState: matched.rawState }
  }

  return { state: 'UNKNOWN', rawState: '' }
}

export async function refreshHpcJob(
  labIdInput: string,
  key: string,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcJob> {
  const labId = assertLabId(labIdInput)
  const db = getHpcDatabase(labId)
  const row = getHpcJobRow(db, key)
  if (!row) throw new Error('作业不存在')
  if (isTerminal(row.state)) return toHpcJob(row)

  const profile = getHpcProfileRow(db, row.profileId)
  if (!profile) throw new Error('集群档案已删除，无法刷新作业')

  const { state, rawState } = await queryRemoteState(labId, profile, row, sink)
  const terminal = isTerminal(state)
  const next: CsLabHpcJobRow = {
    ...row,
    state,
    lastCheckedAt: Date.now(),
    endedAt: terminal ? Date.now() : row.endedAt,
    message:
      state === 'UNKNOWN'
        ? `未能从调度器确认状态${rawState ? `（原始：${rawState}）` : ''}`
        : `调度器状态：${rawState || state}`,
  }
  upsertHpcJobRow(db, next)
  if (terminal) stopPoll(key)
  return publishJob(next, sink)
}

export async function cancelHpcJob(
  labIdInput: string,
  key: string,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcJob> {
  const labId = assertLabId(labIdInput)
  const db = getHpcDatabase(labId)
  const row = getHpcJobRow(db, key)
  if (!row) throw new Error('作业不存在')
  if (!row.jobId) throw new Error('该作业没有远程 JobID，无法取消')
  const jobId = assertSafeRemoteJobId(row.jobId)

  const profile = getHpcProfileRow(db, row.profileId)
  if (!profile) throw new Error('集群档案已删除')

  const client = await getConnection(labId, profile, sink)
  const command =
    profile.scheduler === 'slurm'
      ? `scancel ${jobId}`
      : profile.scheduler === 'pbs'
        ? `qdel ${jobId}`
        : `bkill ${jobId}`
  const result = await execCommand(client, command, 30_000)
  if (result.code !== 0) {
    throw new Error(`取消失败：${result.stderr || result.stdout}`)
  }

  const next: CsLabHpcJobRow = {
    ...row,
    state: 'CANCELLED',
    lastCheckedAt: Date.now(),
    endedAt: Date.now(),
    message: '用户取消',
  }
  upsertHpcJobRow(db, next)
  stopPoll(key)
  return publishJob(next, sink)
}

/** DAG 剪枝联动：按本地 key 批量取消，失败只记录不抛出。 */
export async function cancelHpcJobsByKeys(
  labIdInput: string,
  keys: string[],
  sink?: CsLabHpcSink,
): Promise<void> {
  const labId = assertLabId(labIdInput)
  for (const key of keys) {
    try {
      const row = getHpcJobRow(getHpcDatabase(labId), key)
      if (!row || isTerminal(row.state)) continue
      await cancelHpcJob(labId, key, sink)
    } catch (error) {
      console.warn(`[CSLab HPC] 取消作业失败 ${key}:`, error)
    }
  }
}

// ===== 外科手术式回传 =====

function isWhitelisted(name: string): boolean {
  return WHITELIST.some((pattern) => pattern.test(name))
}

function isBlacklisted(name: string): boolean {
  return BLACKLIST.some((pattern) => pattern.test(name))
}

function remoteBaseUri(profile: CsLabHpcProfileRow): string {
  return `sftp://${profile.username}@${profile.host}`
}

/** 远端工作目录归一化为 URI 路径段：无尾随斜杠；根目录/空值收敛为空串。 */
function normalizeRemoteDirForUri(dir: string): string {
  const trimmed = (dir ?? '').replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}` : ''
}

function remoteFileUri(profile: CsLabHpcProfileRow, name: string): string {
  return `${remoteBaseUri(profile)}${normalizeRemoteDirForUri(profile.remoteWorkDir)}/${name}`
}

async function registerFigureAsset(
  labId: string,
  stagedPath: string,
  name: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const relPath = `vault/figures/${timestamp}-${randomUUID().slice(0, 6)}-${name.replace(/[^\w.\-]/g, '_')}`
  const target = join(resolveLabDir(labId), relPath.split('/').join(sep))
  const digest = await copyFileWithHash(stagedPath, target)
  const locked = await lockFileReadOnly(target)
  const db = getCsLabDatabase(join(resolveLabDir(labId), 'db', 'central_meta.sqlite'))
  const entityUuid = `fig-${randomUUID().slice(0, 8)}`
  const uri = buildCsLabUri(labId, 'fig', entityUuid)
  withTransaction(db, () => {
    const revision = nextLabRevision(db)
    const entity: CsLabEntityRecord = {
      uri,
      labId,
      layerType: 'fig',
      entityUuid,
      title: name,
      format: name.split('.').pop()?.toLowerCase(),
      relPath,
      sha256: digest.sha256,
      bytes: digest.bytes,
      revision,
      locked,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    upsertEntity(db, entity)
    return revision
  })
  return uri
}

export async function harvestHpcJob(
  labIdInput: string,
  key: string,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcJob> {
  const labId = assertLabId(labIdInput)
  const db = getHpcDatabase(labId)
  const row = getHpcJobRow(db, key)
  if (!row) throw new Error('作业不存在')
  const profile = getHpcProfileRow(db, row.profileId)
  if (!profile) throw new Error('集群档案已删除')

  const client = await getConnection(labId, profile, sink)
  const sftp = await getSftp(client)
  const entries = await sftpReadDir(sftp, profile.remoteWorkDir)
  const staging = join(resolveLabDir(labId), 'db', 'staging')
  await fs.mkdir(staging, { recursive: true })

  const artifacts: CsLabHpcArtifact[] = []
  let downloaded = 0
  let skipped = 0

  for (const entry of entries) {
    const name = entry.filename
    const attrs = entry.attrs
    const size = Number(attrs.size ?? 0)
    if (!name || name === '.' || name === '..') continue
    // ssh2 的 Attributes 未暴露 isDirectory()，用 longname 的 POSIX 文件类型位判断。
    if (String(entry.longname ?? '').startsWith('d')) continue
    // 跳过批处理脚本本身（旧版 batch.sh 与新版 batch-xxxxxxxx.sh）。
    if (/^batch(?:-[0-9a-f]{8})?\.sh$/i.test(name)) continue

    const remoteUri = remoteFileUri(profile, name)
    if (isBlacklisted(name) || size > HARVEST_MAX_BYTES) {
      artifacts.push({ path: name, bytes: size, disposition: 'remote-uri', remoteUri })
      skipped += 1
      continue
    }
    if (!isWhitelisted(name)) continue

    const staged = join(staging, `hpc-${key}-${name.replace(/[^\w.\-]/g, '_')}`)
    await sftpFastGet(sftp, `${profile.remoteWorkDir}/${name}`, staged)
    downloaded += 1

    try {
      if (/\.(png|jpe?g)$/i.test(name)) {
        const uri = await registerFigureAsset(labId, staged, name)
        artifacts.push({
          path: name,
          bytes: size,
          disposition: 'downloaded',
          assetUri: uri,
          remoteUri,
        })
      } else {
        const results = await ingestFiles(labId, [staged])
        const result = results[0]
        artifacts.push({
          path: name,
          bytes: size,
          disposition: 'downloaded',
          assetUri: result?.tableUri ?? result?.asset.uri,
          remoteUri,
        })
      }
    } catch (error) {
      console.warn(`[CSLab HPC] 产物入库失败 ${name}:`, error)
      artifacts.push({ path: name, bytes: size, disposition: 'remote-uri', remoteUri })
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined)
    }
  }

  const next: CsLabHpcJobRow = {
    ...row,
    artifacts,
    lastCheckedAt: Date.now(),
    message: `回传 ${downloaded} 个轻量产物，跳过 ${skipped} 个重型文件（仅记录远程 URI）`,
  }
  upsertHpcJobRow(db, next)
  return publishJob(next, sink)
}

// ===== 重水合 =====

async function findJobIdByName(
  labId: string,
  profile: CsLabHpcProfileRow,
  row: CsLabHpcJobRow,
  sink?: CsLabHpcSink,
): Promise<string | null> {
  const client = await getConnection(labId, profile, sink)
  const commands =
    profile.scheduler === 'slurm'
      ? [`sacct --name=${row.jobName} --json`, `squeue --name=${row.jobName} -h -o "%A"`]
      : profile.scheduler === 'pbs'
        ? [`qstat -N ${row.jobName}`, `qselect -N ${row.jobName}`]
        : [`bjobs -J ${row.jobName} -o "jobid stat"`]

  for (const command of commands) {
    const result = await execCommand(client, command, 30_000).catch(() => null)
    if (!result || result.code !== 0) continue
    const parsed = parseSchedulerJson(profile.scheduler, result.stdout)
    const found = parsed.find((item) => /^\d+/.test(item.jobId))
    if (found?.jobId) return found.jobId
    const numeric = /(?:^|\s)(\d{3,})(?:\s|$)/.exec(result.stdout)?.[1]
    if (numeric) return numeric
  }
  return null
}

/**
 * 重水合扫描：应用重启 / 打开实验室时调用。
 * 只更新状态或找回 JobID，绝不自动重投作业。
 */
export async function rehydrateHpcJobs(
  labIdInput: string,
  sink?: CsLabHpcSink,
): Promise<CsLabHpcJob[]> {
  const labId = assertLabId(labIdInput)
  const db = getHpcDatabase(labId)
  const active = listActiveHpcJobRows(db, labId)

  for (const row of active) {
    const profile = getHpcProfileRow(db, row.profileId)
    if (!profile) {
      upsertHpcJobRow(db, {
        ...row,
        state: 'UNKNOWN',
        message: '集群档案已删除，作业上下文保留',
        lastCheckedAt: Date.now(),
      })
      continue
    }
    try {
      if (!row.jobId) {
        const found = await findJobIdByName(labId, profile, row, sink)
        if (found) {
          // 调度器返回值不可信：校验失败会落入外层 catch，保留原上下文而不写入脏 ID。
          upsertHpcJobRow(db, { ...row, jobId: assertSafeRemoteJobId(found) })
        } else {
          const next: CsLabHpcJobRow = {
            ...row,
            state: 'UNKNOWN',
            lastCheckedAt: Date.now(),
            message: '未在集群找到该 UUID 对应作业，可安全重新投递',
          }
          upsertHpcJobRow(db, next)
          publishJob(next, sink)
          continue
        }
      }
      const refreshed = await refreshHpcJob(labId, row.key, sink)
      if (!isTerminal(refreshed.state)) {
        schedulePoll(labId, row.key, sink)
      }
    } catch (error) {
      const next: CsLabHpcJobRow = {
        ...row,
        lastCheckedAt: Date.now(),
        message: `重水合失败：${error instanceof Error ? error.message : String(error)}`,
      }
      upsertHpcJobRow(db, next)
      publishJob(next, sink)
    }
  }

  return listHpcJobs(labId)
}

/** 测试辅助：直接写入作业上下文（不触发网络）。 */
export function __saveJobRowForTest(row: CsLabHpcJobRow): void {
  upsertHpcJobRow(getHpcDatabase(row.labId), row)
}

export function __findJobByRemoteIdForTest(labId: string, jobId: string): CsLabHpcJob | null {
  const row = findHpcJobByRemoteId(getHpcDatabase(labId), labId, jobId)
  return row ? toHpcJob(row) : null
}

export async function stopAllHpcBridges(): Promise<void> {
  for (const key of [...pollTimers.keys()]) stopPoll(key)
  for (const pending of pendingMfa.values()) {
    clearTimeout(pending.timer)
  }
  pendingMfa.clear()
  for (const [key, cached] of [...connections.entries()]) {
    try {
      cached.client.end()
    } catch {
      // 已断开。
    }
    connections.delete(key)
  }
}
