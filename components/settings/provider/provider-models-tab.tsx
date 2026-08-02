"use client"

import React, { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Search, RefreshCw, Loader2, ArrowUpDown, X, PlugZap, CheckCheck, Ban } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
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
}

/** Sort modes for the model grid. `default` keeps catalog order. */
type SortMode = "default" | "name" | "context" | "release"

const SORT_CYCLE: SortMode[] = ["default", "name", "context", "release"]

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
   * reserve space for the capability chips instead of growing them in later.
   */
  metadataLoading?: boolean
  diagnosticStatusByModel?: Record<string, ProviderDiagnosticBadgeStatus>
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function formatContextLength(length: number): string {
  if (length >= 1_000_000) {
    const val = length / 1_000_000
    return `${Number.isInteger(val) ? val : val.toFixed(1)}M`
  }
  if (length >= 1_000) {
    const val = length / 1_000
    return `${Number.isInteger(val) ? val : val.toFixed(0)}K`
  }
  return String(length)
}

/* ── ModelCard ───────────────────────────────────────────────────────────── */

interface ModelCardProps {
  model: ModelConfig
  isEnabled: boolean
  onToggle: (id: string, enabled: boolean) => void
  contextLabel: string
  /** Pre-translated "Cutoff" prefix for the knowledge date. */
  knowledgeLabel: string
  /** Pre-translated "Updated" prefix for the last-updated date. */
  updatedLabel: string
  /** Pre-translated "max out" suffix for the output-token limit. */
  maxOutputLabel: string
  /** Pre-translated "open weights" badge text. */
  openWeightsLabel: string
  /** Pre-translated "modes" suffix, formatted with the count via ICU. */
  formatModes: (count: number) => string
  /** See `ProviderModelsTabProps.metadataLoading`. */
  metadataLoading?: boolean
  diagnosticStatus?: ProviderDiagnosticBadgeStatus
}

