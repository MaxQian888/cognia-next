"use client"

/**
 * Settings → Agent Runtime → Sessions: the RUNTIME view of conversations.
 *
 * Conversation history is managed on the Conversations page (`/conversations`,
 * ADR-0213), which is built on the sidebar's list model and its shared row
 * actions (teardown on delete, `titleAuto: false` on rename, Host routing,
 * archive with Undo). This tab used to be a second, weaker manager that
 * bypassed all of that, so it no longer renames, deletes or "resumes". It
 * answers the runtime questions instead, in three blocks:
 *
 * 1. Conversation history — live active/archived counts across every
 *    workspace and the way into the Conversations page and its archive.
 * 2. SDK-bound conversations — the exposed conversations that resume a native
 *    Claude Agent SDK session, with their storage backend, last activity and
 *    recorded usage (priced through `aggregateBySession`, so unpriced turns
 *    render as a lower bound rather than a settled figure). Per row: open the
 *    conversation (through the session link, which switches workspace), fork
 *    the raw SDK session, or unlink it.
 * 3. Native SDK sessions — `SdkSessionManager`, the SDK's own session store.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ExternalLinkIcon, GitBranchIcon, MessagesSquareIcon, UnlinkIcon } from "lucide-react"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadingRegion } from "@/components/ui/loading-region"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { SdkSessionManager } from "@/components/settings/agent-runtime/sdk-session-manager"
import {
  countExposedConversations,
  filterSdkBoundConversations,
  selectSdkBoundConversations,
  sessionLastActivity,
} from "@/components/settings/agent-runtime/sdk-bound-conversations"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { isSessionHandoffLocked } from "@/hooks/chat/use-session-write"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { clearSessionSdkLink, forkSessionFromParent, listSessions } from "@/lib/db/sessions"
import { formatTokens } from "@/lib/observability/format-utils"
import { formatBucketCost, UNKNOWN_COST } from "@/lib/usage/session-analytics"
import { useSessionUsageSummaries } from "@/hooks/usage/use-session-usage-summaries"
import { conversationManagerHref } from "@/lib/conversations/conversation-manager"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"

const EMPTY_SESSIONS: ChatSession[] = []

/** Open a conversation the way every other "open this chat" link does. */
function conversationHref(sessionId: string): string {
  return `/${buildSessionHref(sessionId)}`
}

export function SessionsTab() {
  // One live read of every session row, shared by both blocks. `undefined`
  // until the first result lands — the blocks render that as loading, never
  // as an empty table.
  const sessions = useClientLiveQuery(() => listSessions(), [], EMPTY_SESSIONS)

  return (
    <div className="min-w-0" data-testid="sessions-tab">
      <SettingsStack>
        <ConversationManagerEntry sessions={sessions} />
        <SdkBoundConversations sessions={sessions} />
        <SdkSessionManager />
      </SettingsStack>
    </div>
  )
}

/* ── Conversation history entry ─────────────────────────────────────────── */

function ConversationManagerEntry({ sessions }: { sessions: ChatSession[] | undefined }) {
  const t = useTranslations("settings.agentRuntimeSection.sessions.manager")
  const counts = useMemo(() => (sessions ? countExposedConversations(sessions) : null), [sessions])

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      icon={<MessagesSquareIcon />}
      testid="sessions-manager-entry"
      contentClassName="space-y-3"
    >
      <LoadingRegion
        loading={counts === null}
        label={t("loading")}
        showDetail={false}
        fallback={
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-5 w-32" />
          </div>
        }
      >
        {counts ? (
          <ul
            aria-label={t("countsLabel")}
            className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums"
          >
            <li data-testid="sessions-manager-active">
              {t("activeCount", { count: counts.active })}
            </li>
            <li className="text-muted-foreground" data-testid="sessions-manager-archived">
              {t("archivedCount", { count: counts.archived })}
            </li>
          </ul>
        ) : null}
      </LoadingRegion>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={conversationManagerHref("active")}>{t("open")}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={conversationManagerHref("archived")}>{t("openArchive")}</Link>
        </Button>
      </div>
    </SettingsBlock>
  )
}

/* ── SDK-bound conversations ────────────────────────────────────────────── */

