"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { BrandIcon } from "@/components/icons/brand-icon"
import { useSettingsStore } from "@/stores/settings"
import {
  getProviderHealth,
  type ProviderHealthRow,
} from "@cognia/web-search/provider-health"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  type SearchProviderType,
} from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.search.health")

const ALL_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]

/** Refresh fast while any circuit is open so the cooldown ticks down live. */
const OPEN_REFRESH_MS = 1_000
const IDLE_REFRESH_MS = 5_000

const STATUS_VARIANT = {
  healthy: "default",
  degraded: "secondary",
  unhealthy: "destructive",
  unknown: "outline",
} as const

export function SearchProviderHealthPanel() {
  const t = useTranslations("searchHealth")

  const searchProviders = useSettingsStore(
    (s) => s.settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  )
  const breakerEnabled = useSettingsStore(
    (s) => s.settings?.searchProviderHealth?.enabled !== false
  )
  const resetSearchProviderHealth = useSettingsStore((s) => s.resetSearchProviderHealth)

  // Rows: providers the user has enabled+configured, plus any provider with
  // recorded breaker traffic (a configured-then-unconfigured provider keeps
  // its stats visible until reset).
  const snapshotRows = useCallback(() => {
    const all = getProviderHealth().snapshotAll(ALL_PROVIDER_IDS)
    const out = {} as Record<SearchProviderType, ProviderHealthRow>
    for (const id of ALL_PROVIDER_IDS) {
      const settings = searchProviders[id]
      const hasTraffic = all[id].totalFailures + all[id].totalSuccesses > 0
      if ((!!settings?.enabled && isProviderConfigured(id, settings)) || hasTraffic) {
        out[id] = all[id]
      }
    }
    return out
  }, [searchProviders])

  // Rows are derived, not seeded: a settings change (provider toggled on/off)
  // reshapes the board on the next render, and each interval/reset `tick`
  // re-snapshots the breaker singleton.
  const [, setTick] = useState(0)
  const rows = snapshotRows()

  const anyCircuitOpen = Object.values(rows).some((row) => row.circuitState !== "closed")

  // Recreated when the open/closed mix flips so an open circuit polls at 1s
  // and an all-closed board idles at 5s.
  useEffect(() => {
    const delay = anyCircuitOpen ? OPEN_REFRESH_MS : IDLE_REFRESH_MS
    const id = setInterval(() => setTick((t) => t + 1), delay)
    return () => clearInterval(id)
  }, [anyCircuitOpen])

  const handleReset = useCallback(
    (providerId?: SearchProviderType) => {
      resetSearchProviderHealth(providerId)
      setTick((t) => t + 1)
      if (providerId) {
        log.info("provider_health_reset", { providerId })
      } else {
        log.info("provider_health_reset_all")
      }
    },
    [resetSearchProviderHealth]
  )

  const providerIds = Object.keys(rows) as SearchProviderType[]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        {providerIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs shrink-0"
            onClick={() => handleReset()}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            {t("resetAll")}
          </Button>
        )}
      </div>

      {!breakerEnabled && (
        <p className="text-xs text-muted-foreground italic">{t("breakerDisabled")}</p>
      )}

      {providerIds.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">{t("empty")}</p>
      ) : (
        <div className="space-y-2">
          {providerIds.map((id) => {
            const row = rows[id]
            const successPercent = Math.round(row.successRate * 100)
            return (
              <div
                key={id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <BrandIcon id={id} label={SEARCH_PROVIDERS[id].name} size={20} />
                  <span className="text-sm font-medium truncate">
                    {SEARCH_PROVIDERS[id].name}
                  </span>
                  <Badge variant={STATUS_VARIANT[row.status]} className="text-[10px] px-1 py-0">
                    {t(`status.${row.status}`)}
                  </Badge>
                </div>
                <div className="flex items-center justify-end flex-wrap gap-3 shrink-0 text-xs text-muted-foreground">
                  <span>{t("successRate", { percent: successPercent })}</span>
                  <span>{t("avgLatency", { ms: row.avgLatency })}</span>
                  <span>
                    {t("counters", { ok: row.totalSuccesses, failed: row.totalFailures })}
                  </span>
                  <span className="w-24 text-right">
                    {row.circuitState === "closed"
                      ? t("circuitClosed")
                      : row.circuitState === "half-open"
                        ? t("circuitProbing")
                        : t("circuitOpen", {
                            seconds: Math.ceil(row.cooldownRemainingMs / 1000),
                          })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleReset(id)}
                  >
                    {t("reset")}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
