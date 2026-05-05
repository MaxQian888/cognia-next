"use client"

import { useEffect, useState } from "react"
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
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { cn } from "@/lib/utils"

const POLL_INTERVAL_MS = 10_000

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

  const serverStatus: "ok" | "warn" | "error" | "unknown" = !desktop
    ? "unknown"
    : health === null
      ? "unknown"
      : health.serverRunning
        ? "ok"
        : "error"

  return (
    <div className="space-y-4">
      {/* Card 1: Server status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ServerIcon className="h-4 w-4" />
            Connector Server
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!desktop && (
            <p className="text-xs text-muted-foreground">
              Platform connectors require the desktop (Tauri) runtime.
            </p>
          )}
          <div className="flex items-center gap-2">
            <StatusDot state={serverStatus} />
            <span>
              {serverStatus === "ok"
                ? `Running — ${health?.boundAddr ?? ""}`
                : serverStatus === "error"
                  ? "Stopped"
                  : "Unknown"}
            </span>
          </div>
          {health && (
            <div className="text-xs text-muted-foreground">
              {health.registeredAdapterCount} adapter
              {health.registeredAdapterCount !== 1 ? "s" : ""} registered
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: Adapter health */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ActivityIcon className="h-4 w-4" />
            Adapters
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!adapters || adapters.length === 0 ? (
            <p className="text-xs text-muted-foreground">No adapters configured yet.</p>
          ) : (
            <ul className="space-y-2">
              {adapters.map((a) => (
                <li key={a.id} className="flex items-center gap-3 text-sm">
                  <StatusDot state={a.enabled ? "ok" : "unknown"} />
                  <span className="flex-1 truncate">{a.displayName}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {a.type}
                  </Badge>
                  {!a.enabled && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      disabled
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Recent audit entries */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2Icon className="h-4 w-4" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!recentAudit || recentAudit.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recent activity.</p>
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
                    {entry.kind}
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
