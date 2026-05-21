"use client"

// Shared single-row renderer for `PermissionAuditEntry` records. Extracted
// from `plugin-permission-review.tsx` so both the per-plugin modal review
// (last 25 entries for one pluginId) and the Governance > Audit Log
// surface (last 200 entries across all plugins, with filters) render the
// exact same shape — same Badge variants, same timestamp format, same
// font/spacing. Keeping a single source of truth here prevents the two
// surfaces from drifting visually.

import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"
import { Badge } from "@/components/ui/badge"

export interface AuditLogEntryProps {
  /** The audit record to render. */
  entry: PermissionAuditEntry
  /**
   * When true, the entry includes the plugin id as a leading column so the
   * Governance view (which aggregates across plugins) shows context. The
   * per-plugin modal review hides this because the surrounding header
   * already names the plugin.
   */
  showPlugin?: boolean
}

function formatHms(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[1]?.slice(0, 8) ?? ""
}

function badgeVariantForAction(action: PermissionAuditEntry["action"]) {
  if (action === "grant") return "secondary" as const
  if (action === "deny" || action === "revoke") return "destructive" as const
  return "outline" as const
}

export function AuditLogEntry({ entry, showPlugin = false }: AuditLogEntryProps) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <Badge variant={badgeVariantForAction(entry.action)} className="text-xs">
        {entry.action}
      </Badge>
      {showPlugin ? (
        <code className="font-mono shrink-0 text-muted-foreground">{entry.pluginId}</code>
      ) : null}
      <code className="font-mono flex-1 truncate">{entry.permission}</code>
      <span className="text-muted-foreground shrink-0">{formatHms(entry.timestamp)}</span>
    </li>
  )
}
