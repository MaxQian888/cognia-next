"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  DatabaseIcon,
  GitBranchIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import {
  deleteSdkSession,
  forkSdkSession,
  importSdkSessionToStore,
  listSdkSessions,
  renameSdkSession,
} from "@/lib/claude/ipc"
import {
  getAgentExecutionFlags,
  isAgentExecutionFlagEnabled,
  subscribeToAgentExecutionFlags,
} from "@/lib/ai/agent/execution/feature-flags"
import {
  resolveAgentExecutionSpec,
  sendSpecFromResolved,
} from "@/lib/ai/agent/execution/resolve-agent-execution-spec"
import { isTauri } from "@/lib/tauri"

interface SdkSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  customTitle?: string
  cwd?: string
  tag?: string
}

type SdkSessionErrorKey = "errors.loadFailed"

export function SdkSessionManager() {
  const t = useTranslations("settings.agentRuntimeSection.sessions.sdk")
  const enabled = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled("claudeSdkParityV1"),
    () => false
  )
  const sessionStoreEnabled = useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled("claudeSdkSessionStore"),
    () => false
  )
  const desktop = isTauri()
  const [sessions, setSessions] = useState<SdkSessionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SdkSessionErrorKey | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SdkSessionInfo | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<SdkSessionInfo | null>(null)

  const load = useCallback(async () => {
    if (!desktop || !enabled) return
    setLoading(true)
    setError(null)
    try {
      setSessions(await listSdkSessions<SdkSessionInfo[]>())
    } catch {
      setError("errors.loadFailed")
    } finally {
      setLoading(false)
    }
  }, [desktop, enabled])

  useEffect(() => {
    if (!desktop || !enabled) return
    const timer = globalThis.setTimeout(() => void load(), 0)
    return () => globalThis.clearTimeout(timer)
  }, [desktop, enabled, load])

  if (!desktop) return null

  const onRename = async () => {
    if (!renameTarget || !renameDraft.trim()) return
    setBusyId(renameTarget.sessionId)
    try {
      await renameSdkSession(renameTarget.sessionId, renameDraft.trim())
      toast.success(t("renamed"))
      setRenameTarget(null)
      await load()
    } catch {
      toast.error(t("errors.renameFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onFork = async (session: SdkSessionInfo) => {
    setBusyId(session.sessionId)
    try {
      await forkSdkSession(session.sessionId)
      toast.success(t("forked"))
      await load()
    } catch {
      toast.error(t("errors.forkFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onDelete = async () => {
    if (!deleteTarget) return
    setBusyId(deleteTarget.sessionId)
    try {
      await deleteSdkSession(deleteTarget.sessionId)
      toast.success(t("deleted"))
      setDeleteTarget(null)
      await load()
    } catch {
      toast.error(t("errors.deleteFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const onImportStore = async (session: SdkSessionInfo) => {
    if (!session.cwd) return
    setBusyId(session.sessionId)
    try {
      const { spec } = resolveAgentExecutionSpec({
        surface: "chat",
        environment: { isTauri: desktop, isHeadlessHost: false },
        flags: getAgentExecutionFlags(),
        policy: { executionKind: "agent", runtimePolicy: "claude-agent-sdk" },
        legacy: { providerId: "anthropic" },
        identity: { sessionId: session.sessionId },
      })
      await importSdkSessionToStore(session.sessionId, {
        cwd: session.cwd,
        execution: sendSpecFromResolved(spec),
        claudeAgentSdk: {
          version: 1,
          persistSession: true,
          sessionStore: { backend: "host-sqlite" },
        },
      })
      toast.success(t("imported"))
    } catch {
      toast.error(t("errors.importFailed"))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <SettingsBlock
        title={t("title")}
        description={t("description")}
        testid="sdk-session-manager"
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">{t("count", { count: sessions.length })}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={!enabled || loading}
            aria-label={t("refresh")}
          >
            {loading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
        </div>
        {!enabled ? (
          <p className="text-xs text-muted-foreground">{t("disabled")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">{t(error)}</p>
        ) : sessions.length === 0 && !loading ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {sessions.map((session) => (
              <li key={session.sessionId} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {session.customTitle || session.summary}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {session.cwd || session.sessionId}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === session.sessionId}
                    aria-label={t("rename")}
                    onClick={() => {
                      setRenameTarget(session)
                      setRenameDraft(session.customTitle || session.summary)
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === session.sessionId}
                    aria-label={t("fork")}
                    onClick={() => void onFork(session)}
                  >
                    <GitBranchIcon className="size-3.5" />
                  </Button>
                  {sessionStoreEnabled && session.cwd && (
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={busyId === session.sessionId}
                      aria-label={t("importStore")}
                      onClick={() => void onImportStore(session)}
                    >
                      <DatabaseIcon className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busyId === session.sessionId}
                    aria-label={t("delete")}
                    onClick={() => setDeleteTarget(session)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsBlock>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            <DialogDescription>{t("renameDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            aria-label={t("titleLabel")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("cancel")}
            </Button>
            <Button disabled={!renameDraft.trim()} onClick={() => void onRename()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => void onDelete()}
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
