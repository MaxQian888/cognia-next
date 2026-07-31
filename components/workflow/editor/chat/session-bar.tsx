"use client"

/**
 * Workflow-editor session bar — a compact top strip mounted at the
 * head of the right-sidebar chat tab. Lets the user:
 *
 *   • switch between the default workflow session and any additional
 *     sessions they've spun off for this workflow,
 *   • create a new session,
 *   • rename the active session,
 *   • clear the active conversation (drops messages + sdk link),
 *   • see which handler (Copilot or a specialist subagent) is driving
 *     the next reply.
 *
 * Persistence flows entirely through `lib/db/sessions.ts` and
 * `lib/db/messages.ts` — this component only composes shadcn primitives
 * and the existing DB helpers. The deterministic id contract is:
 *
 *   - default session    : `workflow:${workflowId}`
 *   - additional sessions: `workflow:${workflowId}:${nanoid(6)}`
 *
 * `useWorkflowEditorSession` keeps the default row idempotent across
 * remounts; that hook is NOT modified by this component.
 */

import { useCallback, useDeferredValue, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { HandlerBadge } from "@/components/chat/message-parts/handler-badge"
import { getDb } from "@/lib/db/schema"
import { clearMessages } from "@/lib/db/messages"
import { clearSessionSdkLink, deleteSession, updateSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import {
  createWorkflowEditorSession,
  workflowSessionId,
} from "@/hooks/chat/use-workflow-editor-session"
import type { ChatSession } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface SessionBarProps {
  workflowId: string
  workflowName?: string
  /** Sessions are filtered against this prefix (`workflow:${workflowId}`). */
  activeSessionId: string
  onSwitchSession?: (sessionId: string) => void
  onCreateSession?: (sessionId: string) => void
  className?: string
}

export function WorkflowSessionBar({
  workflowId,
  workflowName,
  activeSessionId,
  onSwitchSession,
  onCreateSession,
  className,
}: SessionBarProps) {
  const t = useTranslations("workflowEditor.chat")
  const defaultSessionId = workflowSessionId(workflowId)

  // Live list of every session whose id starts with the workflow prefix.
  // Sorted by updatedAt desc; the default session is pinned at the top
  // even if it happens to be the oldest row.
  const rawSessions = useLiveQuery<ChatSession[]>(
    () =>
      getDb()
        .sessions.where("id")
        .startsWith(defaultSessionId)
        .toArray()
        .then((rows) =>
          rows.sort((a, b) => {
            if (a.id === defaultSessionId) return -1
            if (b.id === defaultSessionId) return 1
            return b.updatedAt - a.updatedAt
          })
        ),
    [defaultSessionId]
  )
  // Defer the live-query result so rapid Dexie writes (e.g., proposal-
  // history append fan-out, session updatedAt bumps from active typing)
  // don't cascade re-renders of the bar's dropdown + active-row lookup.
  const sessions = useDeferredValue(rawSessions)

  const active = useMemo(
    () => sessions?.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  )

  // ── Rename dialog ─────────────────────────────────────────────────
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  // Seed the input on open via the dialog's onOpenChange callback rather
  // than an effect — avoids cascading renders from a setState inside an
  // effect and keeps the value uncontrolled until the user types.
  const openRenameDialog = useCallback(() => {
    setRenameValue(active?.title ?? "")
    setRenameOpen(true)
  }, [active?.title])

  const handleRenameConfirm = useCallback(async () => {
    if (!active) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      toast.error(t("rename.empty"))
      return
    }
    try {
      await updateSession(active.id, { title: trimmed })
      setRenameOpen(false)
      toast.success(t("rename.success"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [active, renameValue, t])

  // ── Clear dialog ──────────────────────────────────────────────────
  const [clearOpen, setClearOpen] = useState(false)
  const handleClear = useCallback(async () => {
    if (!active) return
    try {
      await clearMessages(active.id)
      await clearSessionSdkLink(active.id)
      useChatStore.getState().replaceSessionMessages(active.id, [])
      setClearOpen(false)
      toast.success(t("session.cleared"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [active, t])

  // ── Create + Switch ───────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    try {
      const title = workflowName
        ? t("session.newSuffixed", { name: workflowName })
        : t("session.newDefault")
      const sessionId = await createWorkflowEditorSession(workflowId, title)
      onCreateSession?.(sessionId)
      toast.success(t("session.created"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [onCreateSession, workflowId, workflowName, t])

  const handleSwitch = useCallback(
    (id: string) => {
      if (onSwitchSession) {
        onSwitchSession(id)
        return
      }
      useChatStore.getState().setActiveSession(id)
      useChatStore.getState().setMessages([])
    },
    [onSwitchSession]
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (sessionId === defaultSessionId) {
        toast.error(t("session.deleteDefaultBlocked"))
        return
      }
      try {
        await deleteSession(sessionId)
        if (activeSessionId === sessionId) {
          if (onSwitchSession) onSwitchSession(defaultSessionId)
          else {
            useChatStore.getState().setActiveSession(defaultSessionId)
            useChatStore.getState().setMessages([])
          }
        }
        toast.success(t("session.deleted"))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [activeSessionId, defaultSessionId, onSwitchSession, t]
  )

  return (
    <div
      className={cn("flex items-center gap-1 border-b px-2 py-1 text-[11px]", className)}
      data-testid="workflow-session-bar"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 max-w-[180px] gap-1 px-2 text-foreground"
            data-testid="workflow-session-switcher"
          >
            <span className="truncate" title={active?.title}>
              {active?.title ?? t("session.placeholder")}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          <DropdownMenuLabel>{t("session.switchLabel")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(sessions ?? []).map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => handleSwitch(s.id)}
              data-testid={`workflow-session-option-${s.id}`}
              data-active={s.id === activeSessionId ? "true" : "false"}
              className={cn(
                "flex flex-col items-start gap-0",
                s.id === activeSessionId && "bg-accent/50"
              )}
            >
              <span className="truncate text-xs font-medium">{s.title}</span>
              {s.id === defaultSessionId ? (
                <span className="text-[10px] text-muted-foreground">{t("session.defaultTag")}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {sessions && sessions.length > 1 ? <DropdownMenuSeparator /> : null}
          {active && active.id !== defaultSessionId ? (
            <DropdownMenuItem
              onSelect={() => void handleDelete(active.id)}
              className="text-destructive focus:text-destructive"
              data-testid="workflow-session-delete"
            >
              {t("session.delete")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => void handleCreate()}
        aria-label={t("session.new")}
        data-testid="workflow-session-new"
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={openRenameDialog}
        disabled={!active}
        aria-label={t("session.rename")}
        data-testid="workflow-session-rename"
      >
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setClearOpen(true)}
        disabled={!active}
        aria-label={t("clear")}
        data-testid="workflow-session-clear"
      >
        <Trash2Icon className="size-3.5" aria-hidden="true" />
      </Button>
      <div className="ml-auto">
        <HandlerBadge
          defaultLabel={t("session.handlerDefault")}
          data-testid="workflow-handler-badge"
        />
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent data-testid="workflow-session-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t("rename.title")}</DialogTitle>
            <DialogDescription>{t("rename.description")}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={t("rename.placeholder")}
            data-testid="workflow-session-rename-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleRenameConfirm()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("rename.cancel")}
            </Button>
            <Button
              onClick={() => void handleRenameConfirm()}
              data-testid="workflow-session-rename-confirm"
            >
              {t("rename.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent data-testid="workflow-session-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("clearConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("clearConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="workflow-session-clear-cancel">
              {t("clearCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleClear()}
              data-testid="workflow-session-clear-confirm"
            >
              {t("clearConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
