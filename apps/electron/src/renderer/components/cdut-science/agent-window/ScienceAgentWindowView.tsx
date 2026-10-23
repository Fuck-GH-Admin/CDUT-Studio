/**
 * CDUT Science 科学助理独立窗口
 *
 * 与主窗口共享同一份 preload 与 Pi Agent 内核；本组件只负责：
 * 1. 水合当前实验室绑定的研讨会话列表；
 * 2. 复用 AgentView 渲染对话；
 * 3. 接收主窗口上下文并预填输入框（不自动发送）；
 * 4. 提供科学快捷动作；
 * 5. 提供会话右键 / 悬浮菜单、行内重命名、置顶、AI 重生成标题与删除确认。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Atom,
  Download,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Sigma,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { AgentSessionMeta, CsLabAgentContext } from '@profer/shared'
import { detectIsMac, detectIsWindows } from '@profer/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@profer/ui/primitives/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@profer/ui/primitives/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { cn } from '@/lib/utils'
import { agentComposerInjectionAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { activeTabIdAtom } from '@/atoms/tab-atoms'
import { AgentView } from '@/components/agent/AgentView'
import { WindowControls } from '@/components/WindowControls'

interface ScienceAgentWindowViewProps {
  labId: string
  windowId: string
  focusSessionId?: string
}

/** 科学快捷动作：只预填提示词，发送仍由用户确认。 */
const QUICK_ACTIONS: Array<{ label: string; icon: typeof Sigma; prompt: string }> = [
  {
    label: '拟合当前选区',
    icon: Sigma,
    prompt: '请对当前绘图在最近一次框选区间内执行多峰解叠拟合，并用 cslab_render_plot 把拟合曲线追加到画板。',
  },
  {
    label: '计算理论 PXRD',
    icon: Atom,
    prompt: '请读取当前挂接的晶体结构资产，模拟理论 PXRD，并给出前 10 条主峰的 (hkl)、d 值与 2θ。',
  },
  {
    label: '分析晶体结构',
    icon: Sparkles,
    prompt: '请分析当前挂接的晶体结构，输出空间群、晶胞参数、化学式与 Wyckoff 占位列表。',
  },
  {
    label: '导出高清图',
    icon: Download,
    prompt: '请把当前绘图导出为 600 dpi 的 PNG 出版图，并返回文件路径与物理尺寸。',
  },
]

/** 合并会话列表：新数据覆盖旧字段，避免丢失既有会话。 */
function mergeSessionLists(previous: AgentSessionMeta[], incoming: AgentSessionMeta[]): AgentSessionMeta[] {
  const map = new Map(previous.map((session) => [session.id, session]))
  for (const session of incoming) {
    map.set(session.id, { ...map.get(session.id), ...session })
  }
  return Array.from(map.values())
}

/** 置顶优先，其余按最近更新时间倒序。 */
function sortAgentSessions(list: AgentSessionMeta[]): AgentSessionMeta[] {
  return [...list].sort((a, b) => {
    const pinnedDelta = Number(!!b.pinned) - Number(!!a.pinned)
    if (pinnedDelta !== 0) return pinnedDelta
    return b.updatedAt - a.updatedAt
  })
}

