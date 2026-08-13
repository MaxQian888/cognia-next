"use client"

import { useTranslations } from "next-intl"
import { AlertCircleIcon, CheckCircle2Icon, Clock3Icon, MinusCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { PerfConnectionState, PerfGap, PerfSourceDescriptor } from "@/lib/perf/backend/types"

const stateIcons: Record<PerfConnectionState, typeof CheckCircle2Icon> = {
  connecting: Clock3Icon,
  live: CheckCircle2Icon,
  stale: AlertCircleIcon,
  error: AlertCircleIcon,
  unsupported: MinusCircleIcon,
}

export function PerfSourceHealth({
  sources,
  hostState,
  gaps,
  error,
  collectionDurationMs,
  actualIntervalMs,
}: {
  sources: PerfSourceDescriptor[]
  hostState: PerfConnectionState
  gaps: PerfGap[]
  error: string | null
  collectionDurationMs?: number
  actualIntervalMs?: number
}) {
  const t = useTranslations("performance.sourceHealth")
  const overhead =
    collectionDurationMs !== undefined && actualIntervalMs
      ? (collectionDurationMs / actualIntervalMs) * 100
      : null

  return (
    <Card data-testid="perf-source-health">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {sources.map((source) => {
            const state = source.kind === "host" ? hostState : source.connection.state
            const Icon = stateIcons[state]
            return (
              <div key={source.sourceId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t(`kind.${source.kind}`)}</span>
                  <Badge variant={state === "live" ? "default" : "secondary"}>
                    <Icon className="mr-1 size-3" />
                    {t(`state.${state}`)}
                  </Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {source.runtimeKind} · {source.sourceId}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {source.capabilities.map((capability) => (
                    <Badge key={capability} variant="outline" className="font-mono text-[10px]">
                      {capability}
                    </Badge>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("gaps")}</dt>
            <dd className="font-medium">{gaps.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("overhead")}</dt>
            <dd className="font-medium">
              {overhead === null ? t("notAvailable") : `${overhead.toFixed(2)}%`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("error")}</dt>
            <dd className="truncate font-medium">{error ?? t("none")}</dd>
          </div>
        </dl>
        {gaps.length > 0 && (
          <div
            role="status"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
          >
            {t("latestGap", {
              reason: gaps.at(-1)!.reason,
              start: new Date(gaps.at(-1)!.wallStartMs).toLocaleTimeString(),
              end: new Date(gaps.at(-1)!.wallEndMs).toLocaleTimeString(),
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
