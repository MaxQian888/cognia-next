"use client"

// Opt-in automatic tier routing. When enabled, the send path scores each
// non-alias prompt's difficulty (0–1, lexical heuristic) and rewrites the
// model to a tier alias (fast/balanced/powerful), which the existing routing
// engine then resolves. Persisted on AppSettings.autoRouting. Default OFF — a
// strict no-op until enabled AND matching aliases exist in the mapping list
// above. See `lib/routing/auto-tier.ts`.
//
// The judge/provider-policy/category-alias groups below configure the same
// policy the routing engine reads through `getAutoRoutingPolicy()` (ADR-0043
// Phase 12). The dormant block lists legacy fields that are still persisted
// but read by nothing — Rule 7: labeled inert in the UI.

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { ProviderModelCombobox } from "./provider-model-combobox"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import { TASK_CATEGORIES, type TaskCategory } from "@cognia/provider-types/auto-router"
import type { ModelTier } from "@cognia/provider-types/auto-router"
import type { ProviderName } from "@cognia/provider-types/provider"
import { DEFAULT_AUTO_ROUTING, type AutoRoutingSettings } from "@/types/routing/tool-route"

// Radix Select items cannot carry an empty-string value, so the two
// "unset" choices use sentinel values that never collide with an alias
// or provider id.
const FOLLOW_LADDER_VALUE = "__follow_ladder__"
const NONE_VALUE = "__none__"

