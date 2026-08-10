"use client"

/**
 * ProviderComparisonView — global side-by-side model comparison panel.
 *
 * Layout:
 *  1. Header: title + back button
 *  2. Model selector: popover with checkboxes grouped by provider (max 4)
 *  3. Comparison table: rows = attributes, columns = selected models
 *  4. Recommendation: best-value model based on average price
 *  5. Empty state: guidance text when no models selected
 */

import React, { useMemo, useState } from "react"
import { ArrowLeft, Check, X, ChevronDown, Layers } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useSettingsStore } from "@/stores"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { mergePricing } from "@cognia/provider-core/providers/model-discovery"
import type { ModelsDevCatalogModel } from "@cognia/provider-core/providers/models-dev"
import type { ModelPricing } from "@cognia/provider-types/provider"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"
import type {
  BuiltInProviderCatalogEntry,
  BuiltInProviderModelEntry,
} from "@cognia/provider-types/built-in-provider-catalog"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ProviderComparisonViewProps {
  onBack: () => void
}

interface ModelOption {
  modelId: string
  modelName: string
  providerId: string
  providerName: string
  entry: BuiltInProviderModelEntry
  catalogEntry: BuiltInProviderCatalogEntry
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function formatContext(tokens: number): string {
  if (tokens === 0) return "N/A"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function formatPrice(pricePerMillion: number): string {
  if (pricePerMillion === 0) return "Free"
  return `$${pricePerMillion.toFixed(2)} / 1M`
}

/** Numeric per-1M pricing fields (everything on ModelPricing except `currency`). */
type NumericPricingField = Exclude<keyof ModelPricing, "currency">

function formatLatency(ms: number | undefined): string {
  if (!ms) return "—"
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function estimateCostPer1K(entry: BuiltInProviderModelEntry): number | null {
  if (!entry.pricing) return null
  // Assume 1K calls with avg 500 input tokens + 200 output tokens each
  const inputCost = (500 / 1_000_000) * entry.pricing.promptPer1M
  const outputCost = (200 / 1_000_000) * entry.pricing.completionPer1M
  return (inputCost + outputCost) * 1000
}

function formatEstCost(entry: BuiltInProviderModelEntry): string {
  const cost = estimateCostPer1K(entry)
  if (cost === null) return "N/A"
  return `$${cost.toFixed(3)}`
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

/* ── CapabilityCell ──────────────────────────────────────────────────────── */

function CapabilityCell({ supported }: { supported: boolean }) {
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

/* ── Main component ──────────────────────────────────────────────────────── */

const MAX_MODELS = 4

export function ProviderComparisonView({ onBack }: ProviderComparisonViewProps) {
  const t = useTranslations("providers")

  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])
  const [popoverOpen, setPopoverOpen] = useState(false)

  const providerSettings = useSettingsStore((s) => s.providerSettings)
  const providerUsageStats = useSettingsStore((s) => s.providerUsageStats)
  const { row: modelsDevRow } = useModelsDevCatalog()

  /* Build the list of available model options from all enabled providers */
  const availableModels = useMemo<ModelOption[]>(() => {
    const catalog = getBuiltInProviderCatalog()
    const options: ModelOption[] = []

    for (const catalogEntry of catalog) {
      const pSettings = providerSettings[catalogEntry.id]
      const isEnabled = pSettings?.enabled ?? catalogEntry.defaultEnabled
      if (!isEnabled) continue
      if (!catalogEntry.models || catalogEntry.models.length === 0) continue

      const devModels = modelsDevRow?.providers[catalogEntry.id]?.models ?? []
      for (const model of catalogEntry.models) {
        const dev = devModels.find((d) => d.id === model.id)
        options.push({
          modelId: model.id,
          modelName: model.name,
          providerId: catalogEntry.id,
          providerName: catalogEntry.name,
          // Fill missing model-level fields from models.dev (authoritative).
          entry: enrichComparisonEntry(model, dev),
          catalogEntry,
        })
      }
    }
    return options
  }, [providerSettings, modelsDevRow])

  /* Group available models by provider for the popover */
  const modelsByProvider = useMemo(() => {
    const grouped: Record<string, ModelOption[]> = {}
    for (const option of availableModels) {
      if (!grouped[option.providerId]) {
        grouped[option.providerId] = []
      }
      grouped[option.providerId].push(option)
    }
    return grouped
  }, [availableModels])

  /* Resolve selected model details */
  const selectedModels = useMemo<ModelOption[]>(() => {
    return selectedModelIds
      .map((id) => availableModels.find((m) => m.modelId === id))
      .filter(Boolean) as ModelOption[]
  }, [selectedModelIds, availableModels])

  /* Recommendation: lowest average cost per 1M tokens */
  const bestValueModel = useMemo(() => {
    if (selectedModels.length === 0) return null
    const withPricing = selectedModels.filter((m) => m.entry.pricing)
    if (withPricing.length === 0) return null
    return withPricing.reduce((best, current) => {
      const bestAvg =
        ((best.entry.pricing?.promptPer1M ?? 0) + (best.entry.pricing?.completionPer1M ?? 0)) / 2
      const currentAvg =
        ((current.entry.pricing?.promptPer1M ?? 0) +
          (current.entry.pricing?.completionPer1M ?? 0)) /
        2
      return currentAvg < bestAvg ? current : best
    })
  }, [selectedModels])

  /* Toggle model selection */
  const toggleModel = (modelId: string) => {
    setSelectedModelIds((prev) => {
      if (prev.includes(modelId)) {
        return prev.filter((id) => id !== modelId)
      }
      if (prev.length >= MAX_MODELS) return prev
      return [...prev, modelId]
    })
  }

  /* Render one optional pricing-dimension row — skipped entirely when none of
   * the selected models declares a rate for it, so cache/batch/audio rows only
   * appear when there's something to compare. */
  const renderPriceRow = (field: NumericPricingField, label: string) => {
    const anyHas = selectedModels.some((m) => typeof m.entry.pricing?.[field] === "number")
    if (!anyHas) return null
    return (
      <ComparisonRow label={label}>
        {selectedModels.map((model) => {
          const v = model.entry.pricing?.[field]
          return (
            <TableCell key={model.modelId} className="px-3 py-2 text-center text-sm font-mono">
              {typeof v === "number" ? formatPrice(v) : "—"}
            </TableCell>
          )
        })}
      </ComparisonRow>
    )
  }

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 pl-1">
          <ArrowLeft className="h-4 w-4" />
          {t("comparison.back")}
        </Button>
        <div className="flex flex-1 items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{t("comparison.title")}</h2>
        </div>
        <span className="text-xs text-muted-foreground">{t("comparison.maxReached")}</span>
      </div>

      {/* ── Model selector ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={selectedModelIds.length >= MAX_MODELS}
              className="gap-1"
            >
              {t("comparison.addModel")}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <ScrollArea className="max-h-72">
              {Object.entries(modelsByProvider).map(([providerId, models]) => (
                <div key={providerId} className="mb-2">
                  <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {models[0]?.providerName ?? providerId}
                  </p>
                  {models.map((model) => {
                    const isChecked = selectedModelIds.includes(model.modelId)
                    const isDisabled = !isChecked && selectedModelIds.length >= MAX_MODELS
                    return (
                      <label
                        key={model.modelId}
                        htmlFor={`model-${model.modelId}`}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
                        style={isDisabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
                      >
                        <Checkbox
                          id={`model-${model.modelId}`}
                          checked={isChecked}
                          onCheckedChange={() => toggleModel(model.modelId)}
                        />
                        <span className="flex-1 truncate">{model.modelName}</span>
                        {model.entry.pricing && (
                          <span className="text-xs text-muted-foreground">
                            ${model.entry.pricing.promptPer1M.toFixed(2)}
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

        {/* Selected model chips */}
        {selectedModels.map((model) => (
          <Badge
            key={model.modelId}
            variant="secondary"
            className="flex items-center gap-1 pr-1 text-xs"
          >
            <span>{model.modelName}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-1 size-5 rounded-full"
              onClick={() => toggleModel(model.modelId)}
              aria-label={`Remove ${model.modelName}`}
            >
              <X className="h-2.5 w-2.5" />
            </Button>
          </Badge>
        ))}
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-auto px-4 py-4">
        {selectedModels.length === 0 ? (
          /* ── Empty state ──────────────────────────────────────────────────── */
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <Layers className="mx-auto h-12 w-12 text-muted-foreground/30" />
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
          <div className="border-y">
            <Table className="min-w-full text-sm">
              <TableHeader>
                <TableRow className="border-b bg-muted/40">
                  <TableHead className="w-36 py-2 pl-3 pr-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("comparison.selectModels")}
                  </TableHead>
                  {selectedModels.map((model) => (
                    <TableHead
                      key={model.modelId}
                      className="min-w-[140px] px-3 py-2 text-center text-sm font-semibold"
                    >
                      <div>{model.modelName}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {model.providerName}
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y">
                {/* Provider */}
                <ComparisonRow label={t("comparison.provider")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center text-sm">
                      {model.providerName}
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Context Window */}
                <ComparisonRow label={t("comparison.contextWindow")}>
                  {selectedModels.map((model) => (
                    <TableCell
                      key={model.modelId}
                      className="px-3 py-2 text-center text-sm font-mono"
                    >
                      {formatContext(model.entry.contextLength)}
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Max Output */}
                <ComparisonRow label={t("comparison.maxOutput")}>
                  {selectedModels.map((model) => (
                    <TableCell
                      key={model.modelId}
                      className="px-3 py-2 text-center text-sm font-mono"
                    >
                      {model.entry.maxOutputTokens
                        ? formatContext(model.entry.maxOutputTokens)
                        : "—"}
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Text Generation (always true for chat models) */}
                <ComparisonRow label={t("comparison.textGeneration")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={true} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Vision */}
                <ComparisonRow label={t("comparison.vision")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={model.entry.supportsVision} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Code Generation (proxy: supportsTools as commonly both go together) */}
                <ComparisonRow label={t("comparison.codeGeneration")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={model.entry.supportsTools} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Function Calling */}
                <ComparisonRow label={t("comparison.functionCalling")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={model.entry.supportsTools} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Streaming */}
                <ComparisonRow label={t("comparison.streaming")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={model.entry.supportsStreaming} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Reasoning */}
                <ComparisonRow label={t("comparison.reasoning")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={Boolean(model.entry.supportsReasoning)} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Audio */}
                <ComparisonRow label={t("comparison.audio")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={Boolean(model.entry.supportsAudio)} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Video */}
                <ComparisonRow label={t("comparison.video")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={Boolean(model.entry.supportsVideo)} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Image generation */}
                <ComparisonRow label={t("comparison.imageGeneration")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={Boolean(model.entry.supportsImageGeneration)} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Embedding */}
                <ComparisonRow label={t("comparison.embedding")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center">
                      <CapabilityCell supported={Boolean(model.entry.supportsEmbedding)} />
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Avg Latency — from usage stats if available */}
                <ComparisonRow label={t("comparison.avgLatency")}>
                  {selectedModels.map((model) => {
                    // cognia-next keys usage by `${providerId}:${modelId}`.
                    const modelStats = providerUsageStats?.[`${model.providerId}:${model.modelId}`]
                    const latency = (modelStats as { avgLatencyMs?: number }[] | undefined)?.[0]
                      ?.avgLatencyMs
                    return (
                      <TableCell key={model.modelId} className="px-3 py-2 text-center text-sm">
                        {formatLatency(latency)}
                      </TableCell>
                    )
                  })}
                </ComparisonRow>

                {/* Availability */}
                <ComparisonRow label={t("comparison.availability")}>
                  {selectedModels.map((model) => (
                    <TableCell key={model.modelId} className="px-3 py-2 text-center text-sm">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        {t("comparison.online")}
                      </span>
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Input Price */}
                <ComparisonRow label={t("comparison.inputPrice")}>
                  {selectedModels.map((model) => (
                    <TableCell
                      key={model.modelId}
                      className="px-3 py-2 text-center text-sm font-mono"
                    >
                      {model.entry.pricing
                        ? formatPrice(model.entry.pricing.promptPer1M)
                        : t("comparison.noPrice")}
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Output Price */}
                <ComparisonRow label={t("comparison.outputPrice")}>
                  {selectedModels.map((model) => (
                    <TableCell
                      key={model.modelId}
                      className="px-3 py-2 text-center text-sm font-mono"
                    >
                      {model.entry.pricing
                        ? formatPrice(model.entry.pricing.completionPer1M)
                        : t("comparison.noPrice")}
                    </TableCell>
                  ))}
                </ComparisonRow>

                {/* Extended pricing dimensions (cache / batch / audio) — each
                    row renders only when at least one selected model declares it. */}
                {renderPriceRow("cachedInputPer1M", t("comparison.cacheReadPrice"))}
                {renderPriceRow("cacheCreationPer1M", t("comparison.cacheWritePrice"))}
                {renderPriceRow("batchInputPer1M", t("comparison.batchInputPrice"))}
                {renderPriceRow("batchOutputPer1M", t("comparison.batchOutputPrice"))}
                {renderPriceRow("audioInputPer1M", t("comparison.audioInputPrice"))}
                {renderPriceRow("audioOutputPer1M", t("comparison.audioOutputPrice"))}

                {/* Est. Cost/1K calls */}
                <ComparisonRow label={t("comparison.estCostPer1K")}>
                  {selectedModels.map((model) => (
                    <TableCell
                      key={model.modelId}
                      className="px-3 py-2 text-center text-sm font-mono"
                    >
                      {formatEstCost(model.entry)}
                    </TableCell>
                  ))}
                </ComparisonRow>
              </TableBody>
            </Table>
          </div>
        )}

        {/* ── Recommendation ────────────────────────────────────────────────── */}
        {bestValueModel && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/30">
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              <span className="mr-1 text-emerald-500">
                <Check className="inline h-4 w-4" />
              </span>
              {t("comparison.bestValue")}:{" "}
              <span className="font-semibold">{bestValueModel.modelName}</span>
              {bestValueModel.entry.pricing && (
                <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                  {t("comparison.averagePricePerMillion", {
                    price: `$${(
                      (bestValueModel.entry.pricing.promptPer1M +
                        bestValueModel.entry.pricing.completionPer1M) /
                      2
                    ).toFixed(2)}`,
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

/* ── ComparisonRow helper ─────────────────────────────────────────────────── */

function ComparisonRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TableRow className="even:bg-muted/20">
      <TableCell className="py-2 pl-3 pr-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
        {label}
      </TableCell>
      {children}
    </TableRow>
  )
}
