"use client"

// Usage / consumption statistics display mode — simplified / standard / detailed.
// Reads/writes the global `settings.usageDisplayMode` via `useUsageDisplayMode`,
// the same value the Subscription → Usage toolbar quick toggle drives.

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { USAGE_DISPLAY_MODES, type UsageDisplayMode } from "@/types/appearance"

export function UsageDisplayCard() {
  const t = useTranslations("settings.appearance.usageDisplay")
  const { mode, setMode } = useUsageDisplayMode()

  return (
    <div className="space-y-2">
      <Label className="text-xs">{t("label")}</Label>
      <Select value={mode} onValueChange={(value) => setMode(value as UsageDisplayMode)}>
        <SelectTrigger className="w-full max-w-xs" data-testid="usage-display-mode-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {USAGE_DISPLAY_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {t(`mode.${m}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">{t(`hint.${mode}`)}</p>
    </div>
  )
}