function SdkBoundConversations({ sessions }: { sessions: ChatSession[] | undefined }) {
  const t = useTranslations("settings.agentRuntimeSection.sessions.bound")
  const tRow = useTranslations("desktop.sessionRow")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()

  const [filter, setFilter] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [unlinkTarget, setUnlinkTarget] = useState<ChatSession | null>(null)

  // Conversations with a turn in flight in this renderer. Unlinking one then
  // would be undone by the running turn, which stamps the id it resumed back
  // onto the row. A joined string keeps the selector's result stable.
  const runningKey = useChatStore((s) =>
    Object.keys(s.sessions)
      .filter((id) => {
        const status = s.sessions[id]?.status
        return status === "streaming" || status === "awaiting_approval"
      })
      .sort()
      .join("\n")
  )
  const running = useMemo(() => new Set(runningKey ? runningKey.split("\n") : []), [runningKey])

  const bound = useMemo(
    () => (sessions ? selectSdkBoundConversations(sessions) : undefined),
    [sessions]
  )
  const boundIds = useMemo(() => (bound ?? []).map((session) => session.id), [bound])
  const { summaries: usageBySession, loading: usageLoading } = useSessionUsageSummaries(boundIds)

  const untitled = tRow("untitled")
  const placeholder = tRow("placeholderTitle")
  const titleOf = useCallback(
    (session: Pick<ChatSession, "title">) =>
      sessionDisplayTitle(session.title, { untitled, placeholder }),
    [untitled, placeholder]
  )
  const rows = useMemo(
    () => (bound ? filterSdkBoundConversations(bound, filter, titleOf) : []),
    [bound, filter, titleOf]
  )

  const loading = bound === undefined || usageLoading

  /**
   * Low-level SDK-session fork, kept only on this runtime surface.
   *
   * The chat-side entry to this was removed: `branchSessionAtMessage` is a
   * superset for anything a user wants (it reuses the same SDK fork at the tail
   * AND carries the messages, the lineage and every per-session setting). What
   * survives here is the raw operation — a new conversation bound to the
   * parent's SDK conversation with no transcript — which is occasionally what
   * you want when inspecting the runtime, and nothing else offers it.
   */
  const onFork = async (session: ChatSession) => {
    setBusyId(session.id)
    try {
      const next = await forkSessionFromParent(session.id)
      toast.success(t("forkedToast", { title: titleOf(next) }))
      router.push(conversationHref(next.id))
    } catch (err) {
      // The thrown text is English internals ("Cannot fork: …"); the toast
      // names the failure and the log keeps the detail.
      toast.error(isSessionHandoffLocked(err) ? t("lockedReason") : t("forkFailedToast"))
      loggers.chat.warn("sdk-session-fork-failed", {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyId(null)
    }
  }

  const commitUnlink = async (session: ChatSession) => {
    setBusyId(session.id)
    try {
      await clearSessionSdkLink(session.id)
      toast.success(t("unlinkedToast"))
    } catch (err) {
      toast.error(isSessionHandoffLocked(err) ? t("lockedReason") : t("unlinkFailedToast"))
      loggers.chat.warn("sdk-session-unlink-failed", {
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      icon={<GitBranchIcon />}
      badge={
        bound ? (
          <Badge variant="secondary" data-testid="sdk-bound-count">
            {t("count", { count: bound.length })}
          </Badge>
        ) : undefined
      }
      testid="sdk-bound-conversations"
      contentClassName="space-y-3"
    >
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("filterPlaceholder")}
        aria-label={t("filterLabel")}
        className="text-sm"
        disabled={loading || bound.length === 0}
      />
      <LoadingRegion
        loading={loading}
        label={t("loading")}
        showDetail={false}
        fallback={
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        }
      >
        {loading ? null : bound.length === 0 || rows.length === 0 ? (
          <p className="rounded border bg-muted/30 p-4 text-center text-xs text-muted-foreground">
            {bound.length === 0 ? t("empty") : t("emptyFilter")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("col.conversation")}</TableHead>
                  <TableHead className="hidden @lg/settings-stack:table-cell">
                    {t("col.sdkSession")}
                  </TableHead>
                  <TableHead className="hidden @xl/settings-stack:table-cell">
                    {t("col.storage")}
                  </TableHead>
                  <TableHead className="hidden @lg/settings-stack:table-cell">
                    {t("col.lastActivity")}
                  </TableHead>
                  <TableHead className="hidden text-right @xl/settings-stack:table-cell">
                    {t("col.turns")}
                  </TableHead>
                  <TableHead className="hidden text-right @xl/settings-stack:table-cell">
                    {t("col.tokens")}
                  </TableHead>
                  <TableHead className="text-right">{t("col.cost")}</TableHead>
                  <TableHead className="text-right">{t("col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((session) => {
                  const title = titleOf(session)
                  const usage = usageBySession.get(session.id)
                  const turns = usage?.turns ?? 0
                  const backend = session.sdkSessionStorage?.backend
                  const busy = busyId === session.id
                  const lockedReason = session.handoffLock ? t("lockedReason") : null
                  const unlinkReason =
                    lockedReason ?? (running.has(session.id) ? t("runningReason") : null)
                  return (
                    <TableRow key={session.id} data-testid={`sdk-bound-row-${session.id}`}>
                      <TableCell className="max-w-[16rem]">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{title}</span>
                          {session.archivedAt != null ? (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {t("archived")}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden max-w-[10rem] @lg/settings-stack:table-cell">
                        <span
                          className="block truncate font-mono text-[11px] text-muted-foreground"
                          title={session.sdkSessionId}
                        >
                          {session.sdkSessionId}
                        </span>
                      </TableCell>
                      <TableCell className="hidden text-xs @xl/settings-stack:table-cell">
                        {backend ? (
                          <>
                            <span>
                              {backend === "host-sqlite"
                                ? t("storage.hostSqlite")
                                : t("storage.filesystem")}
                            </span>
                            {backend === "host-sqlite" && session.sdkSessionStorage?.workspace ? (
                              <span className="block max-w-[10rem] truncate font-mono text-[10px] text-muted-foreground">
                                {session.sdkSessionStorage.workspace}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground">{UNKNOWN_COST}</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground @lg/settings-stack:table-cell">
                        {format.relativeTime(new Date(sessionLastActivity(session)), now)}
                      </TableCell>
                      <TableCell className="hidden text-right text-xs tabular-nums @xl/settings-stack:table-cell">
                        {turns}
                      </TableCell>
                      <TableCell className="hidden text-right text-xs tabular-nums @xl/settings-stack:table-cell">
                        {formatTokens(usage?.tokens ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {usage && turns > 0
                          ? formatBucketCost(usage.costUsd, usage.unpricedTurns, turns)
                          : UNKNOWN_COST}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <RowAction
                            label={t("openNamed", { title })}
                            tooltip={t("open")}
                            icon={<ExternalLinkIcon className="size-3.5" />}
                            onClick={() => router.push(conversationHref(session.id))}
                            testId={`sdk-bound-open-${session.id}`}
                          />
                          <RowAction
                            label={t("forkNamed", { title })}
                            tooltip={t("forkHint")}
                            reason={lockedReason}
                            disabled={busy}
                            icon={<GitBranchIcon className="size-3.5" />}
                            onClick={() => void onFork(session)}
                            testId={`sdk-bound-fork-${session.id}`}
                          />
                          <RowAction
                            label={t("unlinkNamed", { title })}
                            tooltip={t("unlink")}
                            reason={unlinkReason}
                            disabled={busy}
                            destructive
                            icon={<UnlinkIcon className="size-3.5" />}
                            onClick={() => setUnlinkTarget(session)}
                            testId={`sdk-bound-unlink-${session.id}`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </LoadingRegion>

      <AlertDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("unlinkTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {unlinkTarget
                ? t("unlinkDescription", {
                    title: titleOf(unlinkTarget),
                    sdkSessionId: unlinkTarget.sdkSessionId ?? "",
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (unlinkTarget) void commitUnlink(unlinkTarget)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("unlinkConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsBlock>
  )
}

interface RowActionProps {
  /** Accessible name — names the row, since every row repeats the action. */
  label: string
  /** Visible hover/focus text. */
  tooltip: string
  /**
   * Why the action is unavailable. Replaces the tooltip and is announced as
   * the button's description. A disabled button receives no pointer or focus
   * events, so the tooltip hangs off a focusable wrapper instead.
   */
  reason?: string | null
  /** Unavailable for a transient reason (a write in flight) — no explanation. */
  disabled?: boolean
  destructive?: boolean
  icon: ReactNode
  onClick: () => void
  testId: string
}

function RowAction({
  label,
  tooltip,
  reason,
  disabled = false,
  destructive = false,
  icon,
  onClick,
  testId,
}: RowActionProps) {
  const reasonId = useId()
  const blocked = Boolean(reason)
  const button = (
    <Button
      size="icon"
      variant="ghost"
      className={cn(
        "size-7",
        destructive && "text-destructive hover:text-destructive",
        blocked && "pointer-events-none"
      )}
      disabled={disabled || blocked}
      aria-label={label}
      aria-describedby={blocked ? reasonId : undefined}
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
    </Button>
  )
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {blocked ? (
            <span
              tabIndex={0}
              className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`${testId}-blocked`}
            >
              {button}
            </span>
          ) : (
            button
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64 text-xs">
          {reason ?? tooltip}
        </TooltipContent>
      </Tooltip>
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  )
}

export default SessionsTab
