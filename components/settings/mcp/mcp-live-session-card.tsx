"use client"

/**
 * Live in-session MCP client health for the active chat session, driven by the
 * Claude Agent SDK's `mcpServerStatus()` control method (see
 * `lib/claude/ipc.ts:getSessionMcpStatus`). Complements the per-server
 * config-time probe (`testMcpServer`): that asks "is this config valid?"; this
 * shows "what the running agent session actually sees right now" — including the
 * in-process cognia / a2ui / plugin servers that have no `McpServer` row — and
 * lets the user reconnect a dropped server or toggle one without restarting.
 *
 * Desktop + Anthropic + open-session only; hides itself otherwise (the control
 * call rejects with a stable code on the ai-sdk path / when no session is open).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PlugZapIcon, RefreshCwIcon } from "lucide-react"
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
import type { SdkMcpServerStatus } from "@/lib/claude/types"

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

  // Initial / on-session-change load. State is written only in the promise
  // callbacks (never synchronously in the effect body) — mirrors mcp-health-tab.
  useEffect(() => {
    if (!(isTauri() && sessionId)) return
    let cancelled = false
    getSessionMcpStatus(sessionId)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setAvailable(true)
      })
      .catch(() => {
        if (cancelled) return
        // no_active_session / unsupported_provider / timeout → hide the card.
        setAvailable(false)
        setRows(null)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!isTauri() || !sessionId || !available) return null

  const refresh = async () => {
    setLoading(true)
    try {
      setRows(await getSessionMcpStatus(sessionId))
      setAvailable(true)
    } catch {
      setAvailable(false)
      setRows(null)
    } finally {
      setLoading(false)
    }
  }

  const handleReconnect = async (name: string) => {
    setBusyServer(name)
    try {
      await reconnectSessionMcpServer(sessionId, name)
      toast.success(t("reconnectStarted", { name }))
      setRows(await getSessionMcpStatus(sessionId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyServer(null)
    }
  }

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    setBusyServer(name)
    try {
      await toggleSessionMcpServer(sessionId, name, currentlyDisabled)
      setRows(await getSessionMcpStatus(sessionId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyServer(null)
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
          (rows ?? []).map((srv) => {
            const isDisabled = srv.status === "disabled"
            const canReconnect = srv.status === "failed" || srv.status === "needs-auth"
            return (
              <div
                key={srv.name}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 text-xs"
                data-testid={`mcp-live-row-${srv.name}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{srv.name}</span>
                <Badge
                  variant="secondary"
                  className={cn("shrink-0 text-[10px]", STATUS_STYLE[srv.status])}
                >
                  {t(`status.${STATUS_LABEL_KEY[srv.status]}`)}
                </Badge>
                {srv.tools && srv.tools.length > 0 ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("toolsCount", { count: srv.tools.length })}
                  </span>
                ) : null}
                {srv.error ? (
                  <span className="w-full truncate text-[10px] text-destructive" title={srv.error}>
                    {srv.error}
                  </span>
                ) : null}
                {canReconnect ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[10px]"
                    onClick={() => void handleReconnect(srv.name)}
                    disabled={busyServer === srv.name}
                  >
                    {t("reconnect")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[10px]"
                  onClick={() => void handleToggle(srv.name, isDisabled)}
                  disabled={busyServer === srv.name}
                >
                  {isDisabled ? t("enable") : t("disable")}
                </Button>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
