"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { TunnelTab } from "./tunnel-tab"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ActivityIcon,
  CheckCircle2Icon,
  CircleIcon,
  ServerIcon,
  XCircleIcon,
  AlertCircleIcon,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { connectorsHealth, type ConnectorsHealth } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry } from "@/types/connectors/audit"
import type { AdapterInstanceRow, ConnectorHeartbeatRow } from "@/lib/db/connector-types"
import type { HealthCellState } from "@/lib/connectors/health/derive-history"
import { HEARTBEAT_INTERVAL_MS } from "@/lib/connectors/health/heartbeat"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { auditKindLabel } from "./audit-kind-label"
import { DocsProvidersCard } from "../docs-providers/docs-providers-card"

const POLL_INTERVAL_MS = 10_000

/**
 * A heartbeat older than 3 sweep intervals means the runtime is no longer
 * servicing the adapter (webview reloaded without the runtime, app just
 * booted, runtime lost the singleton lock, …) — treat the adapter as not
 * running rather than trusting the stale snapshot.
 */
const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS

/**
 * Row-level mirror of `adapterNeedsInboundServer` (server-transport.ts):
 * only webhook and reverse-WS rows receive events through the local axum
 * server; every other transport dials out. Used to decide whether a stopped
 * inbound server is an error (webhook adapter starved) or simply not needed
 * (gateway/long-poll deployment, e.g. Lark long connection).
 */
function rowNeedsInboundServer(row: AdapterInstanceRow): boolean {
  return row.transportMode === "webhook" || row.transportMode === "reverse-ws"
}

/**
 * Latest fresh heartbeat state per adapter — the SAME source of truth the
 * Health tab uses, so the overview can never contradict it. `undefined`
 * means no fresh heartbeat → the runtime is not servicing that adapter.
 */
function deriveLiveStates(heartbeats: ConnectorHeartbeatRow[]): Map<string, HealthCellState> {
  const newest = new Map<string, ConnectorHeartbeatRow>()
  for (const hb of heartbeats) {
    const prev = newest.get(hb.adapterId)
    if (!prev || hb.at > prev.at) newest.set(hb.adapterId, hb)
  }
  const states = new Map<string, HealthCellState>()
  for (const [adapterId, hb] of newest) {
    const state = (hb.fields?.state as HealthCellState | undefined) ?? "running"
    states.set(adapterId, state)
  }
  return states
}

function StatusDot({ state }: { state: "ok" | "warn" | "error" | "unknown" }) {
  return (
    <CircleIcon
      className={cn("h-2.5 w-2.5 fill-current", {
        "text-emerald-500": state === "ok",
        "text-amber-500": state === "warn",
        "text-destructive": state === "error",
        "text-muted-foreground": state === "unknown",
      })}
    />
  )
}

function auditKindBadgeVariant(kind: string): "default" | "secondary" | "destructive" | "outline" {
  if (kind.includes("error") || kind.includes("deadlettered")) return "destructive"
  if (kind.includes("success") || kind.includes("started") || kind.includes("refreshed"))
    return "default"
  return "secondary"
}

