"use client"

/**
 * Live in-session MCP client health for the active chat session, driven by the
 * Claude Agent SDK's `mcpServerStatus()` control method (see
 * `lib/claude/ipc.ts:getSessionMcpStatus`). Complements the per-server
 * config-time sidecar discovery: that asks "is this config valid?"; this
 * shows "what the running agent session actually sees right now" — including the
 * in-process cognia / a2ui / plugin servers that have no `McpServer` row — and
 * lets the user reconnect a dropped server or toggle one without restarting.
 *
 * Desktop + Anthropic + open-session only; hides itself otherwise (the control
 * call rejects with a stable code on the ai-sdk path / when no session is open).
 */

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { PlugZapIcon, RefreshCwIcon, ScrollTextIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import {
  getSessionMcpStatus,
  reconnectSessionMcpServer,
  toggleSessionMcpServer,
} from "@/lib/claude/ipc"
import type { SdkMcpServerStatus } from "@cognia/agent-config-types"
import { mcpServerLogsHref, useMcpServerLogs } from "@/hooks/mcp/use-mcp-server-logs"

const STATUS_STYLE: Record<SdkMcpServerStatus["status"], string> = {
  connected: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
  "needs-auth": "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  pending: "bg-muted text-muted-foreground",
  disabled: "bg-muted text-muted-foreground",
}

/** Map an SDK status to its i18n label key under `mcp.liveSession.status.*`. */
const STATUS_LABEL_KEY: Record<SdkMcpServerStatus["status"], string> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "needsAuth",
  pending: "pending",
  disabled: "disabled",
}

