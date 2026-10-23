/**
 * CsLabAuthGate — CDUT Science 本机访问密码门禁
 *
 * 双态渲染：
 *   1. 首次启用：设置本机访问密码（两次确认，≥6 位）；
 *   2. 日常进入：输入访问密码解锁。
 *
 * 验证与凭据存储全部在主进程完成；渲染层只提交密码并接收结果，不接触密文。
 * 视觉遵循暖调编辑式极简（羊皮纸底 + 赤陶强调 + 发丝边框）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { AlertTriangle, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cslabAuthAtom } from '@/atoms/cslab-atoms'

const MIN_PASSWORD_LENGTH = 6

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  placeholder: string
  disabled: boolean
  show: boolean
  onChange: (value: string) => void
  onToggleShow: () => void
  autoComplete?: string
}

function PasswordField({
  id,
  label,
  value,
  placeholder,
  disabled,
  show,
  onChange,
  onToggleShow,
  autoComplete = 'off',
}: PasswordFieldProps): React.ReactElement {
  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="block text-[10px] font-medium uppercase tracking-[0.22em] text-cslab-muted"
      >
        {label}
      </label>
      <div className="flex items-center gap-2.5 rounded-xl border border-cslab-border bg-cslab-elevated/80 px-4 py-2.5 transition-all focus-within:border-cslab-accent/50 focus-within:ring-2 focus-within:ring-cslab-accent/10">
        <KeyRound size={15} className="shrink-0 text-cslab-muted" />
        <input
          id={id}
          data-tour={
            id === 'cslab-access-password'
              ? 'cslab-auth-password'
              : id === 'cslab-access-password-confirm'
                ? 'cslab-auth-password-confirm'
                : undefined
          }
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          className="w-full bg-transparent text-sm text-cslab-text placeholder:text-cslab-muted/70 focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="ml-1 shrink-0 text-cslab-muted transition-colors hover:text-cslab-text"
          title={show ? '隐藏密码' : '显示密码'}
          aria-label={show ? '隐藏密码' : '显示密码'}
        >
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  )
}

export function CsLabAuthGate(): React.ReactElement {
  const [auth, setAuth] = useAtom(cslabAuthAtom)

  const isInitializing = !auth.isInitialized
  const [password, setPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [errorStatus, setErrorStatus] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting) return

    setErrorStatus(null)

    if (isInitializing) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setErrorStatus(`访问密码至少需要 ${MIN_PASSWORD_LENGTH} 位`)
        return
      }
      if (password !== confirmPassword) {
        setErrorStatus('两次输入的密码不一致')
        return
      }
    } else if (!password) {
      setErrorStatus('请输入访问密码')
      return
    }

    setSubmitting(true)
    try {
      const api = window.electronAPI?.cslab
      if (!api) {
        setErrorStatus('门禁服务不可用，请重启应用后重试')
        return
      }

      const result = isInitializing
        ? await api.initPassword(password)
        : await api.verifyPassword(password)

      if (!result.success) {
        setErrorStatus(
          result.message ?? (isInitializing ? '密码设置失败，请重试' : '密码不正确，请重新输入'),
        )
        return
      }

      setPassword('')
      setConfirmPassword('')
      setAuth({ isInitialized: true, isVerified: true, hydrated: true })
    } catch {
      setErrorStatus(isInitializing ? '密码设置失败，请重试' : '密码校验失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const title = isInitializing ? '设置访问密码' : '输入访问密码'
  const subtitle = isInitializing
    ? '首次启用 CDUT Science，请为本台设备设置专属访问密码，数据将使用系统级安全密钥加密存储。'
    : '请输入本台设备设置的 CDUT Science 访问密码以解锁科研工作台。'
  const submitLabel = isInitializing ? '设置并进入' : '验证并进入'
  const canSubmit = isInitializing
    ? password.length >= MIN_PASSWORD_LENGTH && confirmPassword.length > 0 && !submitting
    : password.length > 0 && !submitting

  return (
    <div className="w-full max-w-md font-sans">
      <div
        data-tour="cslab-auth-gate"
        className="rounded-2xl border border-cslab-border bg-cslab-elevated/70 p-8 shadow-subtle backdrop-blur-sm"
      >
        <div className="flex items-center gap-2 text-cslab-accent">
          <KeyRound size={14} />
          <span className="text-[10px] font-medium uppercase tracking-[0.24em]">
            CSLab · Local Access
          </span>
        </div>

        <h2 className="mt-4 font-serif text-2xl font-medium tracking-tight text-cslab-text">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-cslab-muted">{subtitle}</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <PasswordField
            id="cslab-access-password"
            label={isInitializing ? '新密码' : '访问密码'}
            value={password}
            placeholder={isInitializing ? `至少 ${MIN_PASSWORD_LENGTH} 位` : '请输入访问密码'}
            disabled={submitting}
            show={showPassword}
            onChange={setPassword}
            onToggleShow={() => setShowPassword((prev) => !prev)}
            autoComplete={isInitializing ? 'new-password' : 'current-password'}
          />

          {isInitializing && (
            <PasswordField
              id="cslab-access-password-confirm"
              label="确认密码"
              value={confirmPassword}
              placeholder="请再次输入密码"
              disabled={submitting}
              show={showPassword}
              onChange={setConfirmPassword}
              onToggleShow={() => setShowPassword((prev) => !prev)}
              autoComplete="new-password"
            />
          )}

          {errorStatus && (
            <div className="flex items-center gap-1.5 text-xs text-[#B4472F]">
              <AlertTriangle size={13} className="shrink-0" />
              <span>{errorStatus}</span>
            </div>
          )}

          <button
            type="submit"
            data-tour="cslab-auth-submit"
            disabled={!canSubmit}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium tracking-wide transition-colors duration-200',
              canSubmit
                ? 'cursor-pointer bg-cslab-accent text-white hover:bg-cslab-accentHover'
                : 'cursor-not-allowed border border-cslab-border bg-cslab-surface text-cslab-muted',
            )}
          >
            <ShieldCheck size={15} />
            <span>{submitting ? '正在处理…' : submitLabel}</span>
          </button>
        </form>

        <p className="mt-5 border-t border-cslab-border/70 pt-4 text-[11px] leading-relaxed text-cslab-muted">
          访问密码仅保存在本机，由操作系统安全存储或本地 AES-256-GCM 加密，绝不明文写入磁盘。
        </p>
      </div>
    </div>
  )
}
