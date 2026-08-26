"use client"

/**
 * Settings → Memory: a master/detail surface for corpus health, learning,
 * retrieval, retention, and privacy controls.
 *
 * Layout mirrors `gateway-section.tsx` (the shared master/detail shape in this
 * app): `SettingsMasterDetail` owns the nav/detail split: the rail tiers off
 * the pane's own width (full → compact → icon → drawer) rather than the
 * viewport, which this pane never gets — it is the window minus the app rail
 * minus the settings sidebar. The detail pane owns its own scroll and declares
 * `@container/memory-pane` so panel internals size off the pane rather than the
 * window.
 *
 * The whole surface used to sit inside a `SettingsCard`, which put a bordered
 * box around a bordered nav rail and a bordered detail pane — three nested
 * frames for one page. The card is gone; the master enable switch that used to
 * be its first row now sits in the page header, where it stays visible from
 * every panel instead of scrolling away with the card body.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon } from "lucide-react"

import { useMemoryInsights } from "@/hooks/memory/use-memory-insights"
import { useSettingsStore } from "@/stores/settings"
import { resolveMemoryConfig, type MemoryConfig } from "@/types/memory/memory"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { MemoryDangerZone } from "@/components/settings/memory/danger-zone"
import { MemoryToggleRow } from "@/components/settings/memory/memory-controls"
import { MemoryNav } from "@/components/settings/memory/memory-nav"
import { DEFAULT_MEMORY_PANEL, type MemoryPanelId } from "@/components/settings/memory/nav-config"
import { LearningPanel } from "@/components/settings/memory/panels/learning-panel"
import { OverviewPanel } from "@/components/settings/memory/panels/overview-panel"
import { RetrievalPanel } from "@/components/settings/memory/panels/retrieval-panel"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

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

  // Two mounts, two prefixes: the desktop rail is only `display:none` below
  // `md`, so it and the Sheet copy are both in the tree while the Sheet is
  // open, and they must not share one shared-layout pill id.
  const renderNav = (idPrefix: string) => (
    <MemoryNav
      activeId={activePanel}
      onSelect={(id) => {
        setActivePanel(id)
      }}
      conflictCount={insights.corpus.stats.conflicts}
      retrievalDegraded={insights.retrievalMode?.kind === "bm25"}
      idPrefix={idPrefix}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="memory-section">
      {/* Header + master switch. The switch governs every panel, so it lives
          above the split rather than inside one of them. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border/60 pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <BrainIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <Label htmlFor="mem-enabled" className="text-sm font-medium">
            {t("enabled.label")}
          </Label>
          <Switch
            id="mem-enabled"
            aria-label={t("enabled.label")}
            checked={config.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </div>
      </div>

      <SettingsMasterDetail
        nav={(slot) => (slot === "rail" ? renderNav("memory") : renderNav("memory-sheet"))}
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={260}
        triggerTestId="memory-mobile-nav-trigger"
      >
        {/* `@container/memory-pane`: the detail pane is a fraction of the
            window, so anything multi-column inside a panel must size off this
            box rather than the viewport. */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <section
            aria-labelledby={`memory-panel-${activePanel}`}
            className="@container/memory-pane min-h-0 flex-1 overflow-y-auto p-4"
            data-testid="memory-panel-body"
          >
            <h3 id={`memory-panel-${activePanel}`} className="mb-3 text-sm font-semibold">
              {t(`nav.items.${activePanel}.label`)}
            </h3>
            <PanelTransition activeKey={activePanel}>{panel}</PanelTransition>
          </section>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}
