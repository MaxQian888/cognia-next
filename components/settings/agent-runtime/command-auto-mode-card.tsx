"use client"

// Command Auto-mode card — configures the agent's shell-command permission
// policy (`AppSettings.agentPermissions`). The master switch turns on
// automatic allow/deny decisions; the engine select picks rules-only vs
// rules+small-model; the rules editor lets the user pin a verdict for a
// command glob (these override Auto-mode). Renderer-side feature, so it works
// in both the browser and desktop shells. Saving goes through
// `useSettingsStore.save({ agentPermissions })`.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import type { PermissionVerdict, ToolRules } from "@/lib/claude/permissions/ruleset"

const VERDICTS: PermissionVerdict[] = ["allow", "ask", "deny"]

export function CommandAutoModeCard() {
  const t = useTranslations("settings.agentRuntimeSection.permissions.autoMode")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const ap = settings?.agentPermissions ?? {}
  const auto = ap.autoApprove ?? {}
  const enabled = auto.enabled ?? false
  const mode = auto.mode ?? "rules"
  const denyOnHighRisk = auto.denyOnHighRisk ?? true
  const rules: ToolRules = ap.commandRules ?? {}

  const [draftPattern, setDraftPattern] = useState("")
  const [draftVerdict, setDraftVerdict] = useState<PermissionVerdict>("ask")

  function patchAuto(patch: Partial<NonNullable<typeof auto>>): void {
    void save({ agentPermissions: { ...ap, autoApprove: { ...auto, ...patch } } })
  }

  function setRules(next: ToolRules): void {
    void save({ agentPermissions: { ...ap, commandRules: next } })
  }

  function addRule(): void {
    const pattern = draftPattern.trim()
    if (!pattern) return
    setRules({ ...rules, [pattern]: draftVerdict })
    setDraftPattern("")
  }

  function removeRule(pattern: string): void {
    const next = { ...rules }
    delete next[pattern]
    setRules(next)
  }

  const verdictLabel = (v: PermissionVerdict): string =>
    v === "allow" ? t("verdictAllow") : v === "deny" ? t("verdictDeny") : t("verdictAsk")

  const ruleEntries = Object.entries(rules)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheckIcon className="size-4" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auto-mode-enable" className="text-sm font-normal">
            {t("enable")}
          </Label>
          <Switch
            id="auto-mode-enable"
            checked={enabled}
            onCheckedChange={(v) => patchAuto({ enabled: v })}
            aria-label={t("enable")}
          />
        </div>

        {enabled && (
          <>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("modeLabel")}</Label>
              <Select
                value={mode}
                onValueChange={(v) => patchAuto({ mode: v as "rules" | "rules+model" })}
              >
                <SelectTrigger className="w-full" aria-label={t("modeLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rules">{t("modeRules")}</SelectItem>
                  <SelectItem value="rules+model">{t("modeRulesModel")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("modeHint")}</p>
            </div>

            {mode === "rules+model" && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="auto-mode-deny-high" className="text-sm font-normal">
                      {t("denyHighRisk")}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t("denyHighRiskHint")}</p>
                  </div>
                  <Switch
                    id="auto-mode-deny-high"
                    checked={denyOnHighRisk}
                    onCheckedChange={(v) => patchAuto({ denyOnHighRisk: v })}
                    aria-label={t("denyHighRisk")}
                  />
                </div>
                <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                  {t("privacyNote")}
                </p>
              </>
            )}

            <div className="space-y-2 border-t pt-3">
              <div className="space-y-0.5">
                <Label className="text-sm">{t("rulesTitle")}</Label>
                <p className="text-xs text-muted-foreground">{t("rulesDesc")}</p>
              </div>

              {ruleEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground" role="status">
                  {t("noRules")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {ruleEntries.map(([pattern, verdict]) => (
                    <li
                      key={pattern}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                    >
                      <code className="truncate font-mono text-xs">{pattern}</code>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-xs text-muted-foreground">
                          {verdictLabel(verdict as PermissionVerdict)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => removeRule(pattern)}
                          aria-label={`${t("removeRule")}: ${pattern}`}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={draftPattern}
                  onChange={(e) => setDraftPattern(e.target.value)}
                  placeholder={t("patternPlaceholder")}
                  aria-label={t("patternPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addRule()
                    }
                  }}
                  className="flex-1"
                />
                <Select
                  value={draftVerdict}
                  onValueChange={(v) => setDraftVerdict(v as PermissionVerdict)}
                >
                  <SelectTrigger className="w-full sm:w-28" aria-label={t("addRule")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VERDICTS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {verdictLabel(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={addRule} disabled={!draftPattern.trim()}>
                  <PlusIcon className="mr-2 size-4" />
                  {t("addRule")}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default CommandAutoModeCard