export function OverviewTab() {
  const t = useTranslations("settings.connections.overview")
  const tKind = useTranslations("settings.connections.audit.kind")
  const router = useRouter()
  const [health, setHealth] = useState<ConnectorsHealth | null>(null)
  const desktop = isTauri()

  useEffect(() => {
    if (!desktop) return
    let mounted = true
    const poll = async () => {
      try {
        const h = await connectorsHealth()
        if (mounted) setHealth(h)
      } catch {
        // non-fatal — server may not be started yet
      }
    }
    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(id)
    }
  }, [desktop])

  // Freshness clock for the heartbeat window: heartbeats only re-trigger the
  // live query while the runtime keeps writing them, so a dead runtime would
  // otherwise leave the last "running" snapshot on screen forever.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  const recentAudit = useLiveQuery<AuditEntry[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb().connectorAudit.orderBy("at").reverse().limit(10).toArray(),
    []
  )

  const freshHeartbeats = useLiveQuery<ConnectorHeartbeatRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .connectorHeartbeats.where("at")
            .above(nowTick - HEARTBEAT_FRESH_MS)
            .toArray(),
    [nowTick]
  )

  const liveStates = deriveLiveStates(freshHeartbeats ?? [])
  const enabledAdapters = (adapters ?? []).filter((a) => a.enabled)
  const runningCount = enabledAdapters.filter((a) => liveStates.get(a.id) === "running").length

  // The inbound axum server only matters when a webhook / reverse-WS adapter
  // is enabled. A gateway/long-poll-only deployment (e.g. Lark long
  // connection) legitimately never starts it — that must not read as an
  // error, and it must not be presented as "the connector runtime".
  const needsInboundServer = enabledAdapters.some(rowNeedsInboundServer)
  const serverStatus: "ok" | "warn" | "error" | "unknown" = !desktop
    ? "unknown"
    : health === null
      ? "unknown"
      : health.serverRunning
        ? "ok"
        : needsInboundServer
          ? "error"
          : "unknown"

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => router.push("/inbox")} data-testid="connections-open-inbox">
          {t("openInbox")}
        </Button>
      </div>
      {/* Card 1: Server status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ServerIcon className="h-4 w-4" />
            {t("serverHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!desktop && <p className="text-xs text-muted-foreground">{t("desktopOnlyNotice")}</p>}
          <div className="flex items-center gap-2">
            <StatusDot state={serverStatus} />
            <span>
              {serverStatus === "ok"
                ? t("statusRunning", { addr: health?.boundAddr ?? "" })
                : serverStatus === "error"
                  ? t("statusStopped")
                  : health && !health.serverRunning && !needsInboundServer
                    ? t("statusNotNeeded")
                    : t("statusUnknown")}
            </span>
          </div>
          {health && (health.serverRunning || needsInboundServer) && (
            <div className="text-xs text-muted-foreground">
              {health.registeredAdapterCount === 1
                ? t("adapterCount", { count: health.registeredAdapterCount })
                : t("adapterCountPlural", { count: health.registeredAdapterCount })}
            </div>
          )}
        </CardContent>
      </Card>

      <TunnelTab />

      {/* Remote document providers (ADR-0134) — the Feishu row reads the same
          bound Lark accounts this section already manages, so it belongs here
          rather than in a section of its own. */}
      <DocsProvidersCard />

      {/* Card 2: Adapter health */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ActivityIcon className="h-4 w-4" />
            {t("adaptersHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {desktop && enabledAdapters.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("runningSummary", { running: runningCount, total: enabledAdapters.length })}
            </p>
          )}
          {!adapters || adapters.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noAdapters")}</p>
          ) : (
            <ul className="space-y-2">
              {adapters.map((a) => {
                // Live state from the freshest heartbeat — the same signal the
                // Health tab renders, so the two surfaces cannot disagree.
                const live = a.enabled ? liveStates.get(a.id) : undefined
                const dotState: "ok" | "warn" | "error" | "unknown" = !a.enabled
                  ? "unknown"
                  : live === "running"
                    ? "ok"
                    : live === "starting" || live === "degraded"
                      ? "warn"
                      : live === "down"
                        ? "error"
                        : "unknown"
                const stateKey = a.enabled ? (live ?? "notRunning") : "disabled"
                return (
                  <li key={a.id} className="flex items-center gap-3 text-sm">
                    <span role="img" aria-label={t("stateAria", { state: t(`state.${stateKey}`) })}>
                      <StatusDot state={dotState} />
                    </span>
                    <span className="flex-1 truncate">{a.displayName}</span>
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {a.type}
                    </Badge>
                    {a.enabled && stateKey !== "running" && (
                      <Badge
                        variant={live === "down" ? "destructive" : "secondary"}
                        className="shrink-0 text-xs"
                      >
                        {t(`state.${stateKey}`)}
                      </Badge>
                    )}
                    {!a.enabled && (
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {t("disabledBadge")}
                      </Badge>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Recent audit entries */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2Icon className="h-4 w-4" />
            {t("recentActivityHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!recentAudit || recentAudit.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noRecentActivity")}</p>
          ) : (
            <ul className="space-y-1.5">
              {recentAudit.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs"
                >
                  {entry.kind.includes("error") || entry.kind.includes("deadlettered") ? (
                    <XCircleIcon className="h-3 w-3 shrink-0 text-destructive" />
                  ) : entry.kind.includes("warning") || entry.kind.includes("tripped") ? (
                    <AlertCircleIcon className="h-3 w-3 shrink-0 text-amber-500" />
                  ) : (
                    <CheckCircle2Icon className="h-3 w-3 shrink-0 text-emerald-500" />
                  )}
                  <Badge variant={auditKindBadgeVariant(entry.kind)} className="text-xs">
                    {auditKindLabel(tKind, entry.kind)}
                  </Badge>
                  <span className="flex-1 truncate text-muted-foreground">{entry.adapterId}</span>
                  <span className="text-muted-foreground shrink-0">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
