"use client"

// Defaults panel — permission mode, default model, working directory, append
// system prompt, thinking budget, routing fallback toggle. All fields back
// AppSettings.* and persist via `useSettingsStore.save`. Local state mirrors
// `settings` so blur-persist works without flicker.
//
// Card-free: this is one long form living inside the runtime's detail pane, so
// every group is a `SettingsBlock` separated by a hairline rather than a
// floating `<Card>` nested inside the pane's own border. The `data-setting-id`
// anchors the settings finder jumps to are carried by `settingId`.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
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
import type { AppSettings } from "@cognia/agent-config-types"
import { OUTPUT_STYLE_IDS } from "@/lib/claude/output-styles"
import {
  ADVANCED_MODES,
  permissionRiskMarker,
  SAFE_CYCLE_MODES,
} from "@/lib/settings/permission-mode-meta"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { InstructionsCard } from "@/components/settings/instructions/instructions-card"
import { DefaultModelPicker } from "../parts/default-model-picker"
import {
  PLAN_HTML_STYLES,
  resolvePlanHtmlStyle,
  type PlanHtmlStyle,
} from "@/lib/agent/plan/plan-html"

const THINKING_BUDGET_MIN = 0
const THINKING_BUDGET_MAX = 64000
const THINKING_BUDGET_STEP = 1024

type PermissionMode = NonNullable<AppSettings["permissionMode"]>

// Safe-core modes first, then the advanced (opt-in) ones — a single ordering
// derived from the shared metadata so this selector never drifts from the
// composer chip / status bar.
const PERMISSION_MODES: PermissionMode[] = [...SAFE_CYCLE_MODES, ...ADVANCED_MODES]

const PERMISSION_MODE_LABEL_KEY: Record<PermissionMode, string> = {
  default: "permDefault",
  acceptEdits: "permAcceptEdits",
  bypassPermissions: "permBypass",
  plan: "permPlan",
  dontAsk: "permDontAsk",
  auto: "permAuto",
}

