"use client"

import { useTranslations } from "next-intl"
import { Shield } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import type { SafeSearchLevel } from "@/lib/search/types"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.search.safety")

const LEVELS: { value: SafeSearchLevel; labelKey: string; descKey: string }[] = [
  { value: "off", labelKey: "off", descKey: "offDesc" },
  { value: "moderate", labelKey: "moderate", descKey: "moderateDesc" },
  { value: "strict", labelKey: "strict", descKey: "strictDesc" },
]

export function SearchSafetySettings() {
  const ts = useTranslations("searchSafety")

  const settings = useSettingsStore((s) => s.settings)
  const setEnabled = useSettingsStore((s) => s.setSearchSafeSearchEnabled)
  const setLevel = useSettingsStore((s) => s.setSearchSafeSearchLevel)

  const enabled = settings?.searchSafeSearchEnabled ?? true
  const level: SafeSearchLevel = settings?.searchSafeSearchLevel ?? "moderate"

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{ts("title")}</CardTitle>
              <CardDescription className="text-xs">{ts("description")}</CardDescription>
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              log.info("safety_enabled_changed", { enabled: v })
              void setEnabled(v)
            }}
          />
        </div>
      </CardHeader>
      {enabled && (
        <CardContent className="space-y-3">
          <Label className="text-sm">{ts("level")}</Label>
          <div className="grid grid-cols-3 gap-2">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                onClick={() => {
                  log.info("safety_level_changed", { level: l.value })
                  void setLevel(l.value)
                }}
                className={cn(
                  "flex flex-col items-center gap-1 p-3 rounded-lg border transition-all",
                  level === l.value
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-border hover:border-primary/50"
                )}
              >
                <span className="text-xs font-medium">{ts(l.labelKey)}</span>
                <span className="text-[10px] text-muted-foreground text-center">
                  {ts(l.descKey)}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
