"use client"

import React, { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Search,
  RefreshCw,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  PlugZap,
  CheckCheck,
  Ban,
  GitCompareArrows,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ModelCapabilityIcons, useCapabilityLabel } from "./model-capability-icons"
import {
  COMPARISON_MAX_MODELS,
  comparisonModelKey,
  formatTokenCount,
  formatUsdPerMillion,
} from "./model-format"
import type { ProviderDiagnosticBadgeStatus } from "./provider-sidebar-item"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ModelConfig {
  id: string
  name: string
  capabilities?: string[]
  contextLength?: number
  /** Max output tokens (from models.dev `limit.output`). */
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  /** Whether the model's weights are open (from models.dev `open_weights`). */
  openWeights?: boolean
  /** Number of experimental reasoning modes (from models.dev `experimental.modes`). */
  modeCount?: number
  /** Reasoning effort tiers (from models.dev). */
  variants?: string[]
  /** Model family (from models.dev), e.g. "claude-sonnet". */
  family?: string
  /** ISO release date (from models.dev). */
  releaseDate?: string
  /** Driver/adapter hint (from models.dev npm). */
  adapter?: string
  /** Lifecycle status from models.dev (e.g. "deprecated", "beta"). */
  status?: string
  /** Knowledge cutoff from models.dev (ISO date or "YYYY-MM"). */
  knowledge?: string
  /** Last-updated date from models.dev. */
  lastUpdated?: string
  /** USD per million tokens, when the catalog or models.dev knows it. */
  pricing?: { promptPer1M: number; completionPer1M: number }
}

/** Sortable columns. `null` keeps catalog order. */
export type ModelSortKey = "name" | "context" | "maxOutput" | "price" | "release"
export type ModelSortDirection = "asc" | "desc"
export interface ModelSort {
  key: ModelSortKey
  direction: ModelSortDirection
}

/**
 * The cross-provider comparison selection, owned by the settings pane so it
 * survives switching providers and reopening the compare workspace.
 *
 * Keys are `${providerId}:${modelId}` (see {@link comparisonModelKey}); the
 * tab only ever adds or removes its own provider's rows.
 */
export interface ModelCompareSelection {
  keys: readonly string[]
  onToggle: (key: string) => void
  onOpen: () => void
  onClear: () => void
}

/**
 * Map a models.dev lifecycle `status` to a badge variant, or `null` when the
 * status is a normal "stable/available" value that needs no badge. Keeping the
 * normal states unbadged avoids cluttering the common case while still flagging
 * deprecated / preview models a user should think twice about.
 */
function statusBadgeVariant(status: string | undefined): "destructive" | "outline" | null {
  if (!status) return null
  const s = status.toLowerCase()
  if (["stable", "available", "ga", "active", "released"].includes(s)) return null
  if (["deprecated", "retired", "legacy", "sunset"].includes(s)) return "destructive"
  return "outline"
}

const LIFECYCLE_LABEL_KEYS: Record<string, string> = {
  beta: "modelsTab.lifecycle.beta",
  preview: "modelsTab.lifecycle.preview",
  experimental: "modelsTab.lifecycle.experimental",
  deprecated: "modelsTab.lifecycle.deprecated",
  retired: "modelsTab.lifecycle.retired",
  legacy: "modelsTab.lifecycle.legacy",
  sunset: "modelsTab.lifecycle.sunset",
}

export interface ProviderModelsTabProps {
  providerId: string
  models: ModelConfig[]
  enabledModels: string[]
  onEnabledModelsChange: (modelIds: string[]) => void
  /**
   * Re-fetch the provider's model list. This used to be `onTestConnection`,
   * which is a different operation entirely — the button said "Refresh models"
   * and ran a connection test, changing no models for any provider but Bedrock.
   */
  onRefreshModels: () => void
  isRefreshing?: boolean
  /**
   * Verify credentials/reachability. Separate from `onRefreshModels` on
   * purpose: one button used to do both jobs under the refresh label and
   * actually performed only this one.
   */
  onTestConnection?: () => void
  isTesting?: boolean
  /**
   * True while the models.dev metadata read is still in flight. Model rows then
   * reserve space for the capability glyphs instead of growing them in later.
   */
  metadataLoading?: boolean
  diagnosticStatusByModel?: Record<string, ProviderDiagnosticBadgeStatus>
  /** Omit to hide the compare column (a caller without a compare workspace). */
  compare?: ModelCompareSelection
}

/* ── Sorting ─────────────────────────────────────────────────────────────── */

/** Average of the two per-1M rates; `null` when the model has no pricing. */
function averagePrice(model: ModelConfig): number | null {
  if (!model.pricing) return null
  return (model.pricing.promptPer1M + model.pricing.completionPer1M) / 2
}

