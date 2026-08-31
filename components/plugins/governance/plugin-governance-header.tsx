"use client"

// Header controls for the Governance section — the aggregate-view picker
// (Permissions / Scheduled / Analytics / Audit / Policy).
//
// These five used to be nested sub-items in the left nav rail, where they
// sat directly under the four section entries and made the rail carry two
// different axes at once. They are now segments in the shared
// `PluginSectionToolbar`, the same tier and the same control Library's
// status filter uses. Views aren't countable, so every segment is always
// rendered (see `visibleSegments`).

import { useTranslations } from "next-intl"

import { usePluginsStore, type PluginGovernanceView } from "@/stores/plugins"
import { PLUGIN_GOVERNANCE_VIEWS } from "../plugin-nav-config"
import { PluginSectionToolbar, type PluginSectionToolbarProps } from "../plugin-section-toolbar"

export interface PluginGovernanceHeaderProps {
  /** Forwarded to `PluginSectionToolbar`; the phone body passes "stacked". */
  layout?: PluginSectionToolbarProps["layout"]
}

export function PluginGovernanceHeader({ layout }: PluginGovernanceHeaderProps = {}) {
  const t = useTranslations("plugins.sections.governanceSub")
  const tSections = useTranslations("plugins.sections")
  const view = usePluginsStore((s) => s.governanceView)
  const setView = usePluginsStore((s) => s.setGovernanceView)

  return (
    <PluginSectionToolbar
      layout={layout}
      testId="plugin-governance-toolbar"
      segments={{
        ariaLabel: tSections("governance"),
        items: PLUGIN_GOVERNANCE_VIEWS.map((item) => ({
          value: item.value,
          label: t(item.labelKey),
        })),
        value: view,
        onSelect: (value) => setView(value as PluginGovernanceView),
        testId: "plugin-governance-view",
      }}
    />
  )
}
