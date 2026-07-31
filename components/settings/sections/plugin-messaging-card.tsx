"use client"

// Inter-plugin messaging observability.
//
// Surfaces the runtime introspection the IPC + event-bus singletons already
// expose (getStats / getAllExposedMethods / describeExposedMethods /
// getSubscriptions / getAllBreakerStates / getMessageHistory) — there was no UI
// for any of it, so debugging plugin↔plugin communication was impossible.
// Read-only; reads the client singletons directly on demand.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getPluginIPC } from "@/lib/plugin/messaging/ipc"
import { getMessageBus } from "@/lib/plugin/messaging/message-bus"

interface MessagingSnapshot {
  busSubscriptions: number
  busHistory: number
  ipcSubscriptions: number
  ipcExposedMethods: number
  ipcMessages: number
  exposed: Array<{ pluginId: string; methods: Array<{ name: string; description?: string }> }>
  channels: Array<{ channel: string; subscribers: string[] }>
  degradedBreakers: Array<{ pluginId: string; methodName: string; state: string }>
}

function readSnapshot(): MessagingSnapshot {
  const ipc = getPluginIPC()
  const bus = getMessageBus()

  const busStats = bus.getStats()
  const ipcStats = ipc.getStats()

  const exposed: MessagingSnapshot["exposed"] = []
  for (const [pluginId] of ipc.getAllExposedMethods().entries()) {
    exposed.push({
      pluginId,
      methods: ipc
        .describeExposedMethods(pluginId)
        .map((m) => ({ name: m.name, description: m.description })),
    })
  }

  const channels: MessagingSnapshot["channels"] = []
  for (const [channel, subscribers] of ipc.getSubscriptions().entries()) {
    channels.push({ channel, subscribers })
  }

  return {
    busSubscriptions:
      busStats.totalSubscriptions + busStats.wildcardSubscriptions + busStats.patternSubscriptions,
    busHistory: busStats.historySize,
    ipcSubscriptions: ipcStats.totalSubscriptions,
    ipcExposedMethods: ipcStats.totalExposedMethods,
    ipcMessages: ipcStats.messageCount,
    exposed,
    channels,
    degradedBreakers: ipc.getAllBreakerStates().filter((b) => b.state !== "closed"),
  }
}

export function PluginMessagingCard() {
  const t = useTranslations("settings.diagnostics.pluginMessaging")
  // Lazy initializer reads the client-only singletons once at mount; the refresh
  // button recomputes on demand. No effect → no synchronous setState-in-effect.
  const [snapshot, setSnapshot] = useState<MessagingSnapshot | null>(() =>
    typeof window === "undefined" ? null : readSnapshot()
  )
  const refresh = () => setSnapshot(readSnapshot())

  const stats = useMemo(
    () =>
      snapshot
        ? ([
            { key: "exposedMethods", value: snapshot.ipcExposedMethods },
            { key: "channels", value: snapshot.channels.length },
            { key: "ipcSubscriptions", value: snapshot.ipcSubscriptions },
            { key: "busSubscriptions", value: snapshot.busSubscriptions },
            { key: "ipcMessages", value: snapshot.ipcMessages },
          ] as const)
        : [],
    [snapshot]
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          data-testid="plugin-messaging-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {t("refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="plugin-messaging-stats">
          {stats.map((stat) => (
            <div key={stat.key} className="rounded-md border p-2">
              <dt className="text-muted-foreground">{t(`stats.${stat.key}`)}</dt>
              <dd className="text-sm font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>

        {snapshot && snapshot.degradedBreakers.length > 0 && (
          <div className="space-y-1" role="alert" data-testid="plugin-messaging-breakers">
            <p className="font-medium text-amber-500">{t("degradedTitle")}</p>
            <ul className="space-y-1 font-mono">
              {snapshot.degradedBreakers.map((b) => (
                <li key={`${b.pluginId}::${b.methodName}`} className="flex flex-wrap gap-2">
                  <span>
                    {b.pluginId}.{b.methodName}
                  </span>
                  <Badge variant="outline" className="text-amber-500">
                    {b.state}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <p className="font-medium">{t("exposedTitle")}</p>
          {snapshot && snapshot.exposed.length > 0 ? (
            <ul
              className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-2"
              data-testid="plugin-messaging-exposed"
            >
              {snapshot.exposed.map((entry) => (
                <li key={entry.pluginId} className="space-y-1">
                  <span className="font-mono font-medium">{entry.pluginId}</span>
                  <ul className="ml-3 space-y-0.5">
                    {entry.methods.map((m) => (
                      <li key={m.name} className="flex flex-wrap gap-2">
                        <span className="font-mono">{m.name}()</span>
                        {m.description && (
                          <span className="text-muted-foreground">{m.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground" data-testid="plugin-messaging-exposed-empty">
              {t("exposedEmpty")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