/**
 * Pure so the header-click semantics can be pinned: models with no value for
 * the sort key always sink to the bottom regardless of direction, otherwise
 * "sort by price, descending" would open with the priceless models on top.
 */
export function sortModels(models: readonly ModelConfig[], sort: ModelSort | null): ModelConfig[] {
  const result = [...models]
  if (!sort) return result
  const sign = sort.direction === "asc" ? 1 : -1
  const numeric =
    (pick: (m: ModelConfig) => number | null | undefined) => (a: ModelConfig, b: ModelConfig) => {
      const av = pick(a)
      const bv = pick(b)
      const aMissing = av === null || av === undefined
      const bMissing = bv === null || bv === undefined
      if (aMissing && bMissing) return 0
      if (aMissing) return 1
      if (bMissing) return -1
      return sign * (av - bv)
    }
  switch (sort.key) {
    case "name":
      return result.sort((a, b) => sign * a.name.localeCompare(b.name))
    case "context":
      return result.sort(numeric((m) => m.contextLength))
    case "maxOutput":
      return result.sort(numeric((m) => m.maxOutputTokens))
    case "price":
      return result.sort(numeric(averagePrice))
    case "release":
      return result.sort((a, b) => {
        const av = a.releaseDate ?? ""
        const bv = b.releaseDate ?? ""
        if (!av && !bv) return 0
        if (!av) return 1
        if (!bv) return -1
        return sign * av.localeCompare(bv)
      })
  }
}

/** Header click: none → asc → desc → none, per column. */
export function nextSort(current: ModelSort | null, key: ModelSortKey): ModelSort | null {
  if (!current || current.key !== key) return { key, direction: "asc" }
  if (current.direction === "asc") return { key, direction: "desc" }
  return null
}

/* ── Header cell ─────────────────────────────────────────────────────────── */

