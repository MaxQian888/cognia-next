"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import { createLogger } from "@/lib/logging"
import type { InstructionMode, InstructionsConfig } from "@/lib/claude/instructions/types"

const log = createLogger("settings.instructions")

const MODES: InstructionMode[] = ["layered", "nearest"]

/**
 * App-level config for on-disk project instruction loading (CLAUDE.md /
 * AGENTS.md / AGENT.md, nested + `@import`) plus `.cognia/agents/*.md` subagent
 * discovery. Self-contained card with its own save — mirrors PersonalizationCard.
 */
export function InstructionsCard() {
  const t = useTranslations("settings.instructions")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<InstructionMode>("layered")
  const [includeGlobal, setIncludeGlobal] = useState(true)
  const [globalPath, setGlobalPath] = useState("")
  const [loadProjectAgents, setLoadProjectAgents] = useState(true)
  const [extraPaths, setExtraPaths] = useState("")

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
    try {
      await save({ instructions })
      log.info("instructions.saved", { enabled, mode, includeGlobal, loadProjectAgents })
      toast.success(t("saved"))
    } catch (err) {
      log.error("instructions.saveFailed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-instructions-enabled" className="text-sm">
            {t("enabled")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch
          id="settings-instructions-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enabled")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-instructions-mode">{t("mode.label")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => setMode(v as InstructionMode)}
          disabled={!enabled}
        >
          <SelectTrigger id="settings-instructions-mode">
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
        <p className="text-xs text-muted-foreground">{t("mode.hint")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-instructions-global" className="text-sm">
            {t("includeGlobal")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("includeGlobalHint")}</p>
        </div>
        <Switch
          id="settings-instructions-global"
          checked={includeGlobal}
          onCheckedChange={setIncludeGlobal}
          disabled={!enabled}
          aria-label={t("includeGlobal")}
        />
      </div>

      {includeGlobal && (
        <div className="space-y-2">
          <Label htmlFor="settings-instructions-global-path">{t("globalPath")}</Label>
          <Input
            id="settings-instructions-global-path"
            value={globalPath}
            onChange={(e) => setGlobalPath(e.target.value)}
            placeholder={t("globalPathPlaceholder")}
            disabled={!enabled}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-instructions-agents" className="text-sm">
            {t("loadProjectAgents")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("loadProjectAgentsHint")}</p>
        </div>
        <Switch
          id="settings-instructions-agents"
          checked={loadProjectAgents}
          onCheckedChange={setLoadProjectAgents}
          disabled={!enabled}
          aria-label={t("loadProjectAgents")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-instructions-extra">{t("extraPaths")}</Label>
        <Textarea
          id="settings-instructions-extra"
          value={extraPaths}
          onChange={(e) => setExtraPaths(e.target.value)}
          placeholder={t("extraPathsPlaceholder")}
          rows={3}
          disabled={!enabled}
          aria-label={t("extraPaths")}
        />
        <p className="text-xs text-muted-foreground">{t("extraPathsHint")}</p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave}>
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
