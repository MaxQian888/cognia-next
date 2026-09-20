"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { SettingsToggle } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import {
  normalizeSearchProviderHealthSettings,
  SEARCH_PROVIDER_HEALTH_LIMITS,
} from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.search.reliability")

const COOLDOWN_MIN_S = SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.min / 1000
const COOLDOWN_MAX_S = SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.max / 1000

export function SearchReliabilitySettings() {
  const t = useTranslations("searchReliability")

  const settings = useSettingsStore((s) => s.settings)
  const setSearchProviderHealthSettings = useSettingsStore(
    (s) => s.setSearchProviderHealthSettings
  )

  // Normalize so a partially-populated persisted row still yields valid slider
  // values (the store re-normalizes on write, this only guards the read path).
  const health = normalizeSearchProviderHealthSettings(settings?.searchProviderHealth)
  const cooldownSeconds = Math.round(health.cooldownMs / 1000)

  const handleThresholdChange = useCallback(
    ([value]: number[]) => {
      void setSearchProviderHealthSettings({ failureThreshold: value })
    },
    [setSearchProviderHealthSettings]
  )

  const handleCooldownChange = useCallback(
    ([seconds]: number[]) => {
      void setSearchProviderHealthSettings({ cooldownMs: seconds * 1000 })
    },
    [setSearchProviderHealthSettings]
  )

  return (
    <div className="space-y-4">
      <SettingsToggle
        id="search-provider-health-enabled"
        label={t("title")}
        description={t("description")}
        checked={health.enabled}
        onCheckedChange={(v) => {
          log.info("provider_health_enabled_changed", { enabled: v })
          void setSearchProviderHealthSettings({ enabled: v })
        }}
      />

      {health.enabled && (
        <>
          <div className="space-y-2">
            <Label className="text-sm">
              {t("failureThreshold")}: {health.failureThreshold}
            </Label>
            <Slider
              value={[health.failureThreshold]}
              onValueChange={handleThresholdChange}
              onValueCommit={([value]) =>
                log.info("provider_health_threshold_changed", { failureThreshold: value })
              }
              min={SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.min}
              max={SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.max}
              step={1}
            />
            <p className="text-[10px] text-muted-foreground">{t("failureThresholdDesc")}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">
              {t("cooldown")}: {t("cooldownSeconds", { seconds: cooldownSeconds })}
            </Label>
            <Slider
              value={[cooldownSeconds]}
              onValueChange={handleCooldownChange}
              onValueCommit={([seconds]) =>
                log.info("provider_health_cooldown_changed", { cooldownMs: seconds * 1000 })
              }
              min={COOLDOWN_MIN_S}
              max={COOLDOWN_MAX_S}
              step={5}
            />
          </div>
        </>
      )}
    </div>
  )
}
