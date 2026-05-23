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

export function PluginGovernancePane() {
  const t = useTranslations("plugins.sections.governanceSub")
  const view = usePluginsStore((s) => s.governanceView)

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto p-4"
      data-testid="plugin-governance-pane"
      data-view={view}
    >
      <header className="mb-3 shrink-0">
        <h2 className="text-base font-semibold">{t(view)}</h2>
      </header>
      <div className="min-h-0 flex-1">
        {view === "permissions" && <PluginPermissionsTab />}
        {view === "scheduled" && <PluginScheduledJobs />}
        {view === "analytics" && <PluginAnalytics />}
        {view === "audit" && <PluginAuditLog />}
      </div>
    </div>
  )
}