function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  className,
}: {
  label: string
  sortKey: ModelSortKey
  sort: ModelSort | null
  onSort: (key: ModelSortKey) => void
  align?: "left" | "right"
  className?: string
}) {
  const t = useTranslations("providers")
  const active = sort?.key === sortKey
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-2 py-1.5 font-medium", align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        data-testid={`models-sort-${sortKey}`}
        title={t("modelsTab.sortColumn", { label })}
        className={cn(
          "inline-flex h-6 max-w-full items-center gap-1 rounded-sm px-1 text-xs hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span className="truncate">{label}</span>
        <Icon className={cn("size-3 shrink-0", !active && "opacity-50")} />
      </button>
    </th>
  )
}

/* ── Row ─────────────────────────────────────────────────────────────────── */

interface ModelRowProps {
  model: ModelConfig
  isEnabled: boolean
  onToggle: (id: string, enabled: boolean) => void
  metadataLoading: boolean
  diagnosticStatus?: ProviderDiagnosticBadgeStatus
  compare?: {
    checked: boolean
    disabled: boolean
    onToggle: () => void
  }
}

const ModelRow = React.memo(function ModelRow({
  model,
  isEnabled,
  onToggle,
  metadataLoading,
  diagnosticStatus,
  compare,
}: ModelRowProps) {
  const t = useTranslations("providers")
  const caps = model.capabilities ?? []
  const statusVariant = statusBadgeVariant(model.status)
  // The models.dev catalog is a separate Dexie read that lands after the static
  // provider catalog. Without a placeholder the row first paints bare and then
  // grows a glyph row. Reserve the space while the read is in flight.
  const showCapsPlaceholder = metadataLoading && caps.length === 0
  const lifecycleKey = model.status ? LIFECYCLE_LABEL_KEYS[model.status.toLowerCase()] : undefined

  return (
    <tr
      data-enabled={isEnabled || undefined}
      data-testid={`model-row-${model.id}`}
      className={cn(
        "border-b transition-colors last:border-b-0 hover:bg-muted/40",
        !isEnabled && "text-muted-foreground",
        compare?.checked && "bg-primary/[0.04]"
      )}
    >
      {compare && (
        <td className="w-8 px-2 py-1.5 align-middle">
          <Checkbox
            checked={compare.checked}
            disabled={compare.disabled}
            onCheckedChange={compare.onToggle}
            aria-label={t("modelsTab.compareCheckbox", { name: model.name })}
            title={
              compare.disabled
                ? t("modelsTab.compareLimit", { max: COMPARISON_MAX_MODELS })
                : undefined
            }
            data-testid={`model-compare-${model.id}`}
          />
        </td>
      )}
      {/* `w-full max-w-0`: the model column absorbs whatever width the fixed
          columns leave and truncates inside it. Without the max-width a table
          cell grows to its content, so a long model id pushed the switch
          column past the pane edge on a phone. */}
      <td className="w-full max-w-0 px-2 py-1.5 align-middle">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium leading-tight",
              isEnabled ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {model.name}
          </span>
          {statusVariant && model.status && (
            <Badge variant={statusVariant} className="px-1.5 py-0 text-[10px] capitalize">
              {lifecycleKey ? t(lifecycleKey) : model.status}
            </Badge>
          )}
          {model.openWeights && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {t("modelsTab.openWeights")}
            </Badge>
          )}
          {diagnosticStatus && (
            <Badge
              variant="outline"
              data-testid={`model-diagnostic-${model.id}`}
              data-diagnostic-status={diagnosticStatus}
              className={cn(
                "px-1.5 py-0 text-[10px]",
                diagnosticStatus === "passed" && "border-emerald-500/30 text-emerald-600",
                diagnosticStatus === "failed" && "border-destructive/30 text-destructive",
                diagnosticStatus === "stale" && "text-muted-foreground"
              )}
            >
              {t(
                `sidebar.diagnostic${diagnosticStatus[0].toUpperCase()}${diagnosticStatus.slice(1)}`
              )}
            </Badge>
          )}
        </div>
        {/* The model *id* is what the user types into routing, aliases and
            the CLI. */}
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{model.id}</span>
          {model.family && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{model.family}</span>
            </>
          )}
          {model.variants && model.variants.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate" data-testid={`model-variants-${model.id}`}>
                {model.variants.join(" / ")}
              </span>
            </>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 align-middle">
        {showCapsPlaceholder ? (
          <div className="flex gap-1" data-testid="model-caps-placeholder" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="size-5 rounded-sm" />
            ))}
          </div>
        ) : (
          <ModelCapabilityIcons capabilities={caps} />
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right align-middle font-mono text-xs tabular-nums">
        {model.contextLength !== undefined ? formatTokenCount(model.contextLength) : "—"}
      </td>
      <td className="hidden whitespace-nowrap px-2 py-1.5 text-right align-middle font-mono text-xs tabular-nums @xl/provider-pane:table-cell">
        {model.maxOutputTokens !== undefined && model.maxOutputTokens > 0
          ? formatTokenCount(model.maxOutputTokens)
          : "—"}
      </td>
      <td
        className="hidden whitespace-nowrap px-2 py-1.5 text-right align-middle font-mono text-xs tabular-nums @2xl/provider-pane:table-cell"
        data-testid={`model-price-${model.id}`}
      >
        {model.pricing ? (
          <span title={t("modelsTab.pricePerMillionHint")}>
            {formatUsdPerMillion(model.pricing.promptPer1M)}
            <span className="text-muted-foreground"> / </span>
            {formatUsdPerMillion(model.pricing.completionPer1M)}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="hidden whitespace-nowrap px-2 py-1.5 text-right align-middle text-xs text-muted-foreground tabular-nums @3xl/provider-pane:table-cell">
        {model.releaseDate ?? "—"}
        {model.knowledge && (
          <span className="block text-[10px]" title={t("modelsTab.knowledgeCutoff")}>
            {t("modelsTab.knowledgeCutoff")} {model.knowledge}
          </span>
        )}
      </td>
      <td className="w-12 px-2 py-1.5 text-right align-middle">
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) => onToggle(model.id, checked)}
          aria-label={model.id}
          className="shrink-0"
        />
      </td>
    </tr>
  )
})

/* ── ProviderModelsTab ───────────────────────────────────────────────────── */

