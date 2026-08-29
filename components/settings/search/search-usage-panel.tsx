"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Clock, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { useSettingsStore } from "@/stores/settings"
import {
  SEARCH_PROVIDERS,
  createDefaultSearchUsageStats,
  type SearchProviderType,
} from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.search.usage")

export function SearchUsagePanel() {
  const tu = useTranslations("searchUsage")
  const stats = useSettingsStore(
    (s) => s.settings?.searchUsageStats ?? createDefaultSearchUsageStats()
  )
  const resetStats = useSettingsStore((s) => s.resetSearchUsageStats)

  const providerIds = Object.keys(stats) as SearchProviderType[]

  const totalSearches = useMemo(
    () => providerIds.reduce((sum, id) => sum + (stats[id]?.searchCount ?? 0), 0),
    [stats, providerIds]
  )

  const totalErrors = useMemo(
    () => providerIds.reduce((sum, id) => sum + (stats[id]?.errorCount ?? 0), 0),
    [stats, providerIds]
  )

  const mostUsedProvider = useMemo(() => {
    let best: SearchProviderType | null = null
    let max = 0
    for (const id of providerIds) {
      if ((stats[id]?.searchCount ?? 0) > max) {
        max = stats[id]?.searchCount ?? 0
        best = id
      }
    }
    return best
  }, [stats, providerIds])

  const avgResponseTime = useMemo(() => {
    const total = providerIds.reduce((sum, id) => sum + (stats[id]?.totalResponseTime ?? 0), 0)
    return totalSearches > 0 ? Math.round(total / totalSearches) : 0
  }, [stats, providerIds, totalSearches])

  const maxProviderCount = useMemo(
    () => Math.max(...providerIds.map((id) => stats[id]?.searchCount ?? 0), 1),
    [stats, providerIds]
  )

  const sortedProviders = useMemo(
    () =>
      [...providerIds]
        .filter((id) => (stats[id]?.searchCount ?? 0) > 0)
        .sort((a, b) => (stats[b]?.searchCount ?? 0) - (stats[a]?.searchCount ?? 0)),
    [stats, providerIds]
  )

  return (
    <div className="space-y-4">
      {totalSearches > 0 && (
        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              log.info("usage_stats_reset", { totalSearches, totalErrors })
              void resetStats()
            }}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            {tu("reset")}
          </Button>
        </div>
      )}
      <div className="space-y-4">
        {totalSearches === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">{tu("noData")}</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border p-2 text-center">
                <div className="text-[10px] text-muted-foreground uppercase">
                  {tu("totalSearches")}
                </div>
                <div className="text-base font-bold">{totalSearches}</div>
                {totalErrors > 0 && (
                  <Badge variant="destructive" className="text-[10px] mt-1">
                    {totalErrors} {tu("errors")}
                  </Badge>
                )}
              </div>
              <div className="rounded-lg border p-2 text-center">
                <div className="text-[10px] text-muted-foreground uppercase">
                  {tu("avgResponse")}
                </div>
                <div className="text-base font-bold">{avgResponseTime}ms</div>
              </div>
              <div className="min-w-0 rounded-lg border p-2 text-center">
                <div className="text-[10px] text-muted-foreground uppercase">{tu("mostUsed")}</div>
                {/* The only stat that is a name rather than a number. A third of
                    a phone-width pane is ~80px, so "Google Custom Search" has to
                    be allowed to wrap inside its box — a grid cell defaults to
                    `min-width: auto` and would otherwise widen the whole row. */}
                <div className="text-base font-bold break-words">
                  {mostUsedProvider ? SEARCH_PROVIDERS[mostUsedProvider]?.name : "-"}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              {sortedProviders.map((id) => {
                const count = stats[id]?.searchCount ?? 0
                const errors = stats[id]?.errorCount ?? 0
                const lastUsed = stats[id]?.lastUsedAt
                return (
                  <div key={id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{SEARCH_PROVIDERS[id]?.name}</span>
                        <Badge variant="secondary" className="text-[10px] px-1 py-0">
                          {count}
                        </Badge>
                        {errors > 0 && (
                          <Badge variant="destructive" className="text-[10px] px-1 py-0">
                            {tu("errCount", { count: errors })}
                          </Badge>
                        )}
                      </div>
                      <span className="text-muted-foreground flex items-center gap-1">
                        {lastUsed && (
                          <>
                            <Clock className="h-2.5 w-2.5" />
                            {new Date(lastUsed).toLocaleDateString()}
                          </>
                        )}
                      </span>
                    </div>
                    <Progress value={(count / maxProviderCount) * 100} className="h-1.5" />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
