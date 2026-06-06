"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ExternalLinkIcon, TrophyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSettingsStore } from "@/stores/settings"

/**
 * Inline unlock card for the Browse list pane: explains that search/install
 * work without configuration and lets the user paste a Vercel OIDC token
 * right here (saved to `AppSettings.skillsShToken`) to enable the skills.sh
 * leaderboards + curated views. Shown only while no token is configured.
 */
export function SkillMarketplaceTokenTeaser() {
  const t = useTranslations("skills.marketplace.teaser")
  const save = useSettingsStore((s) => s.save)
  const hasToken = useSettingsStore((s) => Boolean(s.settings?.skillsShToken?.trim()))
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)

  if (hasToken) return null

  const handleSave = async () => {
    const token = draft.trim()
    if (!token) return
    setSaving(true)
    try {
      await save({ skillsShToken: token })
      toast.success(t("saved"))
      setDraft("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="m-1 rounded-lg border border-dashed bg-muted/30 p-3"
      data-testid="skill-marketplace-token-teaser"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-semibold">
        <TrophyIcon className="size-3.5 text-amber-500" />
        {t("title")}
      </h4>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t("body")}</p>
      <div className="mt-2 flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("tokenPlaceholder")}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-8 font-mono text-[11px]"
          aria-label={t("tokenPlaceholder")}
        />
        <Button
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => void handleSave()}
          disabled={saving || !draft.trim()}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
      <a
        href="https://skills.sh/docs/api#authentication"
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
      >
        <ExternalLinkIcon className="size-2.5" />
        {t("docsLink")}
      </a>
    </div>
  )
}
