"use client"

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { SettingsToggle } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import type { SafeSearchLevel } from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"
import { SegmentedControl, type SegmentedOption } from "./_shared/segmented-control"

const log = createLogger("settings.search.safety")

const LEVELS: { value: SafeSearchLevel; labelKey: string; descKey: string }[] = [
  { value: "off", labelKey: "off", descKey: "offDesc" },
  { value: "moderate", labelKey: "moderate", descKey: "moderateDesc" },
  { value: "strict", labelKey: "strict", descKey: "strictDesc" },
]

export function SearchSafetySettings() {
  const ts = useTranslations("searchSettings.safety")

  const settings = useSettingsStore((s) => s.settings)
  const setEnabled = useSettingsStore((s) => s.setSearchSafeSearchEnabled)
  const setLevel = useSettingsStore((s) => s.setSearchSafeSearchLevel)

  const enabled = settings?.searchSafeSearchEnabled ?? true
  const level: SafeSearchLevel = settings?.searchSafeSearchLevel ?? "moderate"

  const levelOptions: SegmentedOption<SafeSearchLevel>[] = LEVELS.map((l) => ({
    value: l.value,
    label: ts(l.labelKey),
    description: ts(l.descKey),
  }))

  return (
    <div className="space-y-3">
      <SettingsToggle
        id="search-safety-enabled"
        label={ts("title")}
        description={ts("description")}
        checked={enabled}
        onCheckedChange={(v) => {
          log.info("safety_enabled_changed", { enabled: v })
          void setEnabled(v)
        }}
      />
      {enabled && (
        <div className="space-y-2">
          <Label className="text-sm">{ts("level")}</Label>
          <SegmentedControl
            variant="cards"
            value={level}
            onValueChange={(v) => {
              log.info("safety_level_changed", { level: v })
              void setLevel(v)
            }}
            options={levelOptions}
            aria-label={ts("level")}
          />
        </div>
      )}
    </div>
  )
}