export function ProviderModelsTab({
  providerId,
  models,
  enabledModels,
  onEnabledModelsChange,
  onRefreshModels,
  isRefreshing = false,
  onTestConnection,
  isTesting = false,
  metadataLoading = false,
  diagnosticStatusByModel = {},
  compare,
}: ProviderModelsTabProps) {
  const t = useTranslations("providers")
  const [search, setSearch] = useState("")
  const [capFilters, setCapFilters] = useState<string[]>([])
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [sort, setSort] = useState<ModelSort | null>(null)
  const allModelsEnabled = enabledModels.length === 0

  /* Capabilities present across the provider's models — drives the chip row. */
  const availableCaps = useMemo(() => {
    const set = new Set<string>()
    for (const m of models) for (const c of m.capabilities ?? []) set.add(c)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [models])

  const hasActiveFilters = search.trim() !== "" || capFilters.length > 0 || enabledOnly

  /* Filtered + sorted model list */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const enabledSet = new Set(enabledModels)
    const result = models.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) return false
      // Capability filter is AND: a model must expose every selected capability.
      if (capFilters.length > 0) {
        const caps = new Set(m.capabilities ?? [])
        if (!capFilters.every((c) => caps.has(c))) return false
      }
      if (enabledOnly && !allModelsEnabled && !enabledSet.has(m.id)) return false
      return true
    })
    return sortModels(result, sort)
  }, [models, search, capFilters, enabledOnly, sort, enabledModels, allModelsEnabled])

  const enabledTotal = useMemo(
    () =>
      allModelsEnabled ? models.length : models.filter((m) => enabledModels.includes(m.id)).length,
    [allModelsEnabled, models, enabledModels]
  )

  /* Toggle a single model */
  const handleToggle = (modelId: string, enabled: boolean) => {
    if (allModelsEnabled) {
      if (!enabled)
        onEnabledModelsChange(models.map((model) => model.id).filter((id) => id !== modelId))
      return
    }
    if (enabled) {
      onEnabledModelsChange([...new Set([...enabledModels, modelId])])
    } else {
      const next = enabledModels.filter((id) => id !== modelId)
      // Same contract guard as `handleDeselectAll`: empty means "all enabled",
      // so turning the LAST switch off would flip every model back on. Keep the
      // one being switched off as the explicit list instead.
      onEnabledModelsChange(next.length > 0 ? next : [modelId])
    }
  }

  const toggleCap = (cap: string) => {
    setCapFilters((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]))
  }

  const clearFilters = () => {
    setSearch("")
    setCapFilters([])
    setEnabledOnly(false)
  }

  /* Batch operations on visible models */
  const filteredIds = filtered.map((m) => m.id)

  const handleSelectAll = () => {
    if (allModelsEnabled || filteredIds.length === models.length) {
      onEnabledModelsChange([])
      return
    }
    // Keep existing enabled models outside the filtered set, add all filtered ones
    const outside = enabledModels.filter((id) => !filteredIds.includes(id))
    onEnabledModelsChange([...outside, ...filteredIds])
  }

  const handleDeselectAll = () => {
    const current = allModelsEnabled ? models.map((model) => model.id) : enabledModels
    const next = current.filter((id) => !filteredIds.includes(id))
    // Empty means "all enabled" by contract, so keep one explicit model when
    // a full-list batch disable would otherwise silently turn everything on.
    onEnabledModelsChange(next.length > 0 ? next : current.slice(0, 1))
  }

  const compareCount = compare?.keys.length ?? 0
  const compareFull = compareCount >= COMPARISON_MAX_MODELS
  const compareSet = useMemo(() => new Set(compare?.keys ?? []), [compare?.keys])
  const capLabel = useCapabilityLabel()

  return (
    /* Three bands: a pinned toolbar, the scrolling table, and (while a
       comparison selection exists) a pinned action bar. The tab used to be
       one long scrolling document inside the detail panel's pane-wide
       `ScrollArea`, so scrolling to a model 40 rows down took the search box
       and the filters off-screen with it. */
    <div className="flex min-h-0 flex-1 flex-col" data-testid="models-tab">
      {/* ── Pinned toolbar ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative min-w-[9rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("modelsTab.searchPlaceholder")}
              className="h-8 pl-8"
            />
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onRefreshModels}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              <span className="truncate">{t("modelsTab.refreshModels")}</span>
            </Button>
            {onTestConnection && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onTestConnection}
                disabled={isTesting}
                data-testid="models-tab-test-connection"
              >
                {isTesting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlugZap className="mr-1.5 h-3.5 w-3.5" />
                )}
                <span className="truncate">{t("testConnection")}</span>
              </Button>
            )}
          </div>
        </div>

        {models.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {/* Capability chips — wrap, never clip. */}
            {availableCaps.length > 0 && (
              <div
                className="flex min-w-0 flex-wrap items-center gap-1"
                role="group"
                aria-label={t("modelsTab.capabilities")}
              >
                {availableCaps.map((cap) => {
                  const active = capFilters.includes(cap)
                  return (
                    <Button
                      key={cap}
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "outline"}
                      aria-pressed={active}
                      data-testid={`models-cap-filter-${cap}`}
                      className={cn(
                        "h-6 max-w-full px-2 text-xs font-normal",
                        active && "border-primary/40"
                      )}
                      onClick={() => toggleCap(cap)}
                    >
                      <span className="truncate">{capLabel(cap)}</span>
                    </Button>
                  )
                })}
              </div>
            )}
            <span
              className="mx-0.5 hidden h-4 w-px shrink-0 bg-border @xl/provider-pane:inline"
              aria-hidden
            />
            <Button
              type="button"
              size="sm"
              variant={enabledOnly ? "secondary" : "ghost"}
              aria-pressed={enabledOnly}
              className="h-6 px-2 text-xs"
              onClick={() => setEnabledOnly((prev) => !prev)}
            >
              {t("modelsTab.enabledOnly")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handleSelectAll}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" />
              <span className="truncate">{t("modelsTab.selectAll")}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handleDeselectAll}
            >
              <Ban className="mr-1 h-3.5 w-3.5" />
              <span className="truncate">{t("modelsTab.deselectAll")}</span>
            </Button>
            {hasActiveFilters && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={clearFilters}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                <span className="truncate">{t("modelsTab.clearFilters")}</span>
              </Button>
            )}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground" role="status">
              {t("modelsTab.countSummary", {
                shown: filtered.length,
                total: models.length,
                enabled: enabledTotal,
              })}
            </span>
          </div>
        )}
      </div>

      {/* ── Scrolling table ─────────────────────────────────────────────── */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {filtered.length > 0 ? (
          <table
            className="w-full border-collapse text-sm"
            data-testid="models-table"
            aria-label={t("modelsTab.tableLabel")}
          >
            {/* The header is sticky inside the scroller so a 40-row list keeps
                its column names (and its sort affordance) in view. */}
            <thead className="sticky top-0 z-10 bg-background/95 text-xs text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <tr className="border-b">
                {compare && (
                  <th scope="col" className="w-8 px-2 py-1.5">
                    <span className="sr-only">{t("modelsTab.columnCompare")}</span>
                    <GitCompareArrows className="size-3.5" aria-hidden />
                  </th>
                )}
                <SortableHead
                  label={t("modelsTab.columnModel")}
                  sortKey="name"
                  sort={sort}
                  onSort={(key) => setSort((prev) => nextSort(prev, key))}
                />
                <th scope="col" className="px-2 py-1.5 text-left font-medium">
                  {t("modelsTab.capabilities")}
                </th>
                <SortableHead
                  label={t("modelsTab.contextWindow")}
                  sortKey="context"
                  sort={sort}
                  onSort={(key) => setSort((prev) => nextSort(prev, key))}
                  align="right"
                />
                <SortableHead
                  label={t("modelsTab.columnMaxOutput")}
                  sortKey="maxOutput"
                  sort={sort}
                  onSort={(key) => setSort((prev) => nextSort(prev, key))}
                  align="right"
                  className="hidden @xl/provider-pane:table-cell"
                />
                <SortableHead
                  label={t("modelsTab.columnPrice")}
                  sortKey="price"
                  sort={sort}
                  onSort={(key) => setSort((prev) => nextSort(prev, key))}
                  align="right"
                  className="hidden @2xl/provider-pane:table-cell"
                />
                <SortableHead
                  label={t("modelsTab.columnReleased")}
                  sortKey="release"
                  sort={sort}
                  onSort={(key) => setSort((prev) => nextSort(prev, key))}
                  align="right"
                  className="hidden @3xl/provider-pane:table-cell"
                />
                <th scope="col" className="w-12 px-2 py-1.5 text-right font-medium">
                  <span className="sr-only">{t("modelsTab.columnEnabled")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((model) => {
                const key = comparisonModelKey(providerId, model.id)
                const checked = compareSet.has(key)
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    isEnabled={allModelsEnabled || enabledModels.includes(model.id)}
                    onToggle={handleToggle}
                    metadataLoading={metadataLoading}
                    diagnosticStatus={diagnosticStatusByModel[model.id]}
                    compare={
                      compare
                        ? {
                            checked,
                            disabled: !checked && compareFull,
                            onToggle: () => compare.onToggle(key),
                          }
                        : undefined
                    }
                  />
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center px-4 py-12 text-sm text-muted-foreground">
            {t("modelsTab.noModels")}
          </div>
        )}
      </ScrollArea>

      {/* ── Pinned compare bar ──────────────────────────────────────────── */}
      {compare && compareCount > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/40 px-4 py-2"
          data-testid="models-compare-bar"
          role="region"
          aria-label={t("modelsTab.compareBarLabel")}
        >
          <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground" role="status">
            {t("modelsTab.compareSelected", { count: compareCount, max: COMPARISON_MAX_MODELS })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={compare.onClear}
              data-testid="models-compare-clear"
            >
              {t("modelsTab.compareClear")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={compare.onOpen}
              disabled={compareCount < 2}
              title={compareCount < 2 ? t("modelsTab.compareNeedsTwo") : undefined}
              data-testid="models-compare-open"
            >
              {t("modelsTab.compareOpen")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
