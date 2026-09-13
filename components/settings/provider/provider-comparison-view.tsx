"use client"

/**
 * ProviderComparisonView — side-by-side model comparison, up to four models.
 *
 * The selection is owned by the caller (persisted as
 * `ProviderUIPreferences.comparisonModelKeys`), because it is fed from two
 * places: the compare column on every provider's Models tab, and the
 * "Add model" picker here. Local state would mean the two disagree.
 *
 * Layout:
 *  1. Header: back, title, `n / 4`
 *  2. Toolbar: add-model picker, "only differences" toggle
 *  3. Table: attributes × models, grouped in sections. First column and the
 *     header row stay pinned while the table scrolls either way. The best
 *     value in a numeric row is marked; rows where every model agrees can be
 *     hidden.
 *  4. Best-value banner (lowest average price among the selection)
 *  5. Empty state pointing at both ways to add a model
 */

import React, { useMemo, useState } from "react"
import { ArrowLeft, Check, X, ChevronDown, GitCompareArrows, Plus, Trophy } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { mergePricing } from "@cognia/provider-core/providers/model-discovery"
import type { ModelsDevCatalogModel } from "@cognia/provider-core/providers/models-dev"
import type { BuiltInProviderModelPricing } from "@cognia/provider-types/built-in-provider-catalog"
import type { ModelPricing } from "@cognia/provider-types/provider"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"
import type {
  BuiltInProviderCatalogEntry,
  BuiltInProviderModelEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  COMPARISON_MAX_MODELS,
  comparisonModelKey,
  formatTokenCount,
  formatUsdPerMillion,
} from "./model-format"

export { comparisonModelKey }

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ProviderComparisonViewProps {
  onBack: () => void
  /** `${providerId}:${modelId}` keys. Unknown keys are ignored, not dropped. */
  selectedModelKeys: readonly string[]
  onSelectedModelKeysChange: (keys: string[]) => void
}

interface ModelOption {
  /** `${providerId}:${modelId}` — see {@link comparisonModelKey}. */
  key: string
  modelId: string
  modelName: string
  providerId: string
  providerName: string
  providerEnabled: boolean
  entry: BuiltInProviderModelEntry
  catalogEntry: BuiltInProviderCatalogEntry
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Numeric per-1M pricing fields, keyed off the catalog's own pricing shape —
 * which is what `entry.pricing` actually is. Keying off `ModelPricing` stopped
 * working when that type gained ADR-0130's non-token billing units (per
 * request / container-hour / page / character), none of which the catalog
 * carries.
 */
type NumericPricingField = Exclude<keyof BuiltInProviderModelPricing, "currency">

