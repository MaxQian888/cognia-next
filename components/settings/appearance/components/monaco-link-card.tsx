"use client"

// Settings → Appearance → Advanced → "Editor theme linking". Controls whether
// the app theme drives the Monaco / Canvas editor (`monacoLink.enabled`) and an
// optional lock pinning Monaco to a specific base theme regardless of the app
// theme (`monacoLink.lockedThemeId`). Consumed by `components/canvas/canvas-panel`.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { responsiveSelectClass } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import type { MonacoLinkSettings } from "@/types/appearance"

const LOCK_NONE = "__none__"
const LOCK_THEMES = ["vs", "vs-dark", "hc-black", "hc-light"] as const
const LOCK_KEY: Record<(typeof LOCK_THEMES)[number], string> = {
  vs: "vs",
  "vs-dark": "vsDark",
  "hc-black": "hcBlack",
  "hc-light": "hcLight",
}

export function MonacoLinkCard() {
  const t = useTranslations("settings.appearance.advanced.monacoLink")
  const monacoLink = useSettingsStore((s) => s.monacoLink)
  const save = useSettingsStore((s) => s.save)

  const patch = (p: Partial<MonacoLinkSettings>) =>
    void save({ monacoLink: { ...monacoLink, ...p } })

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-[11px] text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <Label className="text-sm">{t("enabledLabel")}</Label>
        <Switch
          checked={monacoLink.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label={t("enabledLabel")}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("lockLabel")}</Label>
        <Select
          value={monacoLink.lockedThemeId ?? LOCK_NONE}
          onValueChange={(value) =>
            patch({ lockedThemeId: value === LOCK_NONE ? undefined : value })
          }
        >
          <SelectTrigger className={responsiveSelectClass} aria-label={t("lockLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={LOCK_NONE}>{t("lock.none")}</SelectItem>
            {LOCK_THEMES.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`lock.${LOCK_KEY[id]}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("lockHint")}</p>
      </div>
    </div>
  )
}
