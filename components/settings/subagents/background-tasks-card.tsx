"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { ToolRules } from "@/lib/claude/permissions/ruleset"
import type { AppSettings } from "@cognia/agent-config-types"

/** Serialize a deny-list of projected subagent ids back into editor text. */
export function rulesToDenyLines(rules: ToolRules | undefined): string {
  if (!rules) return ""
  return Object.entries(rules)
    .filter(([, v]) => v === "deny")
    .map(([glob]) => glob)
    .join("\n")
}

/** Parse newline-separated globs into a deny-only `ToolRules` (empty → undefined). */
export function denyLinesToRules(text: string): ToolRules | undefined {
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

export interface BackgroundPolicyValues {
  autoResume: boolean
  maxAttempts: number
  /** true → `subagentAsks: "surface"`, false → `"auto-deny"`. */
  surfaceAsks: boolean
  /** Newline-separated glob text; parsed to `subagentRules` on save. */
  denyGlobs: string
}

export const BACKGROUND_DEFAULTS: BackgroundPolicyValues = {
  autoResume: false,
  maxAttempts: 2,
  surfaceAsks: true,
  denyGlobs: "",
}

export function backgroundValuesFromSettings(
  settings: AppSettings | null | undefined
): BackgroundPolicyValues {
  const bg = settings?.backgroundTasks
  const ap = settings?.agentPermissions
  return {
    autoResume: bg?.autoResumeInterrupted ?? BACKGROUND_DEFAULTS.autoResume,
    maxAttempts: bg?.maxAutoResumeAttempts ?? BACKGROUND_DEFAULTS.maxAttempts,
    surfaceAsks: (ap?.subagentAsks ?? "surface") === "surface",
    denyGlobs: rulesToDenyLines(ap?.subagentRules),
  }
}

/**
 * Project the form back onto the two settings branches it spans. The existing
 * `agentPermissions` is spread through so this card never drops a sibling key
 * it does not own.
 */
export function backgroundValuesToSettings(
  values: BackgroundPolicyValues,
  existingPermissions: AppSettings["agentPermissions"] | undefined
): Pick<AppSettings, "backgroundTasks" | "agentPermissions"> {
  const subagentRules = denyLinesToRules(values.denyGlobs)
  return {
    backgroundTasks: {
      autoResumeInterrupted: values.autoResume,
      maxAutoResumeAttempts: values.maxAttempts,
    },
    agentPermissions: {
      ...(existingPermissions ?? {}),
      subagentAsks: values.surfaceAsks ? "surface" : "auto-deny",
      subagentRules,
    },
  }
}

export interface BackgroundTasksCardProps {
  value: BackgroundPolicyValues
  onChange: (partial: Partial<BackgroundPolicyValues>) => void
}

/**
 * Writer UI for the background-subagent lifecycle + permission settings:
 * `backgroundTasks.*`, `agentPermissions.subagentAsks`, and the dispatch
 * deny-list (`agentPermissions.subagentRules`). Without this card those
 * settings had no writer at all, leaving the boot auto-resume path and the
 * dispatch policy dormant.
 *
 * Controlled — see the note on `SubagentNestingCard` for why the local state
 * and per-card Save button were removed.
 */
export function BackgroundTasksCard({ value, onChange }: BackgroundTasksCardProps) {
  const t = useTranslations("settings.subagents.backgroundTasks")

  return (
    <div className="space-y-4" data-setting-id="subagent-background-tasks">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-bg-auto-resume" className="text-sm">
            {t("autoResume")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("autoResumeHint")}</p>
        </div>
        <Switch
          id="settings-bg-auto-resume"
          checked={value.autoResume}
          onCheckedChange={(autoResume) => onChange({ autoResume })}
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
          value={value.maxAttempts}
          onChange={(e) => onChange({ maxAttempts: clampInt(e.target.value, 1, 10, 2) })}
          disabled={!value.autoResume}
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
          checked={value.surfaceAsks}
          onCheckedChange={(surfaceAsks) => onChange({ surfaceAsks })}
          aria-label={t("surfaceAsks")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-bg-deny-globs">{t("denyList")}</Label>
        <Textarea
          id="settings-bg-deny-globs"
          value={value.denyGlobs}
          onChange={(e) => onChange({ denyGlobs: e.target.value })}
          placeholder={t("denyListPlaceholder")}
          rows={3}
          className="font-mono text-xs"
          aria-label={t("denyList")}
        />
        <p className="text-xs text-muted-foreground">{t("denyListHint")}</p>
      </div>
    </div>
  )
}
