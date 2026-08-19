"use client"

/**
 * Logs → Local retention.
 *
 * Bounds on the IndexedDB history the integrated log viewer reads. Both values
 * are enforced by the same transport (`createIndexedDBTransport`), so whichever
 * limit is hit first wins — which is what the summary line under the sliders
 * spells out, because two independent caps read as ambiguous otherwise.
 */

import { useTranslations } from "next-intl"
import { DatabaseIcon, InfoIcon } from "lucide-react"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { RETENTION_BOUNDS } from "@/lib/logging"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

import { SliderField } from "../components/slider-field"
import type { UseLogSettingsDraftResult } from "@/hooks/logging/use-log-settings-draft"

export interface LogsRetentionPanelProps {
  draft: UseLogSettingsDraftResult
}

export function LogsRetentionPanel({ draft }: LogsRetentionPanelProps) {
  const t = useTranslations("logging")

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<DatabaseIcon />}
        title={t("settings.retention.title")}
        description={t("settings.retention.description")}
        testid="logs-retention"
      >
        <SliderField
          id="logs-retention-max-entries"
          label={t("settings.retention.maxEntries")}
          description={t("settings.retention.maxEntriesDesc")}
          valueLabel={draft.retention.maxEntries.toLocaleString()}
          value={draft.retention.maxEntries}
          min={RETENTION_BOUNDS.maxEntries.min}
          max={RETENTION_BOUNDS.maxEntries.max}
          step={1000}
          onValueChange={(value) => draft.setRetention("maxEntries", value)}
        />

        <SliderField
          id="logs-retention-max-age"
          label={t("settings.retention.maxAgeDays")}
          description={t("settings.retention.maxAgeDaysDesc")}
          valueLabel={`${draft.retention.maxAgeDays} ${t("settings.retention.days")}`}
          value={draft.retention.maxAgeDays}
          min={RETENTION_BOUNDS.maxAgeDays.min}
          max={RETENTION_BOUNDS.maxAgeDays.max}
          onValueChange={(value) => draft.setRetention("maxAgeDays", value)}
        />

        <p className="text-xs text-muted-foreground" data-testid="logs-retention-summary">
          {t("settings.retention.summary", {
            entries: draft.retention.maxEntries,
            days: draft.retention.maxAgeDays,
          })}
        </p>
      </SettingsBlock>

      <Alert data-testid="logs-retention-performance">
        <InfoIcon className="size-4" />
        <AlertTitle>{t("settings.performanceNote.title")}</AlertTitle>
        <AlertDescription>{t("settings.performanceNote.description")}</AlertDescription>
      </Alert>
    </SettingsStack>
  )
}
