"use client"

// Governance section content — cross-plugin aggregate views (permissions
// matrix, scheduled jobs, analytics, audit log, policy). The active view
// comes from `usePluginsStore.governanceView`, which the segmented picker in
// `PluginGovernanceHeader` writes.
//
// Each child surface is reused as-is:
//   - PluginPermissionsTab       (declared / optional / granted matrix)
//   - PluginScheduledJobs        (runs across all plugins when no pluginId)
//   - PluginAnalytics            (totals across all plugins when no pluginId)
//   - PluginAuditLog             (filters + CSV export over the guard's
//                                in-memory ring buffer)
//   - PluginGovernancePolicyTab  (governance / signature / update / sandbox)
//
// This pane is the one scroll surface for every view, and an anonymous
// `@container`, so the views lay themselves out by the pane's width rather
// than the viewport's and none of them needs a scroller of its own.

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
    // No visible <h2>: the active view's name is already the selected
    // segment in PluginGovernanceHeader — a heading here was the page saying
    // the same word twice. The name stays available to assistive tech as
    // the region's accessible name.
    <div
      className="@container flex h-full min-h-0 flex-col overflow-y-auto p-4"
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
