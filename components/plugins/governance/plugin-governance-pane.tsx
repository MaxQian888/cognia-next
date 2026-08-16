"use client"

// Governance section content — cross-plugin aggregate views (permissions
// matrix, scheduled jobs, analytics, audit log). The active view comes
// from `usePluginsStore.governanceView`, which the left nav sub-items
// also write to.
//
// Each child surface is reused as-is:
//   - PluginPermissionsTab  (existing — declared/granted matrix)
//   - PluginScheduledJobs   (existing — runs across all plugins when no pluginId)
//   - PluginAnalytics       (existing — totals across all plugins when no pluginId)
//   - PluginAuditLog        (new in PR 3 — exports CSV + filters the guard's
//                           in-memory ring buffer)

import { useTranslations } from "next-intl"
import { usePluginsStore } from "@/stores/plugins"
import { PluginPermissionsTab } from "../detail/plugin-permissions-tab"
import { PluginScheduledJobs } from "../detail/plugin-scheduled-jobs"
import { PluginAnalytics } from "../detail/plugin-analytics"
import { PluginAuditLog } from "./plugin-audit-log"
import { PluginGovernancePolicyTab } from "./plugin-governance-policy-tab"

export function PluginGovernancePane() {
  const t = useTranslations("plugins.sections.governanceSub")
  const view = usePluginsStore((s) => s.governanceView)

  return (
    // No visible <h2>: the active view's name is already rendered by
    // FeaturePageHeader's `context` slot and by the selected segment in
    // PluginGovernanceHeader — a third copy was the page saying the same
    // word three times. The name stays available to assistive tech as the
    // region's accessible name.
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto p-4"
      data-testid="plugin-governance-pane"
      data-view={view}
      role="region"
      aria-label={t(view)}
    >
      <div className="min-h-0 flex-1">
        {view === "permissions" && <PluginPermissionsTab />}
        {view === "scheduled" && <PluginScheduledJobs />}
        {view === "analytics" && <PluginAnalytics />}
        {view === "audit" && <PluginAuditLog />}
        {view === "policy" && <PluginGovernancePolicyTab />}
      </div>
    </div>
  )
}
