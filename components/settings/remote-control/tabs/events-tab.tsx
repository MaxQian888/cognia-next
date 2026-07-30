"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { emitSchedulerEvent, type SchedulerEventType } from "@/lib/scheduler/event-integration"
import {
  listRemoteControlAudit,
  type ListRemoteControlAuditOptions,
} from "@/lib/db/remote-control-audit"
import type { RemoteControlAuditDirection, RemoteControlAuditEntry } from "@/types/remote-control"

const EVENT_TYPES: SchedulerEventType[] = [
  "session:created",
  "session:completed",
  "session:deleted",
  "sync:started",
  "sync:completed",
  "sync:failed",
  "backup:needed",
  "backup:completed",
  "workflow:completed",
  "agent:completed",
  "chat:completed",
  "goal:completed",
  "agent-team:completed",
  "plan:completed",
  "connection:outbound:send",
  "connection:scheduled:digest",
  "custom",
]

const EVENT_KEY_MAP: Record<SchedulerEventType, string> = {
  "session:created": "sessionCreated",
  "session:completed": "sessionCompleted",
  "session:deleted": "sessionDeleted",
  "sync:started": "syncStarted",
  "sync:completed": "syncCompleted",
  "sync:failed": "syncFailed",
  "backup:needed": "backupNeeded",
  "backup:completed": "backupCompleted",
  "workflow:completed": "workflowCompleted",
  "agent:completed": "agentCompleted",
  "chat:completed": "chatCompleted",
  "goal:completed": "goalCompleted",
  "agent-team:completed": "agentTeamCompleted",
  "plan:completed": "planCompleted",
  "connection:outbound:send": "connectionOutboundSend",
  "connection:scheduled:digest": "connectionScheduledDigest",
  "connection:housekeeping:daily": "connectionHousekeepingDaily",
  custom: "custom",
}

type DirectionFilter = RemoteControlAuditDirection | "all"

export function EventsTab() {
  const t = useTranslations("settings.remoteControl.events")

  const [audit, setAudit] = useState<RemoteControlAuditEntry[]>([])
  const [filter, setFilter] = useState<DirectionFilter>("all")
  const [reloadKey, setReloadKey] = useState(0)

  const refreshAudit = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const opts: ListRemoteControlAuditOptions = { limit: 100 }
      if (filter !== "all") opts.direction = filter
      try {
        const rows = await listRemoteControlAudit(opts)
        if (!cancelled) setAudit(rows)
      } catch {
        // Dexie unavailable (e.g. SSR/first paint) — leave the list empty.
        if (!cancelled) setAudit([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filter, reloadKey])

  const onEmitTest = async (eventType: SchedulerEventType) => {
    try {
      await emitSchedulerEvent(eventType, {
        source: "remote-control-test",
        synthetic: true,
      })
      toast.success(t("testEventDispatched"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const DIRECTION_FILTERS: DirectionFilter[] = ["all", "inbound", "outbound"]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">{t("auditHeading")}</CardTitle>
              <CardDescription>{t("auditHelp")}</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={refreshAudit}>
              <RefreshCwIcon className="mr-2 h-3.5 w-3.5" />
              {t("auditRefresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            {DIRECTION_FILTERS.map((dir) => (
              <Button
                key={dir}
                size="sm"
                variant={filter === dir ? "default" : "outline"}
                onClick={() => setFilter(dir)}
              >
                {t(`auditFilter_${dir}` as never)}
              </Button>
            ))}
          </div>
          {audit.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("auditEmpty")}</p>
          ) : (
            <ul className="divide-y">
              {audit.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground">{row.direction}</span>
                  <code className="flex-1 truncate font-mono">
                    {row.target ?? row.endpointId ?? row.kind}
                  </code>
                  <span className="shrink-0 text-muted-foreground">{row.result ?? ""}</span>
                  <span className="w-36 shrink-0 text-right text-muted-foreground">
                    {new Date(row.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("heading")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {EVENT_TYPES.map((eventType) => (
              <li key={eventType} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex-1 min-w-0">
                  <code className="text-xs font-mono">{eventType}</code>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t(`types.${EVENT_KEY_MAP[eventType]}` as never)}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onEmitTest(eventType)}>
                  <SendIcon className="mr-2 h-3.5 w-3.5" />
                  {t("emitTest")}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
