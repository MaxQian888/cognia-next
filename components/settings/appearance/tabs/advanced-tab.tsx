"use client"

// Custom CSS editor. Backed by `<textarea>` so we don't pull Monaco into
// the appearance section's bundle just for this. The textarea is plenty
// for the common case (a few rules); users who want syntax highlighting
// have the Canvas tab for free-form CSS.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import { sanitizeUserCss } from "@/lib/appearance"

export function AdvancedTab() {
  const t = useTranslations("settings.appearance.advanced")
  const persistedCss = useSettingsStore((s) => s.customCss)
  const persistedEnabled = useSettingsStore((s) => s.customCssEnabled)
  const setCustomCss = useSettingsStore((s) => s.setCustomCss)
  const setCustomCssEnabled = useSettingsStore((s) => s.setCustomCssEnabled)

  // `persistedCss` seeds the textarea on the first render of this mount.
  // After save we call `setCustomCss(sanitized.css)` which triggers a
  // re-render with the new persisted value; we additionally call
  // `setDraft(sanitized.css)` so the textarea reflects sanitized output
  // immediately. No effect needed.
  const [persistedSeed, setPersistedSeed] = useState(persistedCss)
  const [draft, setDraft] = useState(persistedCss)
  const [removed, setRemoved] = useState<number | null>(null)
  // Manual "did the upstream value change?" check during render — the
  // recommended React 19 pattern for syncing prop/store-derived state
  // without an effect (see react.dev "you might not need an effect").
  if (persistedCss !== persistedSeed) {
    setPersistedSeed(persistedCss)
    setDraft(persistedCss)
  }

  const handleSave = async () => {
    const sanitized = sanitizeUserCss(draft)
    setRemoved(sanitized.removedCount)
    setDraft(sanitized.css)
    await setCustomCss(sanitized.css)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <Label className="text-sm">{t("enabledLabel")}</Label>
        <Switch
          checked={persistedEnabled}
          onCheckedChange={(checked) => void setCustomCssEnabled(checked)}
          aria-label={t("enabledLabel")}
        />
      </div>

      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("placeholder")}
        rows={12}
        className="font-mono text-xs"
        aria-label={t("title")}
      />

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void handleSave()}>
          {t("saveButton")}
        </Button>
        {removed != null && removed > 0 && (
          <span className="text-xs text-muted-foreground">{t("removed", { count: removed })}</span>
        )}
      </div>
    </div>
  )
}
