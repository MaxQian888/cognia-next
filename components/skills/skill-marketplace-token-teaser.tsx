"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ExternalLinkIcon, TrophyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSettingsStore } from "@/stores/settings"

/**
 * Inline unlock row for the Browse list pane: explains that search/install
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
    <Alert
      className="rounded-none border-x-0 bg-muted/30"
      data-testid="skill-marketplace-token-teaser"
    >
      <TrophyIcon className="size-3.5" />
      <AlertTitle className="text-xs">{t("title")}</AlertTitle>
      <AlertDescription className="text-[11px]">
        <p>{t("body")}</p>
        <div className="mt-2 flex w-full gap-1.5">
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
        <Button asChild variant="link" size="xs" className="mt-1.5 h-auto px-0 text-[10px]">
          <a href="https://skills.sh/docs/api#authentication" target="_blank" rel="noreferrer">
            <ExternalLinkIcon className="size-2.5" />
            {t("docsLink")}
          </a>
        </Button>
      </AlertDescription>
    </Alert>
  )
}
