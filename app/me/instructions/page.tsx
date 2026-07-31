"use client"

/**
 * Mobile Instructions page (ADR-0056, Wave 3). Remote-edits the paired
 * desktop's on-disk project-instruction loading config (CLAUDE.md / AGENTS.md
 * discovery, `.cognia/agents/*.md`). There is no project filesystem in
 * standalone mode, so this is paired-only (`<PairedOnly>`).
 *
 * Mirrors the desktop `InstructionsCard` field-for-field but persists through
 * `useSettingsPatch` (save + `app_settings_update`) so the edit reaches the
 * desktop. The desktop's live config syncs back via `CROSS_PLATFORM_SETTING_KEYS`
 * (`instructions`), so the form shows the real values. Reuses the desktop
 * `settings.instructions` i18n namespace for field labels.
 */

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { BiometricRow } from "@/components/mobile/me/biometric-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { useSettingsStore } from "@/stores/settings"
import type { InstructionMode, InstructionsConfig } from "@/lib/claude/instructions/types"

const MODES: InstructionMode[] = ["layered", "nearest"]

function InstructionsBody() {
  const t = useTranslations("settings.instructions")
  const tm = useTranslations("mobile.instructions")
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<InstructionMode>("layered")
  const [includeGlobal, setIncludeGlobal] = useState(true)
  const [globalPath, setGlobalPath] = useState("")
  const [loadProjectAgents, setLoadProjectAgents] = useState(true)
  const [extraPaths, setExtraPaths] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const cfg = settings?.instructions
    if (!cfg) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setEnabled(cfg.enabled ?? true)
    setMode(cfg.mode ?? "layered")
    setIncludeGlobal(cfg.includeGlobal ?? true)
    setGlobalPath(cfg.globalPath ?? "")
    setLoadProjectAgents(cfg.loadProjectAgents ?? true)
    setExtraPaths((cfg.extraPaths ?? []).join("\n"))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const handleSave = async () => {
    const extra = extraPaths
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    const instructions: InstructionsConfig = {
      enabled,
      mode,
      includeGlobal,
      globalPath: globalPath.trim() || undefined,
      loadProjectAgents,
      extraPaths: extra.length > 0 ? extra : undefined,
    }
    setSaving(true)
    try {
      await update({ instructions })
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <MeSection title={t("title")} description={t("description")} testid="me-section-instructions">
        <BiometricRow
          label={t("enabled")}
          help={t("enabledHint")}
          checked={enabled}
          onChange={setEnabled}
          testid="instructions-enabled"
        />
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">{t("mode.label")}</ItemTitle>
            <Select value={mode} onValueChange={(v) => setMode(v as InstructionMode)}>
              <SelectTrigger
                data-testid="instructions-mode"
                aria-label={t("mode.label")}
                className="mt-1"
                disabled={!enabled}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`mode.${m}` as `mode.${InstructionMode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ItemContent>
        </Item>
        <BiometricRow
          label={t("includeGlobal")}
          help={t("includeGlobalHint")}
          checked={includeGlobal}
          onChange={setIncludeGlobal}
          testid="instructions-include-global"
        />
        {includeGlobal ? (
          <Item size="sm" className="px-0">
            <ItemContent>
              <Label htmlFor="instructions-global-path" className="text-xs">
                {t("globalPath")}
              </Label>
              <Input
                id="instructions-global-path"
                value={globalPath}
                onChange={(e) => setGlobalPath(e.target.value)}
                placeholder={t("globalPathPlaceholder")}
                disabled={!enabled}
                data-testid="instructions-global-path"
                className="mt-1"
              />
            </ItemContent>
          </Item>
        ) : null}
        <BiometricRow
          label={t("loadProjectAgents")}
          help={t("loadProjectAgentsHint")}
          checked={loadProjectAgents}
          onChange={setLoadProjectAgents}
          testid="instructions-load-agents"
        />
        <Item size="sm" className="px-0">
          <ItemContent>
            <Label htmlFor="instructions-extra" className="text-xs">
              {t("extraPaths")}
            </Label>
            <Textarea
              id="instructions-extra"
              value={extraPaths}
              onChange={(e) => setExtraPaths(e.target.value)}
              placeholder={t("extraPathsPlaceholder")}
              rows={3}
              disabled={!enabled}
              data-testid="instructions-extra"
              className="mt-1"
            />
          </ItemContent>
        </Item>
      </MeSection>

      <Button onClick={() => void handleSave()} disabled={saving} data-testid="instructions-save">
        {tm("save")}
      </Button>
    </div>
  )
}

export default function MobileInstructionsPage() {
  const tm = useTranslations("mobile.instructions")
  return (
    <SubPageShell title={tm("title")} backAria={tm("backAria")} testid="mobile-instructions-page">
      <PairedOnly>
        <InstructionsBody />
      </PairedOnly>
    </SubPageShell>
  )
}