export function ScienceAgentWindowView({
  labId,
  windowId,
  focusSessionId,
}: ScienceAgentWindowViewProps): React.ReactElement {
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setComposerInjection = useSetAtom(agentComposerInjectionAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const sessionsInStore = useAtomValue(agentSessionsAtom)

  const [labName, setLabName] = React.useState('')
  const [sessions, setSessions] = React.useState<AgentSessionMeta[]>([])
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null)
  const [context, setContext] = React.useState<CsLabAgentContext | null>(null)
  const [ready, setReady] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = React.useState<string | null>(null)
  const [editingTitle, setEditingTitle] = React.useState('')
  const [deleteTarget, setDeleteTarget] = React.useState<AgentSessionMeta | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [regeneratingId, setRegeneratingId] = React.useState<string | null>(null)
  const editInputRef = React.useRef<HTMLInputElement>(null)
  /** 菜单关闭会触发 blur；编辑开始后的短暂窗口内忽略 blur 提交。 */
  const justStartedEditingRef = React.useRef(false)
  const editFocusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const bootstrappedRef = React.useRef(false)
  const activeSessionIdRef = React.useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId

  React.useEffect(() => {
    return () => {
      if (editFocusTimerRef.current !== null) clearTimeout(editFocusTimerRef.current)
    }
  }, [])

  const injectPrompt = React.useCallback(
    (sessionId: string, text: string): void => {
      setComposerInjection({ sessionId, text, nonce: Date.now() })
    },
    [setComposerInjection],
  )

  /** 创建会话并完成实验室绑定；绑定成功前不允许激活，避免工具未注入。 */
  const createBoundSession = React.useCallback(
    async (title: string): Promise<AgentSessionMeta> => {
      const created = await window.electronAPI.createAgentSession(title)
      await window.electronAPI.cslab.bindSessionLab({ sessionId: created.id, labId })
      return { ...created, cslabLabId: labId }
    },
    [labId],
  )

  const activateSession = React.useCallback(
    (sessionId: string): void => {
      setActiveSessionId(sessionId)
      // AgentView 用 activeTabId === sessionId 判定是否接管回车发送等快捷键。
      setActiveTabId(sessionId)
    },
    [setActiveTabId],
  )

  // 初始化：实验室信息 + 已绑定会话 + 初始上下文
  React.useEffect(() => {
    if (bootstrappedRef.current) return
    bootstrappedRef.current = true

    void (async () => {
      if (!labId) {
        setError('缺少实验室标识，无法打开科学助理')
        return
      }
      try {
        const snapshot = await window.electronAPI.cslab.getLabSnapshot(labId)
        setLabName(snapshot?.lab.name ?? '实验室')

        const list = await window.electronAPI.listAgentSessions()
        let bound = sortAgentSessions(
          list.filter((session) => !session.archived && session.cslabLabId === labId),
        )

        // 开箱即用：实验室内没有任何研讨会话时自动建立第一个并完成绑定。
        if (bound.length === 0) {
          bound = [await createBoundSession('研讨会话 1')]
        }

        setSessions(bound)
        setAgentSessions((previous) => mergeSessionLists(previous, bound))

        const preferred = focusSessionId && bound.some((session) => session.id === focusSessionId)
          ? focusSessionId
          : bound[0]!.id
        activateSession(preferred)
        setReady(true)

        const initialContext = await window.electronAPI.cslab.getAgentWindowContext(windowId)
        if (initialContext) {
          setContext(initialContext)
          injectPrompt(preferred, initialContext.prompt)
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '初始化科学助理失败')
      }
    })()
  }, [activateSession, createBoundSession, focusSessionId, injectPrompt, labId, setAgentSessions, windowId])

  // 主窗口后续投递的上下文
  React.useEffect(() => {
    const off = window.electronAPI.cslab.onAgentContext((incoming) => {
      if (incoming.labId !== labId) return
      setContext(incoming)
      const target = activeSessionIdRef.current
      if (target) injectPrompt(target, incoming.prompt)
    })
    return off
  }, [injectPrompt, labId])

  const handleCreateSession = React.useCallback(async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const created = await createBoundSession(`研讨会话 ${sessions.length + 1}`)
      setSessions((previous) => sortAgentSessions([created, ...previous]))
      setAgentSessions((previous) => mergeSessionLists(previous, [created]))
      activateSession(created.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建研讨会话失败')
    } finally {
      setCreating(false)
    }
  }, [activateSession, createBoundSession, creating, sessions.length, setAgentSessions])

  // 会话标题由 Agent 自动生成后会回写全局 atom；优先以 atom 为准，保持侧栏标题实时。
  // 两个列表都必须按实验室过滤，避免解绑/删除后回退到旧的本地会话数组形成“幽灵会话”。
  const sessionList = React.useMemo(() => {
    const filterBound = (list: AgentSessionMeta[]): AgentSessionMeta[] =>
      list.filter((session) => !session.archived && session.cslabLabId === labId)
    const source = sessionsInStore.length > 0 ? filterBound(sessionsInStore) : filterBound(sessions)
    return sortAgentSessions(source)
  }, [labId, sessions, sessionsInStore])

  // 当前激活会话被解绑或删除后，自动收敛到列表首项；列表为空则清空选择。
  React.useEffect(() => {
    if (!ready) return
    if (sessionList.length === 0) {
      if (activeSessionId !== null) setActiveSessionId(null)
      return
    }
    if (!activeSessionId || !sessionList.some((session) => session.id === activeSessionId)) {
      activateSession(sessionList[0]!.id)
    }
  }, [ready, sessionList, activeSessionId, activateSession])

  /** 同一次变更同时写入本地列表与全局 atom，保持窗口与主侧栏一致。 */
  const applySessionUpdate = React.useCallback(
    (updated: AgentSessionMeta): void => {
      setSessions((previous) =>
        sortAgentSessions(
          previous.map((session) =>
            session.id === updated.id ? { ...session, ...updated } : session,
          ),
        ),
      )
      setAgentSessions((previous) =>
        sortAgentSessions(
          previous.map((session) =>
            session.id === updated.id ? { ...session, ...updated } : session,
          ),
        ),
      )
    },
    [setAgentSessions],
  )

  const startRename = React.useCallback((session: AgentSessionMeta): void => {
    if (editFocusTimerRef.current !== null) clearTimeout(editFocusTimerRef.current)
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
    justStartedEditingRef.current = true
    // 菜单关闭会争夺焦点，延迟聚焦并等待 Radix 完成关闭动画。
    editFocusTimerRef.current = setTimeout(() => {
      editFocusTimerRef.current = null
      justStartedEditingRef.current = false
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }, 300)
  }, [])

  const cancelRename = React.useCallback((): void => {
    justStartedEditingRef.current = false
    setEditingSessionId(null)
    setEditingTitle('')
  }, [])

  const commitRename = React.useCallback(async (): Promise<void> => {
    if (justStartedEditingRef.current) return
    const sessionId = editingSessionId
    if (!sessionId) return
    const current = sessionList.find((session) => session.id === sessionId)
    const trimmed = editingTitle.trim()
    setEditingSessionId(null)
    setEditingTitle('')
    if (!trimmed || !current || trimmed === current.title) return
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(sessionId, trimmed)
      applySessionUpdate(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名会话失败')
    }
  }, [applySessionUpdate, editingSessionId, editingTitle, sessionList])

  const handleTogglePin = React.useCallback(
    async (session: AgentSessionMeta): Promise<void> => {
      try {
        const updated = await window.electronAPI.togglePinAgentSession(session.id)
        applySessionUpdate(updated)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '切换置顶状态失败')
      }
    },
    [applySessionUpdate],
  )

  const handleRegenerateTitle = React.useCallback(
    async (session: AgentSessionMeta): Promise<void> => {
      if (regeneratingId) return
      setRegeneratingId(session.id)
      setError(null)
      try {
        const updated = await window.electronAPI.regenerateAgentSessionTitle(session.id)
        if (!updated) {
          setError('重新生成标题失败：缺少可用模型或有效消息')
          return
        }
        applySessionUpdate(updated)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '重新生成标题失败')
      } finally {
        setRegeneratingId(null)
      }
    },
    [applySessionUpdate, regeneratingId],
  )

  const handleConfirmDelete = React.useCallback(async (): Promise<void> => {
    const target = deleteTarget
    if (!target || deleting) return
    setDeleting(true)
    setError(null)
    const orderedIds = sessionList.map((session) => session.id)
    const targetIndex = orderedIds.indexOf(target.id)
    try {
      await window.electronAPI.deleteAgentSession(target.id)
      setSessions((previous) => previous.filter((session) => session.id !== target.id))
      setAgentSessions((previous) => previous.filter((session) => session.id !== target.id))
      setDeleteTarget(null)

      if (activeSessionIdRef.current === target.id) {
        const remaining = sessionList.filter((session) => session.id !== target.id)
        const next = remaining[targetIndex] ?? remaining[targetIndex - 1] ?? remaining[0]
        if (next) {
          activateSession(next.id)
        } else {
          const created = await createBoundSession('研讨会话 1')
          setSessions((previous) => sortAgentSessions([created, ...previous]))
          setAgentSessions((previous) => mergeSessionLists(previous, [created]))
          activateSession(created.id)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除会话失败')
    } finally {
      setDeleting(false)
    }
  }, [
    activateSession,
    activeSessionIdRef,
    createBoundSession,
    deleteTarget,
    deleting,
    sessionList,
    setAgentSessions,
  ])

  const renderSessionMenuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
    session: AgentSessionMeta,
  ): React.ReactNode => (
    <>
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5"
        onSelect={() => {
          void handleTogglePin(session)
        }}
      >
        {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {session.pinned ? '取消置顶' : '置顶会话'}
      </MenuItem>
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5"
        onSelect={() => startRename(session)}
      >
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5"
        onSelect={() => {
          void handleRegenerateTitle(session)
        }}
      >
        <Sparkles size={14} />
        重新生成标题
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5 text-destructive focus:text-destructive"
        onSelect={() => setDeleteTarget(session)}
      >
        <Trash2 size={14} />
        删除会话
      </MenuItem>
    </>
  )

  const activeSession = sessionList.find((session) => session.id === activeSessionId)
  const attachedLabel = context?.plotTitle ?? context?.assetUri ?? null

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header
        className="relative flex h-11 shrink-0 items-center gap-2 border-b bg-card/80 px-3"
        style={{ paddingLeft: isMac ? 84 : 12 }}
      >
        <div className="titlebar-drag-region absolute inset-y-0 left-0 right-0" aria-hidden="true" />
        <div className="titlebar-no-drag relative flex min-w-0 items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-3" />
          </span>
          <span className="truncate text-xs font-medium">{labName || '科学助理'}</span>
          {activeSession && (
            <span className="truncate text-[10px] text-muted-foreground">· {activeSession.title}</span>
          )}
        </div>
        <div className="titlebar-no-drag relative ml-auto flex items-center">
          {isWindows && <WindowControls variant="inline" />}
        </div>
      </header>

      <div className="titlebar-no-drag flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-3 py-1.5">
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.label}
              type="button"
              disabled={!activeSessionId}
              onClick={() => {
                if (!activeSessionId) return
                injectPrompt(activeSessionId, action.prompt)
              }}
              className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Icon className="size-3" />
              {action.label}
            </button>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[188px] shrink-0 flex-col border-r bg-muted/20">
          <div className="flex items-center justify-between px-2.5 py-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <span>研讨会话</span>
            <span>{sessionList.length}</span>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateSession()}
            disabled={creating || !ready}
            className="mx-2 mb-1.5 inline-flex items-center justify-center gap-1 rounded-lg border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-50"
          >
            {creating ? <Loader2 className="size-3 animate-spin" /> : <MessageSquarePlus className="size-3" />}
            新建会话
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {sessionList.map((session) => {
              const active = session.id === activeSessionId
              const editing = session.id === editingSessionId
              return (
                <ContextMenu key={session.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        if (editing) return
                        activateSession(session.id)
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        startRename(session)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        if (!editing) activateSession(session.id)
                      }}
                      className={cn(
                        'group mb-1 flex w-full cursor-pointer items-start gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                        active
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-1 size-1.5 shrink-0 rounded-full',
                          active ? 'bg-primary' : 'bg-border',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        {editing ? (
                          <input
                            ref={editInputRef}
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                // 拼音输入法回车选词时不要提交。
                                if (event.nativeEvent.isComposing) return
                                event.preventDefault()
                                event.stopPropagation()
                                void commitRename()
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                event.stopPropagation()
                                cancelRename()
                              }
                            }}
                            onBlur={() => {
                              void commitRename()
                            }}
                            maxLength={100}
                            className="w-full border-b border-primary/50 bg-transparent px-0 py-0 text-[11px] text-foreground outline-none"
                          />
                        ) : (
                          <div className="flex items-center gap-1">
                            {session.pinned && (
                              <Pin size={10} className="shrink-0 text-primary/60" aria-label="已置顶" />
                            )}
                            {regeneratingId === session.id && (
                              <Loader2
                                size={10}
                                className="shrink-0 animate-spin text-muted-foreground"
                                aria-label="正在重新生成标题"
                              />
                            )}
                            <span className="truncate">{session.title}</span>
                          </div>
                        )}
                      </div>
                      {!editing && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`${session.title} 的会话菜单`}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              className="rounded p-0.5 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=open]:opacity-100"
                            >
                              <MoreHorizontal className="size-3" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-40 min-w-0 p-0.5">
                            {renderSessionMenuItems(
                              DropdownMenuItem,
                              DropdownMenuSeparator,
                              session,
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-40 min-w-0 p-0.5">
                    {renderSessionMenuItems(ContextMenuItem, ContextMenuSeparator, session)}
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </div>
          {attachedLabel && (
            <div className="flex items-start gap-1 border-t px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
              <Paperclip className="mt-0.5 size-3 shrink-0" />
              <div className="min-w-0">
                <div className="truncate">当前挂接：{attachedLabel}</div>
                {context?.roi && (
                  <div className="mt-0.5">
                    ROI {context.roi.xMin.toFixed(2)} – {context.roi.xMax.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col">
          {error && (
            <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {!ready && !error && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在准备科学助理…
            </div>
          )}
          {ready && activeSessionId && <AgentView sessionId={activeSessionId} variant="cs-lab" />}
        </main>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除研讨会话</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteTarget?.title ?? ''}」及其全部消息记录。仅影响该会话，不影响实验室数据与其他会话。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmDelete()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
