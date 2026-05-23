"use client"

/**
 * CronBuilder — preset dropdown + raw 5-field expression input + a live
 * "next runs" preview for `trigger.cron`. The raw expression stays the source
 * of truth (and is what `params-schemas.ts` validates on save); the preset
 * dropdown is an authoring aid that writes a known expression.
 *
 * Validation + next-run computation reuse the repo's own timezone-aware cron
 * utilities (`lib/scheduler/cron-parser.ts`) rather than pulling the
 * `cron-parser` npm package into this bundle. Presets are copied locally per
 * the established per-call-site convention (see
 * `components/scheduler/dialogs/quick-workflow-trigger-dialog.tsx`).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getNextCronTimes, validateCronExpression } from "@/lib/scheduler/cron-parser"

const CRON_PRESETS: Array<{ id: string; expr: string; labelKey: string }> = [
  { id: "every-minute", expr: "* * * * *", labelKey: "everyMinute" },
  { id: "hourly", expr: "0 * * * *", labelKey: "hourly" },
  { id: "daily-9am", expr: "0 9 * * *", labelKey: "daily" },
  { id: "weekdays-9am", expr: "0 9 * * 1-5", labelKey: "weekdays" },
  { id: "weekly-mon-9am", expr: "0 9 * * 1", labelKey: "weekly" },
  { id: "monthly-1st-9am", expr: "0 9 1 * *", labelKey: "monthly" },
  { id: "custom", expr: "", labelKey: "custom" },
]

export interface CronBuilderProps {
  id: string
  value: string
  onChange: (next: string) => void
  /** IANA timezone used to compute the next-run preview. */
  timezone?: string
}

export function CronBuilder({ id, value, onChange, timezone }: CronBuilderProps) {
  const t = useTranslations("workflows.forms.cron.builder")

  const selectedPreset = useMemo(
    () => CRON_PRESETS.find((p) => p.expr && p.expr === value.trim())?.id ?? "custom",
    [value]
  )
  const validation = useMemo(() => validateCronExpression(value), [value])
  const nextRuns = useMemo(
    () => (validation.valid ? getNextCronTimes(value, 3, new Date(), timezone) : []),
    [value, validation.valid, timezone]
  )

  const handlePreset = (presetId: string) => {
    const preset = CRON_PRESETS.find((p) => p.id === presetId)
    if (preset && preset.expr) onChange(preset.expr)
  }

  return (
    <div className="space-y-2">
      <Select value={selectedPreset} onValueChange={handlePreset}>
        <SelectTrigger aria-label={t("presetLabel")} data-testid={`${id}-preset`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CRON_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {t(`presets.${p.labelKey}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        id={id}
        value={value}
        className="font-mono"
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * 1-5"
      />
      {validation.valid ? (
        nextRuns.length > 0 ? (
          <div className="text-xs text-muted-foreground" data-testid={`${id}-next-runs`}>
            <p className="font-medium">{t("nextRunsLabel")}</p>
            <ul className="list-disc pl-4">
              {nextRuns.map((d, i) => (
                <li key={i}>{d.toLocaleString()}</li>
              ))}
            </ul>
          </div>
        ) : null
      ) : (
        <p className="text-xs text-destructive" data-testid={`${id}-invalid`}>
          {t("invalidExpression")}
        </p>
      )}
    </div>
  )
}