function formatLatency(ms: number | undefined): string {
  if (!ms) return "—"
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

export function estimateCostPer1K(entry: BuiltInProviderModelEntry): number | null {
  if (!entry.pricing) return null
  // Assume 1K calls with avg 500 input tokens + 200 output tokens each
  const inputCost = (500 / 1_000_000) * entry.pricing.promptPer1M
  const outputCost = (200 / 1_000_000) * entry.pricing.completionPer1M
  return (inputCost + outputCost) * 1000
}

/**
 * Fill a static catalog model entry's missing model-level fields from the
 * models.dev catalog (authoritative). Static values that already exist are kept.
 */
function enrichComparisonEntry(
  entry: BuiltInProviderModelEntry,
  dev?: ModelsDevCatalogModel
): BuiltInProviderModelEntry {
  if (!dev) return entry
  return {
    ...entry,
    contextLength: entry.contextLength || dev.contextLength || 0,
    maxOutputTokens: entry.maxOutputTokens ?? dev.maxOutputTokens,
    supportsTools: entry.supportsTools || Boolean(dev.supportsTools),
    supportsVision: entry.supportsVision || Boolean(dev.supportsVision),
    supportsAudio: entry.supportsAudio || Boolean(dev.supportsAudio),
    supportsVideo: entry.supportsVideo || Boolean(dev.supportsVideo),
    supportsReasoning: entry.supportsReasoning || dev.supportsReasoning,
    supportsImageGeneration: entry.supportsImageGeneration || dev.supportsImageGeneration,
    supportsEmbedding: entry.supportsEmbedding || dev.supportsEmbedding,
    // Static catalog wins; models.dev fills missing pricing fields. Reuses the
    // canonical field-level merge so all pricing keys (cache/batch/audio/
    // currency) and the precedence stay consistent with model-discovery. The
    // catalog model types pricing as Partial<ModelPricing>, but mapCost only
    // emits it with both per-token rates present, so the widening is safe.
    pricing: mergePricing(entry.pricing, dev.pricing as ModelPricing | undefined, false),
  }
}

/* ── Row model ───────────────────────────────────────────────────────────── */

type SectionId = "limits" | "capabilities" | "pricing" | "performance"

/**
 * One attribute row. `best` says which direction wins for a numeric row so
 * the winner can be marked; `optional` rows render only when at least one
 * selected model has a value (the cache / batch / audio price tiers).
 */
interface RowDef {
  id: string
  section: SectionId
  labelKey: string
  kind: "number" | "boolean" | "text"
  best?: "high" | "low"
  optional?: boolean
  value: (model: ModelOption, ctx: RowContext) => number | boolean | string | null
  format: (value: number | boolean | string | null) => React.ReactNode
}

interface RowContext {
  latencyFor: (model: ModelOption) => number | undefined
  formatPrice: (n: number) => string
  notAvailable: string
}

const SECTION_ORDER: SectionId[] = ["limits", "capabilities", "pricing", "performance"]

/** Stands in for a missing value when deciding whether a row differs. */
const NULL_SENTINEL = "\u0000missing"

/** A row's values across the selection, plus what to highlight. */
export interface ComparedRow {
  def: RowDef
  values: Array<number | boolean | string | null>
  /** Not every model agrees. */
  differs: boolean
  /** Column index of the winning value for a numeric row, if any. */
  bestIndex: number | null
}

/**
 * Pure: derive the rendered rows for a selection. Exported so the "only
 * differences" and "best in row" semantics are pinned without a DOM.
 */
export function compareRows(
  defs: readonly RowDef[],
  models: readonly ModelOption[],
  ctx: RowContext
): ComparedRow[] {
  const rows: ComparedRow[] = []
  for (const def of defs) {
    const values = models.map((m) => def.value(m, ctx))
    if (def.optional && values.every((v) => v === null)) continue
    const distinct = new Set(values.map((v) => (v === null ? NULL_SENTINEL : String(v))))
    let bestIndex: number | null = null
    if (def.kind === "number" && def.best) {
      let bestValue: number | null = null
      values.forEach((v, i) => {
        if (typeof v !== "number") return
        if (bestValue === null || (def.best === "high" ? v > bestValue : v < bestValue)) {
          bestValue = v
          bestIndex = i
        }
      })
      // A tie is not a winner.
      if (bestIndex !== null && values.filter((v) => v === bestValue).length > 1) bestIndex = null
    }
    rows.push({ def, values, differs: distinct.size > 1, bestIndex })
  }
  return rows
}

function CapabilityMark({ supported }: { supported: boolean }) {
  const t = useTranslations("providers")
  return supported ? (
    <Check
      className="mx-auto h-4 w-4 text-emerald-500"
      aria-label={t("comparison.supported")}
      data-testid="capability-yes"
    />
  ) : (
    <X
      className="mx-auto h-4 w-4 text-rose-400"
      aria-label={t("comparison.unsupported")}
      data-testid="capability-no"
    />
  )
}

function buildRowDefs(ctx: RowContext): RowDef[] {
  const tokens = (v: number | boolean | string | null) =>
    typeof v === "number" && v > 0 ? formatTokenCount(v) : "—"
  const price = (v: number | boolean | string | null) =>
    typeof v === "number" ? ctx.formatPrice(v) : "—"
  const priceRow = (
    id: string,
    labelKey: string,
    field: NumericPricingField,
    optional: boolean
  ): RowDef => ({
    id,
    section: "pricing",
    labelKey,
    kind: "number",
    best: "low",
    optional,
    value: (m) => {
      const v = m.entry.pricing?.[field]
      return typeof v === "number" ? v : null
    },
    format: price,
  })
  const capRow = (
    id: string,
    labelKey: string,
    pick: (e: BuiltInProviderModelEntry) => boolean | undefined
  ): RowDef => ({
    id,
    section: "capabilities",
    labelKey,
    kind: "boolean",
    value: (m) => Boolean(pick(m.entry)),
    format: (v) => <CapabilityMark supported={Boolean(v)} />,
  })

  return [
    {
      id: "context",
      section: "limits",
      labelKey: "comparison.contextWindow",
      kind: "number",
      best: "high",
      value: (m) => (m.entry.contextLength > 0 ? m.entry.contextLength : null),
      format: tokens,
    },
    {
      id: "maxOutput",
      section: "limits",
      labelKey: "comparison.maxOutput",
      kind: "number",
      best: "high",
      value: (m) => m.entry.maxOutputTokens ?? null,
      format: tokens,
    },
    capRow("textGeneration", "comparison.textGeneration", () => true),
    capRow("vision", "comparison.vision", (e) => e.supportsVision),
    capRow("functionCalling", "comparison.functionCalling", (e) => e.supportsTools),
    capRow("streaming", "comparison.streaming", (e) => e.supportsStreaming),
    capRow("reasoning", "comparison.reasoning", (e) => e.supportsReasoning),
    capRow("audio", "comparison.audio", (e) => e.supportsAudio),
    capRow("video", "comparison.video", (e) => e.supportsVideo),
    capRow("imageGeneration", "comparison.imageGeneration", (e) => e.supportsImageGeneration),
    capRow("embedding", "comparison.embedding", (e) => e.supportsEmbedding),
    priceRow("inputPrice", "comparison.inputPrice", "promptPer1M", false),
    priceRow("outputPrice", "comparison.outputPrice", "completionPer1M", false),
    priceRow("cacheRead", "comparison.cacheReadPrice", "cachedInputPer1M", true),
    priceRow("cacheWrite", "comparison.cacheWritePrice", "cacheCreationPer1M", true),
    priceRow("batchInput", "comparison.batchInputPrice", "batchInputPer1M", true),
    priceRow("batchOutput", "comparison.batchOutputPrice", "batchOutputPer1M", true),
    priceRow("audioInput", "comparison.audioInputPrice", "audioInputPer1M", true),
    priceRow("audioOutput", "comparison.audioOutputPrice", "audioOutputPer1M", true),
    {
      id: "estCost",
      section: "pricing",
      labelKey: "comparison.estCostPer1K",
      kind: "number",
      best: "low",
      value: (m) => estimateCostPer1K(m.entry),
      format: (v) => (typeof v === "number" ? `$${v.toFixed(3)}` : ctx.notAvailable),
    },
    {
      id: "latency",
      section: "performance",
      labelKey: "comparison.avgLatency",
      kind: "number",
      best: "low",
      value: (m) => ctx.latencyFor(m) ?? null,
      format: (v) => formatLatency(typeof v === "number" ? v : undefined),
    },
  ]
}

/* ── Main component ──────────────────────────────────────────────────────── */

export function ProviderComparisonView({
  onBack,
  selectedModelKeys,
  onSelectedModelKeysChange,
}: ProviderComparisonViewProps) {
  const t = useTranslations("providers")
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [onlyDifferences, setOnlyDifferences] = useState(false)

  const providerSettings = useSettingsStore((s) => s.providerSettings)
  const providerUsageStats = useSettingsStore((s) => s.providerUsageStats)
  const { row: modelsDevRow } = useModelsDevCatalog()

  /* Money / "not available" formatting lives here so the strings are i18n'd. */
  const formatPrice = (pricePerMillion: number): string =>
    pricePerMillion === 0
      ? t("comparison.free")
      : t("comparison.pricePerMillion", { price: formatUsdPerMillion(pricePerMillion) })

  /* Every catalog model is selectable. The Models tab can tick a model on a
     provider that is not enabled yet, and a key that resolves to nothing
     would read as the selection silently losing a row. Enabled providers
     lead the picker instead. */
  const availableModels = useMemo<ModelOption[]>(() => {
    const catalog = getBuiltInProviderCatalog()
    const options: ModelOption[] = []
    for (const catalogEntry of catalog) {
      if (!catalogEntry.models || catalogEntry.models.length === 0) continue
      const pSettings = providerSettings[catalogEntry.id]
      const providerEnabled = pSettings?.enabled ?? catalogEntry.defaultEnabled
      const devModels = modelsDevRow?.providers[catalogEntry.id]?.models ?? []
      for (const model of catalogEntry.models) {
        const dev = devModels.find((d) => d.id === model.id)
        options.push({
          key: comparisonModelKey(catalogEntry.id, model.id),
          modelId: model.id,
          modelName: model.name,
          providerId: catalogEntry.id,
          providerName: catalogEntry.name,
          providerEnabled,
          entry: enrichComparisonEntry(model, dev),
          catalogEntry,
        })
      }
    }
    return options
  }, [providerSettings, modelsDevRow])

  /* Group for the picker: enabled providers first, catalog order within. */
  const pickerGroups = useMemo(() => {
    const grouped = new Map<string, ModelOption[]>()
    for (const option of availableModels) {
      const list = grouped.get(option.providerId) ?? []
      list.push(option)
      grouped.set(option.providerId, list)
    }
    return [...grouped.values()].sort(
      (a, b) => Number(b[0].providerEnabled) - Number(a[0].providerEnabled)
    )
  }, [availableModels])

  const selectedModels = useMemo<ModelOption[]>(() => {
    const byKey = new Map(availableModels.map((m) => [m.key, m]))
    return selectedModelKeys
      .map((key) => byKey.get(key))
      .filter((m): m is ModelOption => m !== undefined)
      .slice(0, COMPARISON_MAX_MODELS)
  }, [selectedModelKeys, availableModels])

  const selectedSet = useMemo(() => new Set(selectedModelKeys), [selectedModelKeys])
  const atMax = selectedModelKeys.length >= COMPARISON_MAX_MODELS

  const toggleModel = (key: string) => {
    if (selectedSet.has(key)) {
      onSelectedModelKeysChange(selectedModelKeys.filter((k) => k !== key))
    } else if (!atMax) {
      onSelectedModelKeysChange([...selectedModelKeys, key])
    }
  }

  /* Recommendation: lowest average cost per 1M tokens */
  const bestValueModel = useMemo(() => {
    const withPricing = selectedModels.filter((m) => m.entry.pricing)
    if (withPricing.length === 0) return null
    return withPricing.reduce((best, current) => {
      const avg = (m: ModelOption) =>
        ((m.entry.pricing?.promptPer1M ?? 0) + (m.entry.pricing?.completionPer1M ?? 0)) / 2
      return avg(current) < avg(best) ? current : best
    })
  }, [selectedModels])

  const ctx: RowContext = {
    latencyFor: (model) => {
      // cognia-next keys usage by `${providerId}:${modelId}`.
      const modelStats = providerUsageStats?.[`${model.providerId}:${model.modelId}`]
      return (modelStats as { avgLatencyMs?: number }[] | undefined)?.[0]?.avgLatencyMs
    },
    formatPrice,
    notAvailable: t("comparison.notAvailable"),
  }
  const rows = compareRows(buildRowDefs(ctx), selectedModels, ctx)
  const visibleRows = onlyDifferences ? rows.filter((r) => r.differs) : rows
  const differingCount = rows.filter((r) => r.differs).length

  /* ── Render ─────────────────────────────────────────────────────────────── */

  const addModelPicker = (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={atMax}
          className="h-8 gap-1"
          title={atMax ? t("comparison.maxReached") : undefined}
          data-testid="comparison-add-model"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("comparison.addModel")}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <ScrollArea className="max-h-80">
          {pickerGroups.map((models) => (
            <div key={models[0].providerId} className="mb-2">
              <p className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <ProviderIcon
                  providerId={models[0].providerId}
                  label={models[0].providerName}
                  size={14}
                />
                <span className="truncate">{models[0].providerName}</span>
                {!models[0].providerEnabled && (
                  <span className="ml-auto font-normal normal-case tracking-normal">
                    {t("comparison.providerDisabled")}
                  </span>
                )}
              </p>
              {models.map((model) => {
                const isChecked = selectedSet.has(model.key)
                const isDisabled = !isChecked && atMax
                return (
                  <label
                    key={model.key}
                    htmlFor={`compare-model-${model.key}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted",
                      isDisabled && "pointer-events-none opacity-50"
                    )}
                  >
                    <Checkbox
                      id={`compare-model-${model.key}`}
                      checked={isChecked}
                      disabled={isDisabled}
                      onCheckedChange={() => toggleModel(model.key)}
                    />
                    <span className="flex-1 truncate">{model.modelName}</span>
                    {model.entry.pricing && (
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatUsdPerMillion(model.entry.pricing.promptPer1M)}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="provider-comparison-view">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 gap-1 pl-1">
          <ArrowLeft className="h-4 w-4" />
          {t("comparison.back")}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitCompareArrows className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="truncate text-base font-semibold">{t("comparison.title")}</h2>
        </div>
        <Badge variant="outline" className="tabular-nums" data-testid="comparison-count">
          {t("comparison.selectedCount", {
            count: selectedModelKeys.length,
            max: COMPARISON_MAX_MODELS,
          })}
        </Badge>
      </div>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        {addModelPicker}
        <Button
          type="button"
          size="sm"
          variant={onlyDifferences ? "secondary" : "ghost"}
          aria-pressed={onlyDifferences}
          className="h-8 text-xs"
          disabled={selectedModels.length < 2}
          onClick={() => setOnlyDifferences((v) => !v)}
          data-testid="comparison-only-differences"
        >
          {t("comparison.onlyDifferences")}
          {selectedModels.length >= 2 && (
            <span className="ml-1 tabular-nums text-muted-foreground">({differingCount})</span>
          )}
        </Button>
        {selectedModels.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-8 text-xs text-muted-foreground"
            onClick={() => onSelectedModelKeysChange([])}
            data-testid="comparison-clear"
          >
            {t("comparison.clearAll")}
          </Button>
        )}
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {selectedModels.length === 0 ? (
          /* ── Empty state ──────────────────────────────────────────────────── */
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <GitCompareArrows className="mx-auto h-10 w-10 text-muted-foreground/30" />
              <h3 className="mt-4 text-base font-semibold text-foreground">
                {t("comparison.emptyTitle")}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("comparison.emptyDescription")}
              </p>
            </div>
          </div>
        ) : (
          /* ── Comparison table ─────────────────────────────────────────────── */
          <table
            className="w-max min-w-full border-separate border-spacing-0 text-sm"
            data-testid="comparison-table"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 border-b border-r bg-background px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                >
                  {t("comparison.attribute")}
                </th>
                {selectedModels.map((model) => (
                  <th
                    key={model.key}
                    scope="col"
                    className="sticky top-0 z-20 min-w-[11rem] border-b bg-background px-3 py-2 text-center align-top"
                    data-testid={`comparison-column-${model.key}`}
                  >
                    <div className="flex items-start justify-center gap-2">
                      <ProviderIcon
                        providerId={model.providerId}
                        label={model.providerName}
                        size={20}
                      />
                      <div className="min-w-0 text-left">
                        <div className="truncate text-sm font-semibold">{model.modelName}</div>
                        <div className="truncate text-xs font-normal text-muted-foreground">
                          {model.providerName}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-6 shrink-0 rounded-full text-muted-foreground"
                        onClick={() => toggleModel(model.key)}
                        aria-label={t("comparison.removeModel", { name: model.modelName })}
                        data-testid={`comparison-remove-${model.key}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SECTION_ORDER.map((section) => {
                const sectionRows = visibleRows.filter((r) => r.def.section === section)
                if (sectionRows.length === 0) return null
                return (
                  <React.Fragment key={section}>
                    <tr data-testid={`comparison-section-${section}`}>
                      <th
                        scope="rowgroup"
                        colSpan={selectedModels.length + 1}
                        className="sticky left-0 z-10 border-b bg-muted/50 px-3 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {t(`comparison.section.${section}`)}
                      </th>
                    </tr>
                    {sectionRows.map((row) => (
                      <tr
                        key={row.def.id}
                        data-testid={`comparison-row-${row.def.id}`}
                        data-differs={row.differs || undefined}
                        className={cn(
                          "group",
                          row.differs && selectedModels.length > 1 && "bg-primary/[0.03]"
                        )}
                      >
                        <th
                          scope="row"
                          className="sticky left-0 z-10 whitespace-nowrap border-b border-r bg-background px-3 py-1.5 text-left text-xs font-medium text-muted-foreground group-hover:bg-muted/40"
                        >
                          {t(row.def.labelKey)}
                        </th>
                        {row.values.map((value, index) => {
                          const isBest = row.bestIndex === index
                          return (
                            <td
                              key={selectedModels[index].key}
                              data-best={isBest || undefined}
                              className={cn(
                                "border-b px-3 py-1.5 text-center group-hover:bg-muted/40",
                                row.def.kind === "number" && "font-mono text-sm tabular-nums",
                                isBest && "font-semibold text-emerald-600 dark:text-emerald-400"
                              )}
                            >
                              <span className="inline-flex items-center gap-1">
                                {row.def.format(value)}
                                {isBest && (
                                  <Trophy
                                    className="h-3 w-3"
                                    aria-label={t("comparison.bestInRow")}
                                  />
                                )}
                              </span>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td
                    colSpan={selectedModels.length + 1}
                    className="px-3 py-8 text-center text-sm text-muted-foreground"
                    data-testid="comparison-no-differences"
                  >
                    {t("comparison.noDifferences")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* ── Recommendation ────────────────────────────────────────────────── */}
        {bestValueModel && (
          <div className="m-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/30">
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              <span className="mr-1 text-emerald-500">
                <Check className="inline h-4 w-4" />
              </span>
              {/* The message carries the model name itself ("Best value: {model}"). */}
              <span className="font-semibold" data-testid="comparison-best-value">
                {t("comparison.bestValue", { model: bestValueModel.modelName })}
              </span>
              {bestValueModel.entry.pricing && (
                <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                  {t("comparison.averagePricePerMillion", {
                    price: formatUsdPerMillion(
                      (bestValueModel.entry.pricing.promptPer1M +
                        bestValueModel.entry.pricing.completionPer1M) /
                        2
                    ),
                  })}
                </span>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
