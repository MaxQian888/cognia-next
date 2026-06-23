"use client"

// Defaults tab — permission mode, default model, working directory, append
// system prompt, thinking budget, routing fallback toggle. All fields back
// AppSettings.* and persist via `useSettingsStore.save`. Local state mirrors
// `settings` so blur-persist works without flicker.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"
import { OUTPUT_STYLE_IDS } from "@/lib/claude/output-styles"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InstructionsCard } from "@/components/settings/instructions/instructions-card"
import { DefaultModelPicker } from "../parts/default-model-picker"

const THINKING_BUDGET_MIN = 0
const THINKING_BUDGET_MAX = 64000
const THINKING_BUDGET_STEP = 1024

type PermissionMode = NonNullable<AppSettings["permissionMode"]>

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]

const PERMISSION_MODE_LABEL_KEY: Record<PermissionMode, string> = {
  default: "permDefault",
  acceptEdits: "permAcceptEdits",
  bypassPermissions: "permBypass",
  plan: "permPlan",
  dontAsk: "permDontAsk",
  auto: "permAuto",
}

export function DefaultsTab() {
  const t = useTranslations("settings.agentRuntimeSection.defaults")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default")
  const [workingDir, setWorkingDir] = useState("")
  const [appendSystem, setAppendSystem] = useState("")
  const [routingFallback, setRoutingFallback] = useState(true)
  const [cacheOptimization, setCacheOptimization] = useState(false)
  const [thinkingBudget, setThinkingBudget] = useState<number>(0)
  const [outputStyle, setOutputStyle] = useState("default")
  const [customOutputStyle, setCustomOutputStyle] = useState("")
  const [bareMode, setBareMode] = useState(false)
  const [briefMode, setBriefMode] = useState(false)

  useEffect(() => {
    if (!settings) return
    // Mirror persisted settings into local state so the inputs blur-persist
    // without flicker. The cascading-render warning is acceptable here —
    // settings only changes on initial load + rare external writes.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPermissionMode((settings.permissionMode ?? "default") as PermissionMode)
    setWorkingDir(settings.defaultWorkingDir ?? "")
    setAppendSystem(settings.defaultSystemPrompt ?? "")
    setRoutingFallback(settings.routingFallbackEnabled !== false)
    setCacheOptimization(settings.cacheOptimizationEnabled === true)
    setThinkingBudget(settings.defaultMaxThinkingTokens ?? 0)
    setOutputStyle(settings.outputStyle ?? "default")
    setCustomOutputStyle(settings.customOutputStyle ?? "")
    setBareMode(Boolean(settings.bareMode))
    setBriefMode(Boolean(settings.briefMode))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [settings])

  const persistPermission = (next: string) => {
    if (!PERMISSION_MODES.includes(next as PermissionMode)) return
    const value = next as PermissionMode
    setPermissionMode(value)
    void save({ permissionMode: value })
  }

  const persistWorkingDir = () => {
    const trimmed = workingDir.trim()
    void save({ defaultWorkingDir: trimmed || undefined })
  }

  const persistAppend = () => {
    const trimmed = appendSystem.trim()
    void save({ defaultSystemPrompt: trimmed || undefined })
  }

  const persistRouting = (value: boolean) => {
    setRoutingFallback(value)
    void save({ routingFallbackEnabled: value })
  }

  const persistCacheOptimization = (value: boolean) => {
    setCacheOptimization(value)
    void save({ cacheOptimizationEnabled: value || undefined })
  }

  // Clamp + round to the slider step so the number input can't drift away
  // from the slider thumb. Persists `undefined` when zero so the sidecar
  // falls back to the SDK default rather than serialising an explicit 0.
  const persistThinkingBudget = (raw: number) => {
    const clamped = Math.max(
      THINKING_BUDGET_MIN,
      Math.min(THINKING_BUDGET_MAX, Number.isFinite(raw) ? Math.round(raw) : 0)
    )
    setThinkingBudget(clamped)
    void save({ defaultMaxThinkingTokens: clamped > 0 ? clamped : undefined })
  }

  const persistOutputStyle = (next: string) => {
    setOutputStyle(next)
    void save({
      outputStyle: next === "default" ? undefined : next,
      customOutputStyle: next === "custom" ? customOutputStyle.trim() || undefined : undefined,
    })
  }

  const persistCustomOutputStyle = () => {
    if (outputStyle !== "custom") return
    void save({ customOutputStyle: customOutputStyle.trim() || undefined })
  }

  const persistBareMode = (value: boolean) => {
    setBareMode(value)
    void save({ bareMode: value || undefined })
  }

  const persistBriefMode = (value: boolean) => {
    setBriefMode(value)
    void save({ briefMode: value || undefined })
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="md:col-span-2" data-setting-id="permission-mode">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("permissionTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("permissionDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="agent-runtime-perm" className="text-xs">
            {t("permissionMode")}
          </Label>
          <Select value={permissionMode} onValueChange={persistPermission}>
            <SelectTrigger id="agent-runtime-perm" className="w-full md:w-[280px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(PERMISSION_MODE_LABEL_KEY[mode])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card data-setting-id="default-model">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("modelTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("modelDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <DefaultModelPicker />
        </CardContent>
      </Card>

      <Card data-setting-id="default-working-dir">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("workingDirTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("workingDirDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            onBlur={persistWorkingDir}
            placeholder={t("workingDirPlaceholder")}
            aria-label={t("workingDirTitle")}
          />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("appendTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("appendDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={appendSystem}
            onChange={(e) => setAppendSystem(e.target.value)}
            onBlur={persistAppend}
            rows={4}
            aria-label={t("appendTitle")}
            placeholder={t("appendPlaceholder")}
          />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("thinkingTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("thinkingDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Slider
              className="flex-1"
              value={[thinkingBudget]}
              min={THINKING_BUDGET_MIN}
              max={THINKING_BUDGET_MAX}
              step={THINKING_BUDGET_STEP}
              onValueChange={(v) => setThinkingBudget(v[0] ?? 0)}
              onValueCommit={(v) => persistThinkingBudget(v[0] ?? 0)}
              aria-label={t("thinkingTitle")}
              data-testid="thinking-budget-slider"
            />
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={THINKING_BUDGET_MIN}
                max={THINKING_BUDGET_MAX}
                step={THINKING_BUDGET_STEP}
                className="w-32 sm:w-28"
                value={thinkingBudget}
                onChange={(e) => setThinkingBudget(Number(e.target.value) || 0)}
                onBlur={() => persistThinkingBudget(thinkingBudget)}
                aria-label={t("thinkingNumberLabel")}
                data-testid="thinking-budget-input"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => persistThinkingBudget(0)}
                disabled={thinkingBudget === 0}
                data-testid="thinking-budget-reset"
              >
                {t("thinkingReset")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {thinkingBudget > 0
              ? t("thinkingActiveHint", { budget: thinkingBudget })
              : t("thinkingDisabledHint")}
          </p>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div className="space-y-0.5">
            <CardTitle className="text-sm">{t("routingTitle")}</CardTitle>
            <CardDescription className="text-xs">{t("routingDesc")}</CardDescription>
          </div>
          <Switch
            checked={routingFallback}
            onCheckedChange={persistRouting}
            aria-label={t("routingTitle")}
          />
        </CardHeader>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div className="space-y-0.5">
            <CardTitle className="text-sm">{t("cacheOptTitle")}</CardTitle>
            <CardDescription className="text-xs">{t("cacheOptDesc")}</CardDescription>
          </div>
          <Switch
            checked={cacheOptimization}
            onCheckedChange={persistCacheOptimization}
            aria-label={t("cacheOptTitle")}
            data-testid="cache-optimization-switch"
          />
        </CardHeader>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("outputStyle.label")}</CardTitle>
          <CardDescription className="text-xs">{t("outputStyle.hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select value={outputStyle} onValueChange={persistOutputStyle}>
            <SelectTrigger
              className="w-full md:w-[280px]"
              aria-label={t("outputStyle.label")}
              data-testid="output-style-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTPUT_STYLE_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`outputStyle.${id}` as `outputStyle.${typeof id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {outputStyle === "custom" && (
            <Textarea
              value={customOutputStyle}
              onChange={(e) => setCustomOutputStyle(e.target.value)}
              onBlur={persistCustomOutputStyle}
              rows={3}
              placeholder={t("outputStyle.customPlaceholder")}
              aria-label={t("outputStyle.customPlaceholder")}
            />
          )}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("behaviorTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("behaviorDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="agent-runtime-bare" className="text-sm">
                {t("bareMode")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("bareModeHint")}</p>
            </div>
            <Switch
              id="agent-runtime-bare"
              checked={bareMode}
              onCheckedChange={persistBareMode}
              aria-label={t("bareMode")}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="agent-runtime-brief" className="text-sm">
                {t("briefMode")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("briefModeHint")}</p>
            </div>
            <Switch
              id="agent-runtime-brief"
              checked={briefMode}
              onCheckedChange={persistBriefMode}
              aria-label={t("briefMode")}
            />
          </div>
        </CardContent>
      </Card>

      <div className="md:col-span-2">
        <InstructionsCard />
      </div>

      <PluginExtensionSlot
        point="settings.general"
        className="space-y-2 md:col-span-2 empty:hidden"
      />
    </div>
  )
}

export default DefaultsTab
