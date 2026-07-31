"use client"

// Surface-skills toggle — governs whether the built-in, surface-specific
// guidance skills (IM auto-reply, computer-use safety, workflow authoring,
// agent-team delegation, digital-twin grounding, goal/loop execution) are
// auto-injected on their matching agent surface. The flag flows into
// `resolveSendOptions` (lib/claude/build-options.ts) via
// `appSettings.surfaceSkillsEnabled`; default is ON (undefined ⇒ enabled).

import { useTranslations } from "next-intl"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"

export function SurfaceSkillsToggle() {
  const t = useTranslations("settings.builtInSkills.surfaceSkills")
  // Default ON: only an explicit `false` disables surface auto-activation.
  const enabled = useSettingsStore((s) => s.settings?.surfaceSkillsEnabled !== false)
  const save = useSettingsStore((s) => s.save)

  const handleToggle = (value: boolean) => {
    void save({ surfaceSkillsEnabled: value })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </div>
        <Switch checked={enabled} onCheckedChange={handleToggle} aria-label={t("title")} />
      </CardHeader>
    </Card>
  )
}

export default SurfaceSkillsToggle
