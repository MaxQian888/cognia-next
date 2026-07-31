"use client"

/**
 * Sessions tab — visualisation of `lib/db/sessions` rows enriched with
 * per-session token + USD totals from `lib/db/session-usage`.
 *
 * Stage 2 of the ClaudeCode 完整化 plan. The slash commands `/sessions`,
 * `/resume`, `/cost` already expose this data inside chat; the tab is the
 * GUI-friendly counterpart so users don't have to type a command to see
 * what's running. Resume / Fork / Rename / Delete map to the existing
 * helpers in `lib/db/sessions.ts` so the tab is purely presentational.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"

import {
  deleteSession,
  forkSessionFromParent,
  listSessions,
  updateSession,
} from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { ChatSession } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import { loggers } from "@cognia/logging"

interface RowSummary {
  session: ChatSession
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

export function SessionsTab() {
  const t = useTranslations("settings.agentRuntimeSection.sessions")
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // Live read of every session row, sorted newest-first by Dexie's index.
  const liveSessions = useLiveQuery(() => listSessions(), [])
  const sessions = useMemo(() => liveSessions ?? [], [liveSessions])

  // Live read of every usage row. Aggregated client-side (typically <10k rows).
  const liveUsage = useLiveQuery(() => getDb().sessionUsage.toArray(), [])
  const usageRows = useMemo(() => liveUsage ?? [], [liveUsage])

  // Re-render once a minute so the "Updated x ago" column refreshes without
  // touching `Date.now()` directly during render (impure).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const [filter, setFilter] = useState("")
  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Pre-bucket usage rows by sessionId so the merge loop is O(sessions+usage).
  const totalsBySession = useMemo(() => {
    const map = new Map<
      string,
      {
        turns: number
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        costUsd: number
      }
    >()
    for (const r of usageRows as SessionUsageRow[]) {
      const slot = map.get(r.sessionId) ?? {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      }
      slot.turns += 1
      slot.inputTokens += r.inputTokens
      slot.outputTokens += r.outputTokens
      slot.cacheReadTokens += r.cacheReadTokens
      slot.costUsd += r.costUsd
      map.set(r.sessionId, slot)
    }
    return map
  }, [usageRows])

  const rows: RowSummary[] = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: RowSummary[] = []
    for (const session of sessions as ChatSession[]) {
      if (q) {
        const haystack = `${session.title} ${session.id}`.toLowerCase()
        if (!haystack.includes(q)) continue
      }
      const totals = totalsBySession.get(session.id) ?? {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      }
      out.push({ session, ...totals })
    }
    return out
  }, [sessions, totalsBySession, filter])

  const onResume = (session: ChatSession) => {
    setActiveSession(session.id)
    toast.success(t("resumedToast", { title: session.title || session.id }))
  }

  /**
   * Low-level SDK-session fork, kept only on this runtime/debug surface.
   *
   * The chat-side entry to this was removed: `branchSessionAtMessage` is a
   * superset for anything a user wants (it reuses the same SDK fork at the tail
   * AND carries the messages, the lineage and every per-session setting). What
   * survives here is the raw operation — a new session bound to the parent's
   * SDK conversation with no transcript — which is occasionally what you want
   * when inspecting the runtime, and nothing else offers it.
   */
  const onForkSdkSession = async (session: ChatSession) => {
    setBusyId(session.id)
    try {
      const next = await forkSessionFromParent(session.id)
      setActiveSession(next.id)
      toast.success(t("forkedToast", { title: next.title }))
    } catch (err) {
      // `forkSessionFromParent` throws a bare English Error when the parent has
      // no `sdkSessionId` yet — which is *always* the case for providers that
      // never issue one. Surfacing `err.message` put untranslated internals in
      // front of the user; the reason is already conveyed by the disabled state
      // and its tooltip, so the toast just names the failure.
      toast.error(t("forkFailedToast"))
      loggers.chat.warn("sdk-session-fork-failed", {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyId(null)
    }
  }

  const openRename = (session: ChatSession) => {
    setRenameTarget(session)
    setRenameDraft(session.title ?? "")
  }

  const commitRename = async () => {
    if (!renameTarget) return
    const trimmed = renameDraft.trim()
    if (!trimmed) {
      toast.error(t("renameEmpty"))
      return
    }
    setBusyId(renameTarget.id)
    try {
      await updateSession(renameTarget.id, { title: trimmed })
      toast.success(t("renamedToast"))
      setRenameTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const commitDelete = async () => {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    try {
      await deleteSession(deleteTarget.id)
      toast.success(t("deletedToast"))
      // If the chat store points at the row we just removed, clear it so the
      // inactive empty state picks up.
      if (activeSessionId === deleteTarget.id) setActiveSession(null)
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="sessions-tab">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filterPlaceholder")}
            className="text-sm"
            data-testid="sessions-filter"
          />
          {rows.length === 0 ? (
            <p className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground">
              {sessions.length === 0 ? t("emptyAll") : t("emptyFilter")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colTitle")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("colKind")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("colUpdated")}</TableHead>
                    <TableHead className="text-right">{t("colTurns")}</TableHead>
                    <TableHead className="text-right">{t("colTokens")}</TableHead>
                    <TableHead className="text-right">{t("colCost")}</TableHead>
                    <TableHead className="text-right">{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.session.id}
                      data-testid={`session-row-${r.session.id}`}
                      data-active={r.session.id === activeSessionId ? "true" : undefined}
                      className={r.session.id === activeSessionId ? "bg-primary/5" : undefined}
                    >
                      <TableCell className="max-w-[18rem] truncate font-medium">
                        {r.session.title || t("untitled")}
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {r.session.id}
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="text-[10px]">
                          {r.session.kind ?? "direct"}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {formatRelative(now - r.session.updatedAt, t)}
                      </TableCell>
                      <TableCell className="text-right text-xs">{r.turns}</TableCell>
                      <TableCell className="text-right text-xs">
                        {(r.inputTokens + r.outputTokens + r.cacheReadTokens).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => onResume(r.session)}
                            disabled={busyId === r.session.id}
                            aria-label={t("resume")}
                            title={t("resume")}
                            data-testid={`resume-${r.session.id}`}
                          >
                            <PlayIcon className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => void onForkSdkSession(r.session)}
                            disabled={busyId === r.session.id || !r.session.sdkSessionId}
                            aria-label={t("fork")}
                            title={r.session.sdkSessionId ? t("fork") : t("forkDisabledTip")}
                            data-testid={`fork-${r.session.id}`}
                          >
                            <GitBranchIcon className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => openRename(r.session)}
                            disabled={busyId === r.session.id}
                            aria-label={t("rename")}
                            title={t("rename")}
                            data-testid={`rename-${r.session.id}`}
                          >
                            <PencilIcon className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(r.session)}
                            disabled={busyId === r.session.id}
                            aria-label={t("delete")}
                            title={t("delete")}
                            data-testid={`delete-${r.session.id}`}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rename dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            <DialogDescription>{t("renameDesc")}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder={t("renamePlaceholder")}
            aria-label={t("renameTitle")}
            data-testid="rename-input"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void commitRename()} data-testid="rename-confirm">
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDesc", { title: deleteTarget?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void commitDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="delete-confirm"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatRelative(
  deltaMs: number,
  t: (k: string, vars?: Record<string, string | number | Date>) => string
): string {
  if (deltaMs < 60_000) return t("ago.justNow")
  if (deltaMs < 3_600_000) return t("ago.minutes", { n: Math.floor(deltaMs / 60_000) })
  if (deltaMs < 86_400_000) return t("ago.hours", { n: Math.floor(deltaMs / 3_600_000) })
  return t("ago.days", { n: Math.floor(deltaMs / 86_400_000) })
}

export default SessionsTab
