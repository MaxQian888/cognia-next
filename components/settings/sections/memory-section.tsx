"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon } from "lucide-react"

import { useMemoryInsights } from "@/hooks/memory/use-memory-insights"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig, type MemoryConfig } from "@/types/memory/memory"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { MemoryDangerZone } from "@/components/settings/memory/danger-zone"
import { MemoryToggleRow } from "@/components/settings/memory/memory-controls"
import { MemoryNav } from "@/components/settings/memory/memory-nav"
import { DEFAULT_MEMORY_PANEL, type MemoryPanelId } from "@/components/settings/memory/nav-config"
import { LearningPanel } from "@/components/settings/memory/panels/learning-panel"
import { OverviewPanel } from "@/components/settings/memory/panels/overview-panel"
import { RetrievalPanel } from "@/components/settings/memory/panels/retrieval-panel"
import { Label } from "@/components/ui/label"
import { SettingsCard } from "../common/settings-section"

/**
 * Settings → Memory: a master/detail surface for corpus health, learning,
 * retrieval, retention, and privacy controls.
 */
export function MemorySection() {
  const t = useTranslations("settings.memory")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [activePanel, setActivePanel] = useState<MemoryPanelId>(DEFAULT_MEMORY_PANEL)

  const config = resolveMemoryConfig(settings?.memory)
  const insights = useMemoryInsights(config)
  const update = (patch: Partial<MemoryConfig>) => void save({ memory: { ...config, ...patch } })

  const panel = (() => {
    switch (activePanel) {
      case "overview":
        return (
          <OverviewPanel
            insights={insights}
            onEnableHybrid={() => update({ hybridEnabled: true })}
            onAllowCloudEmbedding={() => update({ allowCloudEmbedding: true })}
          />
        )
      case "learning":
        return <LearningPanel config={config} update={update} />
      case "retrieval":
        return <RetrievalPanel config={config} update={update} insights={insights} />
      case "maintenance":
        return (
          <div className="grid gap-4 sm:grid-cols-2">
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
        )
      case "privacy":
        return (
          <div className="space-y-4">
            <MemoryToggleRow
              id="mem-temporary"
              label={t("temporary.label")}
              description={t("temporary.description")}
              checked={config.temporary}
              onCheckedChange={(temporary) => update({ temporary })}
            />
            <MemoryToggleRow
              id="mem-cloud"
              label={t("cloudEmbedding.label")}
              description={t("cloudEmbedding.description")}
              checked={config.allowCloudEmbedding}
              onCheckedChange={(allowCloudEmbedding) => update({ allowCloudEmbedding })}
            />
            <MemoryDangerZone />
          </div>
        )
    }
  })()

  return (
    <SettingsCard
      icon={<BrainIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="@container/memory-pane space-y-4">
        <MemoryToggleRow
          id="mem-enabled"
          label={t("enabled.label")}
          description={t("enabled.description")}
          checked={config.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />

        <div className="grid min-h-0 gap-4 border-t pt-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="min-h-0 rounded-lg border bg-muted/20">
            <MemoryNav
              activeId={activePanel}
              onSelect={setActivePanel}
              conflictCount={insights.corpus.stats.conflicts}
              retrievalDegraded={insights.retrievalMode?.kind === "bm25"}
            />
          </aside>
          <section aria-labelledby={`memory-panel-${activePanel}`} className="min-w-0">
            <h3 id={`memory-panel-${activePanel}`} className="mb-3 text-sm font-semibold">
              {t(`nav.items.${activePanel}.label`)}
            </h3>
            {panel}
          </section>
        </div>
      </div>
    </SettingsCard>
  )
}