function ModelCard({
  model,
  isEnabled,
  onToggle,
  contextLabel,
  knowledgeLabel,
  updatedLabel,
  maxOutputLabel,
  openWeightsLabel,
  formatModes,
  metadataLoading = false,
  diagnosticStatus,
}: ModelCardProps) {
  const t = useTranslations("providers.sidebar")
  const caps: string[] = model.capabilities ?? []
  const variants = model.variants ?? []
  const statusVariant = statusBadgeVariant(model.status)
  // The models.dev catalog is a separate Dexie read that lands after the static
  // provider catalog. Without a placeholder the card first paints bare and then
  // *grows* a capability row, shifting everything below it. Reserve the row at
  // the same height while the read is still in flight.
  const showCapsPlaceholder = metadataLoading && caps.length === 0

  return (
    <div
      data-enabled={isEnabled || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border p-3 transition-colors",
        isEnabled
          ? "border-primary/40 bg-primary/[0.04]"
          : "bg-card hover:border-foreground/20 hover:bg-muted/40"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-semibold leading-tight">
              {model.name}
            </span>
            {statusVariant && model.status && (
              <Badge variant={statusVariant} className="text-[10px] px-1.5 py-0 capitalize">
                {model.status}
              </Badge>
            )}
            {model.openWeights && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {openWeightsLabel}
              </Badge>
            )}
            {diagnosticStatus && (
              <Badge
                variant="outline"
                data-testid={`model-diagnostic-${model.id}`}
                data-diagnostic-status={diagnosticStatus}
                className={cn(
                  "text-[10px] px-1.5 py-0",
                  diagnosticStatus === "passed" && "border-emerald-500/30 text-emerald-600",
                  diagnosticStatus === "failed" && "border-destructive/30 text-destructive",
                  diagnosticStatus === "stale" && "text-muted-foreground"
                )}
              >
                {t(`diagnostic${diagnosticStatus[0].toUpperCase()}${diagnosticStatus.slice(1)}`)}
              </Badge>
            )}
          </div>
          {/* The model *id* is what the user types into routing, aliases and
              the CLI — it used to be visible nowhere on the card. */}
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <span className="truncate font-mono">{model.id}</span>
            {model.family && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{model.family}</span>
              </>
            )}
          </div>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) => onToggle(model.id, checked)}
          aria-label={model.id}
          className="shrink-0"
        />
      </div>

      {showCapsPlaceholder ? (
        <div className="flex flex-wrap gap-1" data-testid="model-caps-placeholder" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-14 rounded-full" />
          ))}
        </div>
      ) : (
        caps.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {caps.map((cap) => (
              <Badge key={cap} variant="secondary" className="text-xs px-1.5 py-0">
                {cap}
              </Badge>
            ))}
          </div>
        )
      )}

      {variants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {variants.map((v) => (
            <Badge key={v} variant="outline" className="text-[10px] px-1.5 py-0">
              {v}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {model.contextLength !== undefined && (
          <span>
            {formatContextLength(model.contextLength)} {contextLabel}
          </span>
        )}
        {model.maxOutputTokens !== undefined && model.maxOutputTokens > 0 && (
          <span>
            {formatContextLength(model.maxOutputTokens)} {maxOutputLabel}
          </span>
        )}
        {model.modeCount !== undefined && model.modeCount > 0 && (
          <span>{formatModes(model.modeCount)}</span>
        )}
        {model.releaseDate && <span>{model.releaseDate}</span>}
        {model.knowledge && (
          <span>
            {knowledgeLabel} {model.knowledge}
          </span>
        )}
        {model.lastUpdated && (
          <span>
            {updatedLabel} {model.lastUpdated}
          </span>
        )}
        {model.adapter && <span className="font-mono text-[10px]">{model.adapter}</span>}
      </div>
    </div>
  )
}

/* ── ProviderModelsTab ───────────────────────────────────────────────────── */

export function ProviderModelsTab({
  models,
  enabledModels,
  onEnabledModelsChange,
  onRefreshModels,
  isRefreshing = false,
  onTestConnection,
  isTesting = false,
  metadataLoading = false,
  diagnosticStatusByModel = {},
}: ProviderModelsTabProps) {
  const t = useTranslations("providers")
  const [search, setSearch] = useState("")
  const [capFilters, setCapFilters] = useState<string[]>([])
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [sort, setSort] = useState<SortMode>("default")

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
      if (enabledOnly && !enabledSet.has(m.id)) return false
      return true
    })

    if (sort === "name") {
      result.sort((a, b) => a.name.localeCompare(b.name))
    } else if (sort === "context") {
      result.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
    } else if (sort === "release") {
      result.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    }
    return result
  }, [models, search, capFilters, enabledOnly, sort, enabledModels])

  const enabledTotal = useMemo(
    () => models.filter((m) => enabledModels.includes(m.id)).length,
    [models, enabledModels]
  )

  /* Toggle a single model */
  const handleToggle = (modelId: string, enabled: boolean) => {
    if (enabled) {
      onEnabledModelsChange([...enabledModels, modelId])
    } else {
      onEnabledModelsChange(enabledModels.filter((id) => id !== modelId))
    }
  }

  const toggleCap = (cap: string) => {
    setCapFilters((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]))
  }

  const cycleSort = () => {
    setSort((prev) => SORT_CYCLE[(SORT_CYCLE.indexOf(prev) + 1) % SORT_CYCLE.length])
  }

  const clearFilters = () => {
    setSearch("")
    setCapFilters([])
    setEnabledOnly(false)
  }

  /* Batch operations on visible models */
  const filteredIds = filtered.map((m) => m.id)

  const handleSelectAll = () => {
    // Keep existing enabled models outside the filtered set, add all filtered ones
    const outside = enabledModels.filter((id) => !filteredIds.includes(id))
    onEnabledModelsChange([...outside, ...filteredIds])
  }

  const handleDeselectAll = () => {
    onEnabledModelsChange(enabledModels.filter((id) => !filteredIds.includes(id)))
  }

  const sortLabel = t(
    `modelsTab.sort${sort.charAt(0).toUpperCase()}${sort.slice(1)}` as
      | "modelsTab.sortDefault"
      | "modelsTab.sortName"
      | "modelsTab.sortContext"
      | "modelsTab.sortRelease"
  )

  return (
    /* Two bands: a pinned toolbar and a scroller. The tab used to be one long
       scrolling document inside the detail panel's pane-wide `ScrollArea`, so
       scrolling to a model 40 rows down took the search box, the capability
       filters and the batch actions off-screen with it. The toolbar is now a
       `shrink-0` sibling of the list and only the list moves. */
    <div className="flex min-h-0 flex-1 flex-col" data-testid="models-tab">
      {/* ── Pinned toolbar ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-2.5 border-b px-4 py-3">
        {/* Search + provider-level actions. Wraps rather than overflowing: on a
            narrow pane the buttons drop to their own line instead of being
            clipped by the right edge. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative min-w-[9rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("modelsTab.searchPlaceholder")}
              className="h-9 pl-8"
            />
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={onRefreshModels}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              <span className="truncate">{t("modelsTab.refreshModels")}</span>
            </Button>
            {onTestConnection && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={onTestConnection}
                disabled={isTesting}
                data-testid="models-tab-test-connection"
              >
                {isTesting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PlugZap className="mr-2 h-4 w-4" />
                )}
                <span className="truncate">{t("testConnection")}</span>
              </Button>
            )}
          </div>
        </div>

        {models.length > 0 && (
          <>
            {/* Capability chips — wrap, never clip. */}
            {availableCaps.length > 0 && (
              <div
                className="flex min-w-0 flex-wrap items-center gap-1.5"
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
                      className={cn(
                        "h-6 max-w-full px-2 text-xs font-normal capitalize",
                        active && "border-primary/40"
                      )}
                      onClick={() => toggleCap(cap)}
                    >
                      <span className="truncate">{cap}</span>
                    </Button>
                  )
                })}
              </div>
            )}

            {/* View controls + batch actions + count, on one wrapping row. The
                batch pair used to be a second toolbar carrying four buttons,
                two of which ("Enable/Disable Selected") ran the exact same
                handlers as the other two — same action, two names. */}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={enabledOnly ? "secondary" : "ghost"}
                aria-pressed={enabledOnly}
                className="h-7 px-2 text-xs"
                onClick={() => setEnabledOnly((prev) => !prev)}
              >
                {t("modelsTab.enabledOnly")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={cycleSort}
              >
                <ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />
                <span className="truncate">{t("modelsTab.sortBy", { label: sortLabel })}</span>
              </Button>
              <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleSelectAll}
              >
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                <span className="truncate">{t("modelsTab.selectAll")}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleDeselectAll}
              >
                <Ban className="mr-1.5 h-3.5 w-3.5" />
                <span className="truncate">{t("modelsTab.deselectAll")}</span>
              </Button>
              {hasActiveFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
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
          </>
        )}
      </div>

      {/* ── Scrolling model list ────────────────────────────────────────── */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {filtered.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 p-4 @2xl/provider-pane:grid-cols-2">
            {filtered.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                isEnabled={enabledModels.includes(model.id)}
                onToggle={handleToggle}
                contextLabel={t("modelsTab.contextWindow")}
                knowledgeLabel={t("modelsTab.knowledgeCutoff")}
                updatedLabel={t("modelsTab.updated")}
                maxOutputLabel={t("modelsTab.maxOutput")}
                openWeightsLabel={t("modelsTab.openWeights")}
                formatModes={(count) => t("modelsTab.modes", { count })}
                metadataLoading={metadataLoading}
                diagnosticStatus={diagnosticStatusByModel[model.id]}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center px-4 py-12 text-sm text-muted-foreground">
            {t("modelsTab.noModels")}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