function ProviderChip({
  label,
  pressed,
  disabled,
  onToggle,
  testId,
}: {
  label: string
  pressed: boolean
  disabled?: boolean
  onToggle: () => void
  testId: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
      className={cn(
        "h-auto rounded-pill px-2 py-0.5 text-[10px] font-normal",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed
          ? "border-transparent bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {label}
    </Button>
  )
}

export function AutoRoutingSection() {
  const t = useTranslations("providers.routingView.auto")
  const tRoot = useTranslations("providers.routingView")
  const stored = useSettingsStore((s) => s.settings?.autoRouting)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const modelMappings = useSettingsStore((s) => s.settings?.modelMappings)
  const settings: AutoRoutingSettings = {
    ...DEFAULT_AUTO_ROUTING,
    ...(stored ?? {}),
    dataPolicy: {
      ...DEFAULT_AUTO_ROUTING.dataPolicy,
      ...(stored?.dataPolicy ?? {}),
    },
    thresholds: {
      ...DEFAULT_AUTO_ROUTING.thresholds,
      ...(stored?.thresholds ?? {}),
    },
    judge: {
      enabled: stored?.judge?.enabled ?? DEFAULT_AUTO_ROUTING.judge?.enabled ?? false,
      uncertaintyBand:
        stored?.judge?.uncertaintyBand ?? DEFAULT_AUTO_ROUTING.judge?.uncertaintyBand,
      timeoutMs: stored?.judge?.timeoutMs ?? DEFAULT_AUTO_ROUTING.judge?.timeoutMs,
    },
  }
  const save = useSettingsStore((s) => s.save)

  const patch = (partial: Partial<AutoRoutingSettings>) =>
    void save({ autoRouting: { ...settings, ...partial } })

  const setThreshold = (key: "balanced" | "powerful", raw: string) => {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      patch({ thresholds: { ...settings.thresholds, [key]: n } })
    }
  }

  // Same provider universe the alias editor and constraints editor use —
  // a provider the router cannot see must not be selectable here either.
  const providerIds = useMemo(
    () =>
      groupByProvider(collectOptions(providerSettings, customProviders)).map((g) => g.providerId),
    [providerSettings, customProviders]
  )
  const enabledAliasNames = useMemo(
    () => (modelMappings ?? []).filter((m) => m.enabled).map((m) => m.alias),
    [modelMappings]
  )

  const judgeActive = settings.enabled && settings.judge?.enabled === true

  const setJudgeNumber = (key: "uncertaintyBand" | "timeoutMs", raw: string) => {
    const n = Number(raw)
    const inRange =
      key === "uncertaintyBand"
        ? Number.isFinite(n) && n >= 0 && n <= 0.5
        : Number.isInteger(n) && n >= 100 && n <= 5000
    if (inRange)
      patch({ judge: { enabled: settings.judge?.enabled ?? false, ...settings.judge, [key]: n } })
  }

  // Preferred/excluded are mutually exclusive: adding a provider to one list
  // removes it from the other in the same patch.
  const toggleProvider = (key: "preferredProviders" | "excludedProviders", id: string) => {
    const other = key === "preferredProviders" ? "excludedProviders" : "preferredProviders"
    const list = settings[key]
    const adding = !list.includes(id as ProviderName)
    patch({
      [key]: adding ? [...list, id as ProviderName] : list.filter((p) => p !== id),
      ...(adding ? { [other]: settings[other].filter((p) => p !== id) } : {}),
    })
  }

  const setMaxCost = (raw: string) => {
    if (raw.trim() === "") {
      patch({ maxCostPerRequest: undefined })
      return
    }
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) patch({ maxCostPerRequest: n })
  }

  const setCategoryAlias = (category: TaskCategory, raw: string) => {
    const next = { ...(settings.categoryAliases ?? {}) }
    if (raw === FOLLOW_LADDER_VALUE) {
      delete next[category]
    } else {
      next[category] = raw
    }
    patch({ categoryAliases: next })
  }

  const setFallbackTier = (raw: string) => {
    // `undefined` is a first-class value here: the default is no tier retry,
    // so "none" and an absent key converge after the settings merge.
    patch({ fallbackTier: raw === NONE_VALUE ? undefined : (raw as ModelTier) })
  }

  return (
    <div className="space-y-4" data-testid="auto-routing-section">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="auto-routing-enabled" className="text-xs">
          {t("enabled")}
        </Label>
        <Switch
          id="auto-routing-enabled"
          checked={settings.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked === true })}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-default" className="text-xs">
            {t("defaultSelection")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("defaultSelectionHint")}</p>
        </div>
        <Switch
          id="auto-routing-default"
          checked={settings.defaultSelection === "auto"}
          onCheckedChange={(checked) =>
            patch({ defaultSelection: checked === true ? "auto" : "manual" })
          }
          disabled={!settings.enabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-local-only" className="text-xs">
            {t("localOnly")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("localOnlyHint")}</p>
        </div>
        <Switch
          id="auto-routing-local-only"
          checked={settings.dataPolicy.locality === "local-only"}
          onCheckedChange={(checked) =>
            patch({
              dataPolicy: {
                ...settings.dataPolicy,
                locality: checked === true ? "local-only" : "any",
              },
            })
          }
          disabled={!settings.enabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label htmlFor="auto-routing-shadow" className="text-xs">
            {t("shadowMode")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("shadowModeHint")}</p>
        </div>
        <Switch
          id="auto-routing-shadow"
          checked={settings.shadowMode}
          onCheckedChange={(checked) => patch({ shadowMode: checked === true })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-threshold-balanced">
            {t("thresholdBalanced")}
          </Label>
          <Input
            id="auto-threshold-balanced"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.thresholds.balanced}
            onChange={(e) => setThreshold("balanced", e.target.value)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-threshold-powerful">
            {t("thresholdPowerful")}
          </Label>
          <Input
            id="auto-threshold-powerful"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.thresholds.powerful}
            onChange={(e) => setThreshold("powerful", e.target.value)}
            className="h-8 text-xs"
            disabled={!settings.enabled}
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("hint", { tiers: settings.candidateAliases.join(" → ") })}
      </p>

      {/* Second-opinion difficulty judge (ADR-0043 Phase 10) */}
      <div className="space-y-3 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <Label htmlFor="auto-judge-enabled" className="text-xs">
              {t("judgeEnabled")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("judgeHint")}</p>
          </div>
          <Switch
            id="auto-judge-enabled"
            checked={settings.judge?.enabled === true}
            onCheckedChange={(checked) =>
              patch({ judge: { ...settings.judge, enabled: checked === true } })
            }
            disabled={!settings.enabled}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auto-judge-band">
              {t("judgeUncertaintyBand")}
            </Label>
            <Input
              id="auto-judge-band"
              type="number"
              min={0}
              max={0.5}
              step={0.01}
              value={settings.judge?.uncertaintyBand ?? 0.08}
              onChange={(e) => setJudgeNumber("uncertaintyBand", e.target.value)}
              className="h-8 text-xs"
              disabled={!judgeActive}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="auto-judge-timeout">
              {t("judgeTimeoutMs")}
            </Label>
            <Input
              id="auto-judge-timeout"
              type="number"
              min={100}
              max={5000}
              step={50}
              value={settings.judge?.timeoutMs ?? 400}
              onChange={(e) => setJudgeNumber("timeoutMs", e.target.value)}
              className="h-8 text-xs"
              disabled={!judgeActive}
            />
          </div>
        </div>

        {/* Same provider/model picker the difficulty section uses; the clear
            button restores the utility-model default by removing the field. */}
        <fieldset className="space-y-1.5" disabled={!judgeActive}>
          <legend className="text-xs font-medium">{t("routerModel")}</legend>
          <div className="flex items-center gap-2">
            <ProviderModelCombobox
              className="flex-1"
              providerId={settings.routerModel?.provider || undefined}
              modelId={settings.routerModel?.model || undefined}
              onSelect={(providerId, modelId) =>
                patch({
                  routerModel: {
                    provider: providerId as ProviderName,
                    model: modelId,
                    priority: 0,
                  },
                })
              }
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 text-xs"
              disabled={!settings.routerModel}
              onClick={() => patch({ routerModel: undefined })}
            >
              {t("routerModelClear")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("routerModelHint")}</p>
        </fieldset>
      </div>

      {/* Judge/routing-decision cache */}
      <div className="space-y-3 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="auto-cache-enabled" className="text-xs">
            {t("cacheEnabled")}
          </Label>
          <Switch
            id="auto-cache-enabled"
            checked={settings.enableCache}
            onCheckedChange={(checked) => patch({ enableCache: checked === true })}
            disabled={!settings.enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-cache-ttl">
            {t("cacheTtl")}
          </Label>
          <Input
            id="auto-cache-ttl"
            type="number"
            min={10}
            max={86400}
            step={1}
            value={settings.cacheTTL}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 10 && n <= 86400) patch({ cacheTTL: n })
            }}
            className="h-8 text-xs"
            disabled={!settings.enabled || !settings.enableCache}
          />
        </div>
      </div>

      {/* Provider policy: preferred order, exclusions, soft per-request cap */}
      <div className="space-y-3 border-t pt-3">
        <p className="text-xs font-medium">{t("providerPolicyTitle")}</p>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("preferredProviders")}</Label>
          <div className="flex flex-wrap gap-1">
            {providerIds.map((id) => (
              <ProviderChip
                key={id}
                label={id}
                pressed={settings.preferredProviders.includes(id as ProviderName)}
                disabled={!settings.enabled}
                onToggle={() => toggleProvider("preferredProviders", id)}
                testId={`auto-preferred-${id}`}
              />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("preferredProvidersHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("excludedProviders")}</Label>
          <div className="flex flex-wrap gap-1">
            {providerIds.map((id) => (
              <ProviderChip
                key={id}
                label={id}
                pressed={settings.excludedProviders.includes(id as ProviderName)}
                disabled={!settings.enabled}
                onToggle={() => toggleProvider("excludedProviders", id)}
                testId={`auto-excluded-${id}`}
              />
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="auto-max-cost">
            {t("maxCostPerRequest")}
          </Label>
          <Input
            id="auto-max-cost"
            type="number"
            min={0}
            step={1}
            value={settings.maxCostPerRequest ?? ""}
            onChange={(e) => setMaxCost(e.target.value)}
            className="h-8 w-32 text-xs"
            disabled={!settings.enabled}
          />
          <p className="text-[11px] text-muted-foreground">{t("maxCostPerRequestHint")}</p>
        </div>
      </div>

      {/* Task-category → alias overrides */}
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium">{t("categoryAliasesTitle")}</p>
        {TASK_CATEGORIES.map((category) => (
          <div key={category} className="flex items-center justify-between gap-2">
            <Label className="text-xs">{tRoot(`taskCategory.${category}`)}</Label>
            <Select
              value={settings.categoryAliases?.[category] ?? FOLLOW_LADDER_VALUE}
              onValueChange={(v) => setCategoryAlias(category, v)}
              disabled={!settings.enabled}
            >
              <SelectTrigger
                className="h-8 w-44 text-xs"
                aria-label={tRoot(`taskCategory.${category}`)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_LADDER_VALUE}>{t("categoryFollowLadder")}</SelectItem>
                {enabledAliasNames.map((alias) => (
                  <SelectItem key={alias} value={alias}>
                    {alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">{t("categoryAliasesHint")}</p>
      </div>

      {/* Fallback used only when Auto finds no viable candidate */}
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium">{t("fallbackTitle")}</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("fallbackTier")}</Label>
            <Select
              value={settings.fallbackTier ?? NONE_VALUE}
              onValueChange={setFallbackTier}
              disabled={!settings.enabled}
            >
              <SelectTrigger className="h-8 text-xs" aria-label={t("fallbackTier")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>{t("fallbackNone")}</SelectItem>
                {settings.candidateAliases.map((alias) => (
                  <SelectItem key={alias} value={alias}>
                    {alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("fallbackProvider")}</Label>
            <Select
              value={settings.fallbackProvider ?? NONE_VALUE}
              onValueChange={(v) =>
                patch({ fallbackProvider: v === NONE_VALUE ? undefined : (v as ProviderName) })
              }
              disabled={!settings.enabled}
            >
              <SelectTrigger className="h-8 text-xs" aria-label={t("fallbackProvider")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>{t("fallbackNone")}</SelectItem>
                {providerIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("fallbackHint")}</p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <Label htmlFor="auto-show-indicator" className="text-xs">
          {t("showIndicator")}
        </Label>
        <Switch
          id="auto-show-indicator"
          checked={settings.showRoutingIndicator}
          onCheckedChange={(checked) => patch({ showRoutingIndicator: checked === true })}
        />
      </div>

      {/* Rule 7: dormant legacy fields stay persisted but read by nothing —
          labeled inert rather than hidden so the label and the type docs agree. */}
      <div
        className="space-y-1.5 rounded-md border border-dashed px-3 py-2.5"
        data-testid="auto-routing-dormant"
      >
        <p className="text-xs font-medium text-muted-foreground">{t("dormantTitle")}</p>
        {(["routingMode", "allowOverride", "customTierModels"] as const).map((field) => (
          <div key={field} className="flex items-start justify-between gap-2">
            <div className="space-y-0.5">
              <p className="font-mono text-[11px]">{field}</p>
              <p className="text-[11px] text-muted-foreground">{t(`dormant.${field}`)}</p>
            </div>
            <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
              {t("dormantInactive")}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  )
}
