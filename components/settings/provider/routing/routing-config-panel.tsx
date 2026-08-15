"use client"

// Orchestrator for the routing tab: global-scope banner + strategy + presets
// + alias mappings + per-provider constraints + live preview. The config it
// edits is GLOBAL (AppSettings.modelMappings / routingConfig) even though the
// tab renders inside a per-provider dialog — hence the banner.

import { useTranslations } from "next-intl"
import {
  Activity,
  FlaskConical,
  Gauge,
  GitMerge,
  Globe,
  Layers,
  Shield,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react"

import {
  SettingsAlert,
  SettingsCard,
  SettingsDivider,
} from "@/components/settings/common/settings-section"
import { RoutingStrategyPicker } from "./routing-strategy-picker"
import { RoutingPresetCards } from "./routing-preset-cards"
import { ModelAliasList } from "./model-alias-list"
import { ProviderConstraintsEditor } from "./provider-constraints-editor"
import { RoutingTestPanel } from "./routing-test-panel"
import { ReliabilitySection } from "./reliability-section"
import { SemanticRoutingSection } from "./semantic-routing-section"
import { AutoRoutingSection } from "./auto-routing-section"
import { DifficultyRoutingSection } from "./difficulty-routing-section"

export function RoutingConfigPanel() {
  const t = useTranslations("providers.routingView")

  return (
    <div className="space-y-5">
      <SettingsAlert icon={<Globe className="h-4 w-4" />}>{t("globalScopeNote")}</SettingsAlert>

      <SettingsCard
        icon={<Sparkles className="h-4 w-4" />}
        title={t("presetsTitle")}
        description={t("presetsDesc")}
      >
        <RoutingPresetCards />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<Layers className="h-4 w-4" />}
        title={t("strategyTitle")}
        description={t("strategyDesc")}
      >
        <RoutingStrategyPicker />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<GitMerge className="h-4 w-4" />}
        title={t("aliasesTitle")}
        description={t("aliasesDesc")}
      >
        <ModelAliasList />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<Shield className="h-4 w-4" />}
        title={t("constraintsTitle")}
        description={t("constraintsDesc")}
        collapsible
        defaultOpen={false}
      >
        <ProviderConstraintsEditor />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<Activity className="h-4 w-4" />}
        title={t("reliability.title")}
        description={t("reliability.desc")}
        collapsible
        defaultOpen={false}
      >
        <ReliabilitySection />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<Wand2 className="h-4 w-4" />}
        title={t("semantic.title")}
        description={t("semantic.desc")}
        collapsible
        defaultOpen={false}
      >
        <SemanticRoutingSection />
      </SettingsCard>

      <SettingsDivider />

      {/* The "difficulty" strategy is offered by the picker above and only
          takes effect once a strong/weak model pair is configured here; the
          section was built with the strategy but never mounted, so the
          strategy could be selected and silently fell back to the first
          candidate. */}
      <SettingsCard
        icon={<Gauge className="h-4 w-4" />}
        title={t("difficulty.title")}
        description={t("difficulty.desc")}
        collapsible
        defaultOpen={false}
      >
        <DifficultyRoutingSection />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<Zap className="h-4 w-4" />}
        title={t("auto.title")}
        description={t("auto.desc")}
        collapsible
        defaultOpen={false}
      >
        <AutoRoutingSection />
      </SettingsCard>

      <SettingsDivider />

      <SettingsCard
        icon={<FlaskConical className="h-4 w-4" />}
        title={t("testTitle")}
        description={t("testDesc")}
      >
        <RoutingTestPanel />
      </SettingsCard>
    </div>
  )
}

export default RoutingConfigPanel
