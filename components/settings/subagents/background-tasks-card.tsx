"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import type { ToolRules } from "@/lib/claude/permissions/ruleset"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.backgroundTasks")

/** Serialize a deny-list of projected subagent ids back into a `ToolRules`. */
function rulesToDenyLines(rules: ToolRules | undefined): string {
  if (!rules) return ""
  return Object.entries(rules)
    .filter(([, v]) => v === "deny")
    .map(([glob]) => glob)
    .join("\n")
}

/** Parse newline-separated globs into a deny-only `ToolRules` (empty → undefined). */
function denyLinesToRules(text: string): ToolRules | undefined {
  const globs = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (globs.length === 0) return undefined
  const rules: ToolRules = {}
  for (const glob of globs) rules[glob] = "deny"
  return rules
}

const clampInt = (value: string, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Writer UI for the background-subagent lifecycle + permission settings:
 *  - `backgroundTasks.autoResumeInterrupted` / `maxAutoResumeAttempts`
 *  - `agentPermissions.subagentAsks` (surface ⇄ auto-deny)
 *  - `agentPermissions.subagentRules` (dispatch deny-list glob editor)
 *
 * Without this card those settings had no writer, leaving the boot auto-resume
 * path and the dispatch policy dormant. Self-contained save (mirrors the
 * sibling nesting card).
 */
export function BackgroundTasksCard() {
  const t = useTranslations("settings.subagents.backgroundTasks")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [autoResume, setAutoResume] = useState(false)
  const [maxAttempts, setMaxAttempts] = useState(2)
  const [surfaceAsks, setSurfaceAsks] = useState(true)
  const [denyGlobs, setDenyGlobs] = useState("")

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const bg = settings?.backgroundTasks
    setAutoResume(bg?.autoResumeInterrupted ?? false)
    setMaxAttempts(bg?.maxAutoResumeAttempts ?? 2)
    const ap = settings?.agentPermissions
    setSurfaceAsks((ap?.subagentAsks ?? "surface") === "surface")
    setDenyGlobs(rulesToDenyLines(ap?.subagentRules))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const handleSave = async () => {
    try {
      const ap = settings?.agentPermissions ?? {}
      const subagentRules = denyLinesToRules(denyGlobs)
      await save({
        backgroundTasks: {
          autoResumeInterrupted: autoResume,
          maxAutoResumeAttempts: maxAttempts,
        },
        agentPermissions: {
          ...ap,
          subagentAsks: surfaceAsks ? "surface" : "auto-deny",
          ...(subagentRules ? { subagentRules } : { subagentRules: undefined }),
        },
      })
      log.info("backgroundTasks.saved", { autoResume, maxAttempts, surfaceAsks })
      toast.success(t("saved"))
    } catch (err) {
      log.error("backgroundTasks.saveFailed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4" data-setting-id="subagent-background-tasks">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-bg-auto-resume" className="text-sm">
            {t("autoResume")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("autoResumeHint")}</p>
        </div>
        <Switch
          id="settings-bg-auto-resume"
          checked={autoResume}
          onCheckedChange={setAutoResume}
          aria-label={t("autoResume")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-bg-max-attempts">{t("maxAttempts")}</Label>
        <Input
          id="settings-bg-max-attempts"
          type="number"
          min={1}
          max={10}
          value={maxAttempts}
          onChange={(e) => setMaxAttempts(clampInt(e.target.value, 1, 10, 2))}
          disabled={!autoResume}
          aria-label={t("maxAttempts")}
        />
        <p className="text-xs text-muted-foreground">{t("maxAttemptsHint")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-bg-surface-asks" className="text-sm">
            {t("surfaceAsks")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("surfaceAsksHint")}</p>
        </div>
        <Switch
          id="settings-bg-surface-asks"
          checked={surfaceAsks}
          onCheckedChange={setSurfaceAsks}
          aria-label={t("surfaceAsks")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-bg-deny-globs">{t("denyList")}</Label>
        <Textarea
          id="settings-bg-deny-globs"
          value={denyGlobs}
          onChange={(e) => setDenyGlobs(e.target.value)}
          placeholder={t("denyListPlaceholder")}
          rows={3}
          className="font-mono text-xs"
          aria-label={t("denyList")}
        />
        <p className="text-xs text-muted-foreground">{t("denyListHint")}</p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave}>
          {t("save")}
        </Button>
      </div>
    </div>
  )
}
