/**
 * CsLabHpcPanel — 远程学术算力网关
 *
 * 交互骨架：
 * - 集群档案（含堡垒机与调度器）；
 * - 统一计算契约（节点/核数/GPU/时长/命令）提交；
 * - 作业生命周期（刷新、取消、回传、重水合）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import {
  Ban,
  Download,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  X,
} from 'lucide-react'
import type {
  CsLabHpcJob,
  CsLabHpcJobState,
  CsLabHpcProfileSummary,
  CsLabHpcScheduler,
} from '@profer/shared'
import { cn } from '@/lib/utils'
import { cslabHpcJobsAtom, cslabHpcProfilesAtom } from '@/atoms/cslab-atoms'

interface CsLabHpcPanelProps {
  labId: string
  onToast: (kind: 'info' | 'success' | 'error', text: string) => void
  onOpenAsset?: (uri: string) => void
}

const STATE_LABELS: Record<CsLabHpcJobState, string> = {
  PENDING: '排队中',
  RUNNING: '运行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
  UNKNOWN: '状态未知',
}

const STATE_CLASSES: Record<CsLabHpcJobState, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  RUNNING: 'bg-cslab-accent/10 text-cslab-accent',
  COMPLETED: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-600',
  TIMEOUT: 'bg-orange-50 text-orange-700',
  CANCELLED: 'bg-cslab-surface text-cslab-muted',
  UNKNOWN: 'bg-zinc-100 text-zinc-600',
}

const SCHEDULER_LABELS: Record<CsLabHpcScheduler, string> = {
  slurm: 'Slurm',
  pbs: 'PBS Pro',
  lsf: 'LSF',
}

interface ProfileFormState {
  id?: string
  name: string
  host: string
  port: string
  username: string
  scheduler: CsLabHpcScheduler
  remoteWorkDir: string
  privateKeyPath: string
  passphrase: string
  bastionHost: string
  bastionPort: string
  bastionUsername: string
  bastionKeyPath: string
  bastionPassphrase: string
}

function emptyProfileForm(): ProfileFormState {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    scheduler: 'slurm',
    remoteWorkDir: '',
    privateKeyPath: '',
    passphrase: '',
    bastionHost: '',
    bastionPort: '22',
    bastionUsername: '',
    bastionKeyPath: '',
    bastionPassphrase: '',
  }
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function CsLabHpcPanel({
  labId,
  onToast,
  onOpenAsset,
}: CsLabHpcPanelProps): React.ReactElement {
  const [profiles, setProfiles] = useAtom(cslabHpcProfilesAtom)
  const [jobs, setJobs] = useAtom(cslabHpcJobsAtom)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [form, setForm] = React.useState<ProfileFormState>(emptyProfileForm)
  const [contract, setContract] = React.useState({
    profileId: '',
    jobName: 'cslab-simulation',
    nodes: '1',
    coresPerNode: '8',
    walltimeHours: '2',
    memoryGb: '',
    gpus: '',
    gpuType: '',
    queue: '',
    command: '',
  })

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [nextProfiles, nextJobs] = await Promise.all([
        window.electronAPI.cslab.listHpcProfiles(labId),
        window.electronAPI.cslab.listHpcJobs(labId),
      ])
      setProfiles(nextProfiles)
      setJobs(nextJobs)
      setContract((previous) =>
        previous.profileId || nextProfiles.length === 0
          ? previous
          : { ...previous, profileId: nextProfiles[0]!.id },
      )
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '集群状态读取失败')
    } finally {
      setLoading(false)
    }
  }, [labId, onToast, setJobs, setProfiles])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const startEdit = (profile: CsLabHpcProfileSummary): void => {
    setEditing(true)
    setForm({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      username: profile.username,
      scheduler: profile.scheduler,
      remoteWorkDir: profile.remoteWorkDir,
      privateKeyPath: '',
      passphrase: '',
      bastionHost: '',
      bastionPort: '22',
      bastionUsername: '',
      bastionKeyPath: '',
      bastionPassphrase: '',
    })
  }

  const handleSaveProfile = async (): Promise<void> => {
    setBusy('profile')
    try {
      const saved = await window.electronAPI.cslab.saveHpcProfile({
        labId,
        id: form.id,
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        scheduler: form.scheduler,
        remoteWorkDir: form.remoteWorkDir.trim(),
        privateKeyPath: form.privateKeyPath.trim() || undefined,
        passphrase: form.passphrase || undefined,
        bastion: form.bastionHost.trim()
          ? {
              host: form.bastionHost.trim(),
              port: Number(form.bastionPort) || 22,
              username: form.bastionUsername.trim(),
              privateKeyPath: form.bastionKeyPath.trim() || undefined,
              passphrase: form.bastionPassphrase || undefined,
            }
          : undefined,
      })
      onToast('success', `已保存集群档案：${saved.name}`)
      setEditing(false)
      setForm(emptyProfileForm())
      await refresh()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '档案保存失败')
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async (profileId: string): Promise<void> => {
    setBusy(`test-${profileId}`)
    try {
      const result = await window.electronAPI.cslab.testHpcConnection({ labId, profileId })
      onToast(result.ok ? 'success' : 'error', result.message)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '连接测试失败')
    } finally {
      setBusy(null)
    }
  }

  const handleSubmit = async (): Promise<void> => {
    if (!contract.profileId) {
      onToast('error', '请先选择集群档案')
      return
    }
    if (!contract.command.trim()) {
      onToast('error', '请填写作业命令')
      return
    }
    setBusy('submit')
    try {
      const job = await window.electronAPI.cslab.submitHpcJob({
        labId,
        profileId: contract.profileId,
        jobName: contract.jobName.trim() || 'cslab-simulation',
        nodes: Number(contract.nodes) || 1,
        coresPerNode: Number(contract.coresPerNode) || 1,
        walltimeHours: Number(contract.walltimeHours) || 1,
        memoryGb: contract.memoryGb ? Number(contract.memoryGb) : undefined,
        gpus: contract.gpus ? Number(contract.gpus) : undefined,
        gpuType: contract.gpuType.trim() || undefined,
        queue: contract.queue.trim() || undefined,
        command: contract.command.trim(),
      })
      onToast('success', `作业已提交：${job.jobId ?? job.schedulerJobName}`)
      await refresh()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '提交失败')
    } finally {
      setBusy(null)
    }
  }

  const runJobAction = async (
    key: string,
    action: 'refresh' | 'cancel' | 'harvest',
  ): Promise<void> => {
    setBusy(`${action}-${key}`)
    try {
      const job: CsLabHpcJob =
        action === 'refresh'
          ? await window.electronAPI.cslab.refreshHpcJob({ labId, key })
          : action === 'cancel'
            ? await window.electronAPI.cslab.cancelHpcJob({ labId, key })
            : await window.electronAPI.cslab.harvestHpcJob({ labId, key })
      onToast('info', job.message ?? `${action} 完成`)
      await refresh()
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : `${action} 失败`)
    } finally {
      setBusy(null)
    }
  }

  const handleRehydrate = async (): Promise<void> => {
    setBusy('rehydrate')
    try {
      const next = await window.electronAPI.cslab.rehydrateHpcJobs(labId)
      setJobs(next)
      onToast('info', `重水合完成，共 ${next.length} 个作业`)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : '重水合失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-cslab-border bg-cslab-surface/60 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-cslab-muted">
          计算契约只描述科学需求（节点、核数、GPU、时长），底层自动转译 Slurm / PBS / LSF。
          作业名注入确定性 UUID，断网或关机后重新打开应用会自动重水合。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="font-serif text-sm text-cslab-text">集群档案</h3>
        <button
          type="button"
          onClick={() => {
            setEditing((value) => !value)
            setForm(emptyProfileForm())
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2 py-1 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
        >
          {editing ? <X size={11} /> : <Plus size={11} />}
          {editing ? '取消' : '新增档案'}
        </button>
      </div>

      {editing && (
        <div className="space-y-2 rounded-xl border border-cslab-border bg-cslab-elevated p-3 shadow-subtle">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="档案名称"
              className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
            <select
              value={form.scheduler}
              onChange={(event) =>
                setForm({ ...form, scheduler: event.target.value as CsLabHpcScheduler })
              }
              className="rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5 text-[11px] text-cslab-text focus:outline-none"
            >
              <option value="slurm">Slurm</option>
              <option value="pbs">PBS Pro</option>
              <option value="lsf">LSF</option>
            </select>
            <input
              value={form.host}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
              placeholder="登录节点主机"
              className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
            <div className="flex gap-2">
              <input
                value={form.port}
                onChange={(event) => setForm({ ...form, port: event.target.value })}
                placeholder="22"
                className="w-16 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5 text-[11px] text-cslab-text focus:outline-none"
              />
              <input
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                placeholder="用户名"
                className="flex-1 rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
              />
            </div>
          </div>
          <input
            value={form.remoteWorkDir}
            onChange={(event) => setForm({ ...form, remoteWorkDir: event.target.value })}
            placeholder="远端工作目录（如 /scratch/user/project）"
            className="w-full rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 font-mono text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.privateKeyPath}
              onChange={(event) => setForm({ ...form, privateKeyPath: event.target.value })}
              placeholder="私钥文件绝对路径（可选）"
              className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
            <input
              value={form.passphrase}
              type="password"
              onChange={(event) => setForm({ ...form, passphrase: event.target.value })}
              placeholder="私钥口令 / 登录密码（可选）"
              className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
            />
          </div>

          <div className="rounded-lg border border-cslab-border/70 bg-cslab-bg p-2">
            <p className="mb-1.5 flex items-center gap-1 text-[10px] text-cslab-muted">
              <KeyRound size={10} /> 堡垒机（可留空）
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.bastionHost}
                onChange={(event) => setForm({ ...form, bastionHost: event.target.value })}
                placeholder="堡垒机地址"
                className="rounded border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text focus:outline-none"
              />
              <div className="flex gap-2">
                <input
                  value={form.bastionPort}
                  onChange={(event) => setForm({ ...form, bastionPort: event.target.value })}
                  placeholder="22"
                  className="w-14 rounded border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text focus:outline-none"
                />
                <input
                  value={form.bastionUsername}
                  onChange={(event) =>
                    setForm({ ...form, bastionUsername: event.target.value })
                  }
                  placeholder="堡垒机用户名"
                  className="flex-1 rounded border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text focus:outline-none"
                />
              </div>
              <input
                value={form.bastionKeyPath}
                onChange={(event) => setForm({ ...form, bastionKeyPath: event.target.value })}
                placeholder="堡垒机私钥路径"
                className="rounded border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text focus:outline-none"
              />
              <input
                value={form.bastionPassphrase}
                type="password"
                onChange={(event) =>
                  setForm({ ...form, bastionPassphrase: event.target.value })
                }
                placeholder="堡垒机口令"
                className="rounded border border-cslab-border bg-cslab-elevated px-2 py-1 text-[11px] text-cslab-text focus:outline-none"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleSaveProfile()}
            disabled={busy === 'profile'}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cslab-accent px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
          >
            {busy === 'profile' ? <Loader2 size={11} className="animate-spin" /> : <Server size={11} />}
            保存档案
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[11px] text-cslab-muted">
          <Loader2 size={12} className="animate-spin" />
          正在读取集群状态…
        </div>
      ) : (
        <>
          {profiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-cslab-border px-4 py-8 text-center">
              <Server size={20} className="text-cslab-muted/60" />
              <p className="mt-2 font-serif text-sm text-cslab-text">尚未配置集群</p>
              <p className="mt-1 text-[11px] text-cslab-muted">
                添加档案后即可测试连接与提交作业。
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {profiles.map((profile) => {
                const testing = busy === `test-${profile.id}`
                return (
                  <div
                    key={profile.id}
                    className="rounded-lg border border-cslab-border bg-cslab-elevated px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <Server size={11} className="shrink-0 text-cslab-muted" />
                      <span className="min-w-0 flex-1 truncate font-serif text-xs text-cslab-text">
                        {profile.name}
                      </span>
                      <span className="rounded bg-cslab-surface px-1.5 py-0.5 text-[9px] uppercase text-cslab-muted">
                        {SCHEDULER_LABELS[profile.scheduler]}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-cslab-muted">
                      {profile.username}@{profile.host}:{profile.port} · {profile.remoteWorkDir}
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={testing}
                        onClick={() => void handleTest(profile.id)}
                        className="inline-flex items-center gap-1 rounded border border-cslab-border px-2 py-0.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                      >
                        {testing ? <Loader2 size={9} className="animate-spin" /> : <Server size={9} />}
                        测试连接
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(profile)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void window.electronAPI.cslab
                            .deleteHpcProfile({ labId, profileId: profile.id })
                            .then(refresh)
                            .catch((error: unknown) =>
                              onToast(
                                'error',
                                error instanceof Error ? error.message : '删除失败',
                              ),
                            )
                        }
                        className="ml-auto rounded px-2 py-0.5 text-[10px] text-cslab-muted transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {profiles.length > 0 && (
            <div className="space-y-2 rounded-xl border border-cslab-border bg-cslab-elevated p-3 shadow-subtle">
              <h4 className="font-serif text-xs text-cslab-text">统一计算契约</h4>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={contract.profileId}
                  onChange={(event) => setContract({ ...contract, profileId: event.target.value })}
                  className="col-span-2 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5 text-[11px] text-cslab-text focus:outline-none"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <input
                  value={contract.jobName}
                  onChange={(event) => setContract({ ...contract, jobName: event.target.value })}
                  placeholder="作业名称"
                  className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text focus:outline-none"
                />
                <input
                  value={contract.queue}
                  onChange={(event) => setContract({ ...contract, queue: event.target.value })}
                  placeholder="队列（可选）"
                  className="rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text focus:outline-none"
                />
                <label className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
                  节点
                  <input
                    value={contract.nodes}
                    onChange={(event) => setContract({ ...contract, nodes: event.target.value })}
                    className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
                  核/节点
                  <input
                    value={contract.coresPerNode}
                    onChange={(event) =>
                      setContract({ ...contract, coresPerNode: event.target.value })
                    }
                    className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
                  时长(h)
                  <input
                    value={contract.walltimeHours}
                    onChange={(event) =>
                      setContract({ ...contract, walltimeHours: event.target.value })
                    }
                    className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-cslab-muted">
                  内存(GB)
                  <input
                    value={contract.memoryGb}
                    onChange={(event) => setContract({ ...contract, memoryGb: event.target.value })}
                    placeholder="可选"
                    className="w-14 rounded border border-cslab-border bg-cslab-bg px-1.5 py-1 text-[11px] text-cslab-text focus:outline-none"
                  />
                </label>
                <div className="col-span-2 flex gap-2">
                  <input
                    value={contract.gpus}
                    onChange={(event) => setContract({ ...contract, gpus: event.target.value })}
                    placeholder="GPU 数量"
                    className="w-20 rounded-lg border border-cslab-border bg-cslab-bg px-2 py-1.5 text-[11px] text-cslab-text focus:outline-none"
                  />
                  <input
                    value={contract.gpuType}
                    onChange={(event) => setContract({ ...contract, gpuType: event.target.value })}
                    placeholder="GPU 型号（a100 / v100）"
                    className="flex-1 rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 text-[11px] text-cslab-text focus:outline-none"
                  />
                </div>
              </div>
              <textarea
                value={contract.command}
                onChange={(event) => setContract({ ...contract, command: event.target.value })}
                rows={3}
                placeholder="远端执行命令（如 module load vasp && mpirun -np 64 vasp_std）"
                className="w-full resize-none rounded-lg border border-cslab-border bg-cslab-bg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-cslab-text placeholder:text-cslab-muted/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={busy === 'submit'}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-cslab-accent px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-cslab-accentHover disabled:opacity-50"
              >
                {busy === 'submit' ? <Loader2 size={11} className="animate-spin" /> : <Server size={11} />}
                提交作业
              </button>
            </div>
          )}

          <div className="flex items-center justify-between">
            <h3 className="font-serif text-sm text-cslab-text">作业</h3>
            <button
              type="button"
              onClick={() => void handleRehydrate()}
              disabled={busy === 'rehydrate'}
              className="inline-flex items-center gap-1 rounded-lg border border-cslab-border px-2 py-1 text-[11px] text-cslab-muted transition-colors hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
            >
              {busy === 'rehydrate' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RotateCw size={11} />
              )}
              重水合扫描
            </button>
          </div>

          {jobs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-cslab-border px-3 py-6 text-center text-[11px] text-cslab-muted">
              暂无作业记录
            </p>
          ) : (
            <ul className="space-y-1.5">
              {jobs.slice(0, 50).map((job) => (
                <li
                  key={job.key}
                  className="rounded-lg border border-cslab-border bg-cslab-elevated px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-cslab-text">
                      {job.schedulerJobName}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[9px]',
                        STATE_CLASSES[job.state],
                      )}
                    >
                      {STATE_LABELS[job.state]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[9px] text-cslab-muted">
                    JobID {job.jobId ?? '—'} · 提交 {formatTime(job.submittedAt)} · 检查{' '}
                    {formatTime(job.lastCheckedAt)}
                  </p>
                  {job.message && (
                    <p className="mt-0.5 text-[9px] leading-relaxed text-cslab-muted">
                      {job.message}
                    </p>
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void runJobAction(job.key, 'refresh')}
                      disabled={busy === `refresh-${job.key}`}
                      className="inline-flex items-center gap-1 rounded border border-cslab-border px-1.5 py-0.5 text-[9px] text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                    >
                      <RefreshCw size={9} /> 刷新
                    </button>
                    <button
                      type="button"
                      onClick={() => void runJobAction(job.key, 'harvest')}
                      disabled={busy === `harvest-${job.key}`}
                      className="inline-flex items-center gap-1 rounded border border-cslab-border px-1.5 py-0.5 text-[9px] text-cslab-muted hover:bg-cslab-surface hover:text-cslab-text disabled:opacity-50"
                    >
                      <Download size={9} /> 回传
                    </button>
                    <button
                      type="button"
                      onClick={() => void runJobAction(job.key, 'cancel')}
                      disabled={busy === `cancel-${job.key}`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-cslab-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <Ban size={9} /> 取消
                    </button>
                  </div>

                  {job.artifacts.length > 0 && (
                    <ul className="mt-1.5 space-y-1 border-t border-cslab-border/60 pt-1.5">
                      {job.artifacts.map((artifact) => (
                        <li
                          key={`${job.key}-${artifact.path}`}
                          className="flex items-center gap-1.5 text-[9px] text-cslab-muted"
                        >
                          {artifact.disposition === 'downloaded' ? (
                            <button
                              type="button"
                              disabled={!artifact.assetUri || !onOpenAsset}
                              onClick={() => artifact.assetUri && onOpenAsset?.(artifact.assetUri)}
                              className="min-w-0 flex-1 truncate text-left font-mono text-cslab-text hover:text-cslab-accent disabled:cursor-default disabled:text-cslab-muted"
                            >
                              {artifact.path}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate font-mono">
                              {artifact.path}
                            </span>
                          )}
                          <span className="shrink-0 tabular-nums">{formatBytes(artifact.bytes)}</span>
                          <span
                            className={cn(
                              'shrink-0 rounded px-1 py-0.5',
                              artifact.disposition === 'downloaded'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-cslab-surface text-cslab-muted',
                            )}
                          >
                            {artifact.disposition === 'downloaded' ? '已回传' : '远程 URI'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
