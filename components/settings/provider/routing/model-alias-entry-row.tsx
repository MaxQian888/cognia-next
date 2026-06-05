"use client"

// One provider:model entry inside the alias editor — picker, optional weight,
// per-entry conditions (price/latency ceilings), reorder + remove controls.

import { useTranslations } from "next-intl"
import { ArrowDown, ArrowUp, SlidersHorizontal, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ProviderModelCombobox } from "./provider-model-combobox"
import type { ModelMappingEntry } from "@/types/provider/model-mapping"

interface ModelAliasEntryRowProps {
  entry: ModelMappingEntry
  index: number
  total: number
  /** Weight input only renders for weighted distribution. */
  showWeight: boolean
  onChange: (entry: ModelMappingEntry) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}

function numOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function ModelAliasEntryRow({
  entry,
  index,
  total,
  showWeight,
  onChange,
  onMove,
  onRemove,
}: ModelAliasEntryRowProps) {
  const t = useTranslations("providers.routingView")
  const hasConditions =
    entry.conditions?.maxCostPer1M !== undefined || entry.conditions?.maxLatencyMs !== undefined

  return (
    <div className="flex items-center gap-1.5" data-testid={`alias-entry-${index}`}>
      <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <ProviderModelCombobox
          providerId={entry.providerId || undefined}
          modelId={entry.modelId || undefined}
          onSelect={(providerId, modelId) => onChange({ ...entry, providerId, modelId })}
        />
      </div>
      {showWeight ? (
        <Input
          type="number"
          min={0}
          value={entry.weight ?? ""}
          placeholder="1"
          aria-label={t("entryWeight")}
          className="h-8 w-16 text-xs"
          onChange={(e) => onChange({ ...entry, weight: numOrUndefined(e.target.value) })}
        />
      ) : null}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={hasConditions ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t("entryConditions")}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-3">
          <p className="text-xs font-medium">{t("entryConditions")}</p>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`cond-cost-${index}`}>
              {t("maxCostPer1M")}
            </Label>
            <Input
              id={`cond-cost-${index}`}
              type="number"
              min={0}
              step="0.01"
              value={entry.conditions?.maxCostPer1M ?? ""}
              onChange={(e) =>
                onChange({
                  ...entry,
                  conditions: {
                    ...entry.conditions,
                    maxCostPer1M: numOrUndefined(e.target.value),
                  },
                })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={`cond-latency-${index}`}>
              {t("maxLatencyMs")}
            </Label>
            <Input
              id={`cond-latency-${index}`}
              type="number"
              min={0}
              value={entry.conditions?.maxLatencyMs ?? ""}
              onChange={(e) =>
                onChange({
                  ...entry,
                  conditions: {
                    ...entry.conditions,
                    maxLatencyMs: numOrUndefined(e.target.value),
                  },
                })
              }
              className="h-8 text-xs"
            />
          </div>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={t("moveUp")}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={t("moveDown")}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-destructive"
        aria-label={t("removeEntry")}
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export default ModelAliasEntryRow