export function McpLiveSessionCard() {
  const t = useTranslations("mcp.liveSession")
  const sessionId = useChatStore((s) => s.activeSessionId)
  const [rows, setRows] = useState<SdkMcpServerStatus[] | null>(null)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const [busyServer, setBusyServer] = useState<string | null>(null)
  // The session this card is currently showing. An async operation (reconnect /
  // toggle / refresh) that resolves AFTER the user switched sessions must not
  // write the old session's rows into the new session's view — every write is
  // guarded against this ref, which the load effect keeps in sync.
  const shownSessionRef = useRef<string | null>(null)

  // Fetch fresh rows and apply them only if the shown session hasn't changed
  // since this operation began — otherwise the result belongs to a now-hidden
  // session and must be dropped.
  const applyStatusIfCurrent = async (forSession: string) => {
    const fresh = await getSessionMcpStatus(forSession)
    if (shownSessionRef.current === forSession) {
      setRows(fresh)
      setAvailable(true)
    }
  }

  // Initial / on-session-change load, followed by a BOUNDED settle poll: first
  // connections resolve asynchronously (a `pending` server finishing its
  // handshake, a `failed` one being auto-reconnected by the sidecar), so while
  // any server is still pending/failed the card re-polls up to 6 times (~15s)
  // and converges on the real status without the user hammering refresh. A
  // permanently failed server stops generating traffic once the budget is
  // spent. State is written only in async callbacks (never synchronously in
  // the effect body) — mirrors mcp-health-tab.
  useEffect(() => {
    if (!(isTauri() && sessionId)) return
    shownSessionRef.current = sessionId
    let cancelled = false
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const unsettled = (r: SdkMcpServerStatus[]) =>
      r.some((s) => s.status === "pending" || s.status === "failed")
    ;(async () => {
      let current: SdkMcpServerStatus[]
      try {
        current = await getSessionMcpStatus(sessionId)
      } catch {
        if (!cancelled) {
          // no_active_session / unsupported_provider / timeout → hide the card.
          setAvailable(false)
          setRows(null)
        }
        return
      }
      if (cancelled) return
      setRows(current)
      setAvailable(true)
      for (let i = 0; i < 6 && !cancelled && unsettled(current); i++) {
        await sleep(2500)
        if (cancelled || shownSessionRef.current !== sessionId) return
        try {
          current = await getSessionMcpStatus(sessionId)
        } catch {
          // A settle-poll failure is not a reason to hide an already-rendered
          // card — just stop polling; the user can still refresh manually.
          return
        }
        if (cancelled || shownSessionRef.current !== sessionId) return
        setRows(current)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!isTauri() || !sessionId || !available) return null

  const refresh = async () => {
    const forSession = sessionId
    setLoading(true)
    try {
      await applyStatusIfCurrent(forSession)
    } catch {
      if (shownSessionRef.current === forSession) {
        setAvailable(false)
        setRows(null)
      }
    } finally {
      if (shownSessionRef.current === forSession) setLoading(false)
    }
  }

  const handleReconnect = async (name: string) => {
    const forSession = sessionId
    setBusyServer(name)
    try {
      await reconnectSessionMcpServer(forSession, name)
      toast.success(t("reconnectStarted", { name }))
      await applyStatusIfCurrent(forSession)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (shownSessionRef.current === forSession) setBusyServer(null)
    }
  }

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    const forSession = sessionId
    setBusyServer(name)
    try {
      await toggleSessionMcpServer(forSession, name, currentlyDisabled)
      await applyStatusIfCurrent(forSession)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (shownSessionRef.current === forSession) setBusyServer(null)
    }
  }

  return (
    <Card data-testid="mcp-live-session-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PlugZapIcon className="size-3.5" />
              {t("title")}
            </CardTitle>
            <CardDescription className="text-xs">{t("subtitle")}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("refresh")}
          >
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows && rows.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          (rows ?? []).map((srv) => (
            <LiveSessionRow
              key={srv.name}
              srv={srv}
              busy={busyServer === srv.name}
              t={t}
              onReconnect={handleReconnect}
              onToggle={handleToggle}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

/**
 * One live-session server row. Combines the SDK-reported status (from
 * `mcpServerStatus()`) with the most recent bridged log line for the same
 * server (`useMcpServerLogs`) — the SDK only carries an `error` string for a
 * failed status, so a captured `stderr` warning while "connected" would
 * otherwise be invisible. Rendered per-server so the hook is called at the top
 * level of its own component (never inside a `.map`).
 */
function LiveSessionRow({
  srv,
  busy,
  t,
  onReconnect,
  onToggle,
}: {
  srv: SdkMcpServerStatus
  busy: boolean
  t: ReturnType<typeof useTranslations>
  onReconnect: (name: string) => Promise<void> | void
  onToggle: (name: string, currentlyDisabled: boolean) => Promise<void> | void
}) {
  const isDisabled = srv.status === "disabled"
  const canReconnect = srv.status === "failed" || srv.status === "needs-auth"
  const { lastError, lastEntry } = useMcpServerLogs(srv.name, { limit: 20 })

  // Prefer the SDK error; otherwise fall back to the most recent bridged error
  // line, then to the most recent log line of any level.
  const recent = srv.error
    ? { message: srv.error, isError: true, time: null as string | null }
    : lastError
      ? { message: lastError.message, isError: true, time: lastError.timestamp }
      : lastEntry
        ? { message: lastEntry.message, isError: false, time: lastEntry.timestamp }
        : null

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 text-xs"
      data-testid={`mcp-live-row-${srv.name}`}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{srv.name}</span>
      <Badge variant="secondary" className={cn("shrink-0 text-[10px]", STATUS_STYLE[srv.status])}>
        {t(`status.${STATUS_LABEL_KEY[srv.status]}`)}
      </Badge>
      {srv.tools && srv.tools.length > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("toolsCount", { count: srv.tools.length })}
        </span>
      ) : null}
      <Button asChild variant="ghost" size="icon" className="size-6 shrink-0" title={t("viewLogs")}>
        <Link href={mcpServerLogsHref(srv.name)} aria-label={t("viewLogsFor", { name: srv.name })}>
          <ScrollTextIcon className="size-3" />
        </Link>
      </Button>
      {recent ? (
        <span
          className={cn(
            "w-full truncate text-[10px]",
            recent.isError ? "text-destructive" : "text-muted-foreground"
          )}
          title={recent.message}
        >
          {recent.time
            ? t("recentLogAt", {
                time: new Date(recent.time).toLocaleTimeString(),
                message: recent.message,
              })
            : recent.message}
        </span>
      ) : null}
      {canReconnect ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-[10px]"
          onClick={() => void onReconnect(srv.name)}
          disabled={busy}
        >
          {t("reconnect")}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-[10px]"
        onClick={() => void onToggle(srv.name, isDisabled)}
        disabled={busy}
      >
        {isDisabled ? t("enable") : t("disable")}
      </Button>
    </div>
  )
}
