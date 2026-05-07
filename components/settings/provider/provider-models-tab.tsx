"use client"

import React, { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Search, RefreshCw, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface ModelConfig {
  id: string
  name: string
  capabilities?: string[]
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
}

export interface ProviderModelsTabProps {
  providerId: string
  models: ModelConfig[]
  enabledModels: string[]
  onEnabledModelsChange: (modelIds: string[]) => void
  onTestConnection: () => void
  isTesting?: boolean
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
}

function ModelCard({ model, isEnabled, onToggle, contextLabel }: ModelCardProps) {
  const caps: string[] = model.capabilities ?? []

  return (
    <div className="rounded-lg border p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-sm leading-tight">{model.name}</span>
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) => onToggle(model.id, checked)}
          aria-label={model.id}
          className="shrink-0"
        />
      </div>

      {caps.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {caps.map((cap) => (
            <Badge key={cap} variant="secondary" className="text-xs px-1.5 py-0">
              {cap}
            </Badge>
          ))}
        </div>
      )}

      {model.contextLength !== undefined && (
        <span className="text-xs text-muted-foreground">
          {formatContextLength(model.contextLength)} {contextLabel}
        </span>
      )}
    </div>
  )
}

/* ── ProviderModelsTab ───────────────────────────────────────────────────── */

export function ProviderModelsTab({
  models,
  enabledModels,
  onEnabledModelsChange,
  onTestConnection,
  isTesting = false,
}: ProviderModelsTabProps) {
  const t = useTranslations("providers")
  const [search, setSearch] = useState("")

  /* Filtered model list */
  const filtered = useMemo(() => {
    if (!search.trim()) return models
    const q = search.toLowerCase()
    return models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  }, [models, search])

  /* Toggle a single model */
  const handleToggle = (modelId: string, enabled: boolean) => {
    if (enabled) {
      onEnabledModelsChange([...enabledModels, modelId])
    } else {
      onEnabledModelsChange(enabledModels.filter((id) => id !== modelId))
    }
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

  const handleEnableSelected = handleSelectAll
  const handleDisableSelected = handleDeselectAll

  return (
    <div className="flex flex-col gap-3 py-2">
      {/* Top bar: search + refresh */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("modelsTab.searchPlaceholder")}
            className="pl-8"
          />
        </div>
        <Button variant="outline" size="sm" onClick={onTestConnection} disabled={isTesting}>
          {isTesting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {t("modelsTab.refreshModels")}
        </Button>
      </div>

      {/* Batch operations toolbar — only when models exist */}
      {models.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" size="sm" onClick={handleSelectAll}>
            {t("modelsTab.selectAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDeselectAll}>
            {t("modelsTab.deselectAll")}
          </Button>
          <span className="mx-1 text-muted-foreground/40 select-none">|</span>
          <Button variant="ghost" size="sm" onClick={handleEnableSelected}>
            {t("modelsTab.batchEnable")}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDisableSelected}>
            {t("modelsTab.batchDisable")}
          </Button>
        </div>
      )}

      {/* Model grid */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              isEnabled={enabledModels.includes(model.id)}
              onToggle={handleToggle}
              contextLabel={t("modelsTab.contextWindow")}
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          {t("modelsTab.noModels")}
        </div>
      )}
    </div>
  )
}