const PLAN_STYLE_LABEL_KEY: Record<PlanHtmlStyle, string> = {
  default: "planStyleDefault",
  compact: "planStyleCompact",
  timeline: "planStyleTimeline",
  cards: "planStyleCards",
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
  const [planRequireApproval, setPlanRequireApproval] = useState(true)
  const [planMaxAutoRefinements, setPlanMaxAutoRefinements] = useState<number>(2)
  const [planInteractiveHtml, setPlanInteractiveHtml] = useState(false)
  const [planInteractiveStyle, setPlanInteractiveStyle] = useState<PlanHtmlStyle>("default")
  const [planAgentAuthoring, setPlanAgentAuthoring] = useState(true)

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
    setCacheOptimization(settings.cacheOptimizationEnabled !== false)
    setThinkingBudget(settings.defaultMaxThinkingTokens ?? 0)
    setOutputStyle(settings.outputStyle ?? "default")
    setCustomOutputStyle(settings.customOutputStyle ?? "")
    setBareMode(Boolean(settings.bareMode))
    setBriefMode(Boolean(settings.briefMode))
    setPlanRequireApproval(settings.planSettings?.requireApproval !== false)
    setPlanMaxAutoRefinements(settings.planSettings?.maxAutoRefinements ?? 2)
    setPlanInteractiveHtml(settings.planSettings?.interactiveHtmlView === true)
    setPlanInteractiveStyle(resolvePlanHtmlStyle(settings.planSettings?.interactiveHtmlStyle))
    setPlanAgentAuthoring(settings.planSettings?.agentAuthoring !== false)
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
    // Persist the explicit boolean (not `value || undefined`) so an OFF choice
    // sticks against the default-ON — `false` must survive the DEFAULTS merge.
    void save({ cacheOptimizationEnabled: value })
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

  const persistPlanRequireApproval = (value: boolean) => {
    setPlanRequireApproval(value)
    // Persist the explicit boolean so an OFF choice survives the default-ON
    // merge (same rationale as cacheOptimizationEnabled).
    void save({
      planSettings: { ...settings?.planSettings, requireApproval: value },
    })
  }

  const persistPlanInteractiveHtml = (value: boolean) => {
    setPlanInteractiveHtml(value)
    // Opt-in enhanced plan mode (default OFF) — persist the explicit boolean.
    void save({
      planSettings: { ...settings?.planSettings, interactiveHtmlView: value },
    })
  }

  const persistPlanInteractiveStyle = (next: string) => {
    const value = resolvePlanHtmlStyle(next)
    setPlanInteractiveStyle(value)
    void save({
      planSettings: { ...settings?.planSettings, interactiveHtmlStyle: value },
    })
  }

  const persistPlanAgentAuthoring = (value: boolean) => {
    setPlanAgentAuthoring(value)
    // Default ON: persist the explicit boolean so the send spec can carry the
    // opt-out (`SendOptions.planTools === false`) to the sidecar.
    void update({
      planSettings: { ...settings?.planSettings, agentAuthoring: value },
    })
  }

  const persistPlanMaxAutoRefinements = (raw: number) => {
    const clamped = Math.max(0, Math.min(10, Number.isFinite(raw) ? Math.round(raw) : 2))
    setPlanMaxAutoRefinements(clamped)
    void save({
      planSettings: { ...settings?.planSettings, maxAutoRefinements: clamped },
    })
  }

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("permissionTitle")}
        description={t("permissionDesc")}
        settingId="permission-mode"
      >
        <SettingsField htmlFor="agent-runtime-perm" label={t("permissionMode")}>
          <Select value={permissionMode} onValueChange={persistPermission}>
            <SelectTrigger id="agent-runtime-perm" className="w-full @md/settings-stack:w-[280px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODES.map((mode) => {
                const marker = permissionRiskMarker(mode)
                return (
                  <SelectItem key={mode} value={mode}>
                    <span className="flex items-center gap-1.5">
                      {marker && (
                        <span
                          aria-hidden
                          className={marker === "⚠" ? "text-rose-500" : "text-muted-foreground"}
                        >
                          {marker}
                        </span>
                      )}
                      {t(PERMISSION_MODE_LABEL_KEY[mode])}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsBlock>

      <SettingsBlock title={t("modelTitle")} description={t("modelDesc")} settingId="default-model">
        <DefaultModelPicker />
      </SettingsBlock>

      <SettingsBlock
        title={t("workingDirTitle")}
        description={t("workingDirDesc")}
        settingId="default-working-dir"
      >
        <Input
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          onBlur={persistWorkingDir}
          placeholder={t("workingDirPlaceholder")}
          aria-label={t("workingDirTitle")}
        />
      </SettingsBlock>

      <SettingsBlock title={t("appendTitle")} description={t("appendDesc")} collapsible>
        <Textarea
          value={appendSystem}
          onChange={(e) => setAppendSystem(e.target.value)}
          onBlur={persistAppend}
          rows={4}
          aria-label={t("appendTitle")}
          placeholder={t("appendPlaceholder")}
        />
      </SettingsBlock>

      <SettingsBlock title={t("thinkingTitle")} description={t("thinkingDesc")}>
        <div className="flex flex-col gap-3 @md/settings-stack:flex-row @md/settings-stack:items-center">
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
          <div className="flex shrink-0 items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={THINKING_BUDGET_MIN}
              max={THINKING_BUDGET_MAX}
              step={THINKING_BUDGET_STEP}
              className="w-28"
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
      </SettingsBlock>

      <SettingsBlock
        title={t("outputStyle.label")}
        description={t("outputStyle.hint")}
        contentClassName="space-y-2"
      >
        <Select value={outputStyle} onValueChange={persistOutputStyle}>
          <SelectTrigger
            className="w-full @md/settings-stack:w-[280px]"
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
      </SettingsBlock>

      <SettingsBlock
        title={t("behaviorTitle")}
        description={t("behaviorDesc")}
        contentClassName="space-y-0 [&>*+*]:pt-4"
      >
        <SettingsField
          htmlFor="agent-runtime-bare"
          label={t("bareMode")}
          description={t("bareModeHint")}
        >
          <Switch
            id="agent-runtime-bare"
            checked={bareMode}
            onCheckedChange={persistBareMode}
            aria-label={t("bareMode")}
          />
        </SettingsField>
        <SettingsField
          htmlFor="agent-runtime-brief"
          label={t("briefMode")}
          description={t("briefModeHint")}
        >
          <Switch
            id="agent-runtime-brief"
            checked={briefMode}
            onCheckedChange={persistBriefMode}
            aria-label={t("briefMode")}
          />
        </SettingsField>
        <SettingsField label={t("routingTitle")} description={t("routingDesc")}>
          <Switch
            checked={routingFallback}
            onCheckedChange={persistRouting}
            aria-label={t("routingTitle")}
          />
        </SettingsField>
        <SettingsField label={t("cacheOptTitle")} description={t("cacheOptDesc")}>
          <Switch
            checked={cacheOptimization}
            onCheckedChange={persistCacheOptimization}
            aria-label={t("cacheOptTitle")}
            data-testid="cache-optimization-switch"
          />
        </SettingsField>
      </SettingsBlock>

      <SettingsBlock
        title={t("planTitle")}
        description={t("planDesc")}
        settingId="plan-mode"
        collapsible
        contentClassName="space-y-0 [&>*+*]:pt-4"
      >
        <SettingsField
          htmlFor="agent-runtime-plan-approval"
          label={t("planRequireApproval")}
          description={t("planRequireApprovalHint")}
        >
          <Switch
            id="agent-runtime-plan-approval"
            checked={planRequireApproval}
            onCheckedChange={persistPlanRequireApproval}
            aria-label={t("planRequireApproval")}
            data-testid="plan-require-approval-switch"
          />
        </SettingsField>
        <SettingsField
          htmlFor="agent-runtime-plan-agent-authoring"
          label={t("planAgentAuthoring")}
          description={t("planAgentAuthoringHint")}
        >
          <Switch
            id="agent-runtime-plan-agent-authoring"
            checked={planAgentAuthoring}
            onCheckedChange={persistPlanAgentAuthoring}
            aria-label={t("planAgentAuthoring")}
            data-testid="plan-agent-authoring-switch"
          />
        </SettingsField>
        <SettingsField
          htmlFor="agent-runtime-plan-interactive"
          label={t("planInteractiveHtml")}
          description={t("planInteractiveHtmlHint")}
        >
          <Switch
            id="agent-runtime-plan-interactive"
            checked={planInteractiveHtml}
            onCheckedChange={persistPlanInteractiveHtml}
            aria-label={t("planInteractiveHtml")}
            data-testid="plan-interactive-html-switch"
          />
        </SettingsField>
        <SettingsField
          htmlFor="agent-runtime-plan-style"
          label={t("planInteractiveStyle")}
          description={t("planInteractiveStyleHint")}
        >
          <Select
            value={planInteractiveStyle}
            onValueChange={persistPlanInteractiveStyle}
            disabled={!planInteractiveHtml}
          >
            <SelectTrigger
              id="agent-runtime-plan-style"
              className="w-[160px]"
              aria-label={t("planInteractiveStyle")}
              data-testid="plan-interactive-style-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_HTML_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(PLAN_STYLE_LABEL_KEY[style])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
        <SettingsField
          htmlFor="agent-runtime-plan-refinements"
          label={t("planMaxAutoRefinements")}
          description={t("planMaxAutoRefinementsHint")}
        >
          <Input
            id="agent-runtime-plan-refinements"
            type="number"
            inputMode="numeric"
            min={0}
            max={10}
            step={1}
            className="w-24"
            value={planMaxAutoRefinements}
            onChange={(e) => setPlanMaxAutoRefinements(Number(e.target.value) || 0)}
            onBlur={() => persistPlanMaxAutoRefinements(planMaxAutoRefinements)}
            aria-label={t("planMaxAutoRefinements")}
            data-testid="plan-max-refinements-input"
          />
        </SettingsField>
      </SettingsBlock>

      <InstructionsCard />

      <PluginExtensionSlot point="settings.general" className="space-y-2 empty:hidden" />
    </SettingsStack>
  )
}

export default DefaultsTab
