"use client"

// Personalization card (Settings → Appearance). Drives the chat welcome page
// (`EmptyChatState`): the display name woven into the time-of-day greeting, the
// rich/minimal welcome style, and a "restore hidden sections" escape hatch for
// sections the user dismissed via the ✕ on the welcome page. Live-saves (same
// pattern as `appearance/components/density-card.tsx`).

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import type { WelcomeStyle } from "@/components/chat/empty-state"

const STYLES: { value: WelcomeStyle; labelKey: string }[] = [
  { value: "rich", labelKey: "personalization.styleRich" },
  { value: "minimal", labelKey: "personalization.styleMinimal" },
]

export function PersonalizationCard() {
  const t = useTranslations("settings.appearance")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const welcomeStyle: WelcomeStyle = settings?.welcomeStyle ?? "rich"
  const hidden = settings?.welcomeHidden ?? {}
  const hasHidden = Boolean(hidden.tryPrompt)

  // Name is edited locally and committed on blur so we don't write a settings
  // row on every keystroke.
  const [name, setName] = useState(settings?.userName ?? "")
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(settings?.userName ?? "")
  }, [settings?.userName])

  function commitName() {
    const trimmed = name.trim()
    if (trimmed === (settings?.userName ?? "")) return
    void save({ userName: trimmed || undefined })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("personalization.title")}</Label>
        <p className="text-xs text-muted-foreground">{t("personalization.description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-user-name" className="text-xs">
          {t("personalization.nameLabel")}
        </Label>
        <Input
          id="settings-user-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName()
          }}
          placeholder={t("personalization.namePlaceholder")}
          className="max-w-xs"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("personalization.styleLabel")}</Label>
        <div className="inline-flex rounded-md border p-1">
          {STYLES.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={welcomeStyle === opt.value ? "default" : "ghost"}
              className={cn(
                "h-7 px-3 text-xs",
                welcomeStyle !== opt.value && "text-muted-foreground"
              )}
              aria-pressed={welcomeStyle === opt.value}
              onClick={() => {
                if (welcomeStyle !== opt.value) void save({ welcomeStyle: opt.value })
              }}
            >
              {t(opt.labelKey)}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t("personalization.styleHint")}</p>
      </div>

      {hasHidden ? (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void save({ welcomeHidden: {} })}
          >
            {t("personalization.restoreSections")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
