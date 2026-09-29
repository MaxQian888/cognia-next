"use client"

/**
 * Settings → Memory → Maintenance: how memory ages.
 *
 * Two groups. "Forgetting" holds the long-standing controls (idle expiry and
 * the per-scope cap) plus access reinforcement, which decides who loses when
 * the cap bites. "Lifecycle sweep" holds the opt-in cold-memory passes —
 * compaction and near-duplicate folding — which rewrite text, so each says
 * plainly that the previous text stays in the memory's history.
 *
 * Folding duplicates compares stored vectors; without a vector backend the
 * switch stays usable (the preference is remembered) but the panel says the
 * pass will not run, rather than letting it fail silently every night.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import type { MemoryConfig } from "@/types/memory/memory"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { GatedGroup, MemoryToggleRow, SliderRow } from "../memory-controls"

export interface MaintenancePanelProps {
  config: MemoryConfig
  update: (patch: Partial<MemoryConfig>) => void
  insights: Pick<MemoryInsights, "retrievalMode">
}

export function MaintenancePanel({ config, update, insights }: MaintenancePanelProps) {
  const t = useTranslations("settings.memory")
  const tm = useTranslations("settings.memory.maintenance")
  const vectorsAvailable = insights.retrievalMode?.kind === "hybrid"
  const sweepEnabled = Boolean(config.compactColdEpisodic || config.dedupColdClusters)

  return (
    <div className="space-y-6">
      <section className="space-y-4" aria-labelledby="mem-maintenance-forgetting">
        <h4 id="mem-maintenance-forgetting" className="text-xs font-medium text-muted-foreground">
          {tm("forgetting.title")}
        </h4>
        <div className="grid gap-4 @md/memory-pane:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mem-max-idle">{t("maxIdle.label")}</Label>
            <ClampedNumberInput
              id="mem-max-idle"
              aria-label={t("maxIdle.label")}
              value={config.maxIdleDays ?? 0}
              min={0}
              max={3650}
              integer
              onCommit={(maxIdleDays) => update({ maxIdleDays })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-cap">{t("cap.label")}</Label>
            <ClampedNumberInput
              id="mem-cap"
              aria-label={t("cap.label")}
              value={config.maxActivePerScope}
              min={1}
              max={100_000}
              integer
              onCommit={(maxActivePerScope) => update({ maxActivePerScope })}
            />
          </div>
        </div>
        <SliderRow
          id="mem-access-reinforcement"
          label={tm("reinforcement.label")}
          description={tm("reinforcement.description")}
          value={config.accessReinforcementWeight ?? 0.6}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (v === 0 ? tm("reinforcement.off") : v.toFixed(1))}
          onChange={(v) => update({ accessReinforcementWeight: Math.round(v * 10) / 10 })}
        />
      </section>

      <section className="space-y-3" aria-labelledby="mem-maintenance-sweep">
        <div className="space-y-0.5">
          <h4 id="mem-maintenance-sweep" className="text-xs font-medium text-muted-foreground">
            {tm("sweep.title")}
          </h4>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {tm("sweep.description")}
          </p>
        </div>
        <MemoryToggleRow
          id="mem-compact-cold"
          label={tm("compaction.label")}
          description={tm("compaction.description")}
          checked={config.compactColdEpisodic ?? false}
          disabled={!config.enabled}
          onCheckedChange={(compactColdEpisodic) => update({ compactColdEpisodic })}
        />
        <MemoryToggleRow
          id="mem-dedup-cold"
          label={tm("dedup.label")}
          description={
            <>
              {tm("dedup.description")}
              {config.dedupColdClusters && !vectorsAvailable ? (
                <span
                  className="mt-1 block text-amber-600 dark:text-amber-400"
                  data-testid="mem-dedup-no-vectors"
                >
                  {tm("dedup.noVectors")}
                </span>
              ) : null}
            </>
          }
          checked={config.dedupColdClusters ?? false}
          disabled={!config.enabled}
          onCheckedChange={(dedupColdClusters) => update({ dedupColdClusters })}
        />
        {/* Inert (not hidden) while no pass is on: the threshold only means
            something to the sweep, and a hidden control would read as absent. */}
        <GatedGroup gated={!sweepEnabled} reason={tm("sweep.gatedReason")}>
          <SliderRow
            id="mem-cold-threshold"
            label={tm("coldThreshold.label")}
            description={tm("coldThreshold.description")}
            value={config.coldRetentionThreshold ?? 0.2}
            min={0.05}
            max={0.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => update({ coldRetentionThreshold: Math.round(v * 100) / 100 })}
          />
        </GatedGroup>
      </section>
    </div>
  )
}
