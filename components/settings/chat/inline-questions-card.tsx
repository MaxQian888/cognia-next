"use client"

// Settings card for non-blocking inline agent questions (Codex
// `delivery: "async"` agent messages). Opt-in: when on, `async_questions`
// events render as interactive cards in the transcript; when off the same
// questions degrade to plain text. One toggle — mirrors the other
// conversation-section cards that read/write an optional AppSettings block.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { AppSettings } from "@cognia/agent-config-types"

type InlineQuestions = NonNullable<AppSettings["inlineQuestions"]>

export function InlineQuestionsCard() {
  const t = useTranslations("settings.inlineQuestions")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const block: InlineQuestions = settings?.inlineQuestions ?? {}
  const enabled = block.enabled === true

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="inline-questions-enabled" className="text-sm">
            {t("enabled.label")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("enabled.hint")}</p>
        </div>
        <Switch
          id="inline-questions-enabled"
          checked={enabled}
          onCheckedChange={(next) => void save({ inlineQuestions: { ...block, enabled: next } })}
          aria-label={t("enabled.label")}
        />
      </div>
    </div>
  )
}
