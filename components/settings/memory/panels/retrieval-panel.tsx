"use client"

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import type { MemoryConfig } from "@/types/memory/memory"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { GatedGroup, MemoryToggleRow } from "../memory-controls"
import { RecallPreview } from "../recall-preview"
import { RetrievalModeAlert } from "../retrieval-mode-alert"

export interface RetrievalPanelProps {
  config: MemoryConfig
  update: (patch: Partial<MemoryConfig>) => void
  insights: MemoryInsights
}

/** A labelled slider whose numeric readout sits inline with the label. */
function SliderRow({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  format?: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid={`${id}-value`}>
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        id={id}
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  )
}

export function RetrievalPanel({ config, update, insights }: RetrievalPanelProps) {
  const t = useTranslations("settings.memory.retrieval")

  return (
    <div className="space-y-4">
      <RetrievalModeAlert
        mode={insights.retrievalMode}
        onEnableHybrid={() => update({ hybridEnabled: true })}
        onAllowCloudEmbedding={() => update({ allowCloudEmbedding: true })}
        quietWhenHealthy
      />

      <MemoryToggleRow
        id="mem-use"
        label={t("useMemory.label")}
        description={t("useMemory.description")}
        checked={config.useMemory}
        disabled={!config.enabled}
        onCheckedChange={(v) => update({ useMemory: v })}
      />

      <GatedGroup
        gated={!config.enabled || !config.useMemory}
        reason={!config.enabled ? t("gates.memoryOff") : t("gates.recallOff")}
        className="space-y-4 border-l-2 pl-3"
      >
        <div className="space-y-2">
          <MemoryToggleRow
            id="mem-hybrid"
            label={t("hybrid.label")}
            description={t("hybrid.description")}
            checked={config.hybridEnabled}
            onCheckedChange={(v) => update({ hybridEnabled: v })}
          />
          <MemoryToggleRow
            id="mem-query-expansion"
            label={t("queryExpansion.label")}
            description={t("queryExpansion.description")}
            checked={config.enableQueryExpansion ?? false}
            onCheckedChange={(v) => update({ enableQueryExpansion: v })}
          />
        </div>

        <RecallPreview
          config={config}
          averageTokens={insights.corpus.averageTokens}
          activeCount={insights.corpus.stats.active}
        />

        <SliderRow
          id="mem-topk"
          label={t("topK.label")}
          description={t("topK.description")}
          value={config.retrievalTopK}
          min={1}
          max={32}
          step={1}
          onChange={(v) => update({ retrievalTopK: v })}
        />

        <SliderRow
          id="mem-token-budget"
          label={t("tokenBudget.label")}
          description={t("tokenBudget.description")}
          value={config.recallTokenBudget}
          min={128}
          max={4000}
          step={32}
          onChange={(v) => update({ recallTokenBudget: v })}
        />

        <SliderRow
          id="mem-relevance"
          label={t("relevanceFloor.label")}
          description={t("relevanceFloor.description")}
          value={config.relevanceFloor}
          min={0}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => update({ relevanceFloor: v })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="mem-half-life" className="text-sm font-medium">
            {t("halfLife.label")}
          </Label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("halfLife.description")}
          </p>
          <ClampedNumberInput
            id="mem-half-life"
            aria-label={t("halfLife.label")}
            value={config.decayHalfLifeDays}
            min={1}
            max={3650}
            integer
            className="w-full sm:w-40"
            onCommit={(v) => update({ decayHalfLifeDays: v })}
          />
        </div>
      </GatedGroup>
    </div>
  )
}
