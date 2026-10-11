"use client"

// Permissions tab — inline twin of the modal PluginPermissionReview. Renders
// the same permission list (declaration metadata, grant state, tier select,
// grant/revoke) through the exported `PermissionList` from
// `plugin-permission-review.tsx`, so behavior can't drift between the two
// surfaces.
//
// The tab owns the pane's full height, and the pane is the scroller. So
// nothing here draws an outer box or a nested scroll region: the trust notice
// is a flat callout, and each group (permissions, approved binaries, audit
// events) is a hairline + small heading over a plain divided list. The audit
// list shows its newest 10 entries and expands in place to the full ring
// (last 25) instead of scrolling inside a 20vh box.
//
// Tier API is already exposed end-to-end (`getTier` / `setTier` on
// `usePluginPermissions`) — nothing new required at the data layer.

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { usePluginPermissions, usePluginRow } from "@/hooks/plugins"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"
import { collectListedPermissions, PermissionList } from "../plugin-permission-review"
import { AuditLogEntry } from "../audit-log-entry"
import { PluginApprovedBinariesCard } from "./plugin-approved-binaries-card"
import { PluginFrontendTrustCard } from "./plugin-frontend-trust-card"
import { PluginDetailGroup } from "./plugin-detail-group"
import type { PluginManifest, PluginSource, PluginType } from "@/types/plugin"

/** How many audit events the tab shows before "Show all". */
export const AUDIT_PREVIEW_COUNT = 10
/** The per-plugin audit ring the tab reads (newest first). */
const AUDIT_RING_SIZE = 25

export function PluginDetailPermissions({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.permissionReview")
  const tDetail = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const perms = usePluginPermissions()

  const manifest =
    rowState.state === "ready" ? (rowState.row.manifest as unknown as PluginManifest) : undefined
  const granted = useMemo(() => new Set(perms.getGranted(pluginId)), [perms, pluginId])
  const allListed = useMemo(() => collectListedPermissions(manifest, granted), [manifest, granted])

  const auditLog = useMemo(
    () =>
      perms.auditLog
        .filter((entry) => entry.pluginId === pluginId)
        .slice(-AUDIT_RING_SIZE)
        .reverse(),
    [perms.auditLog, pluginId]
  )

  if (rowState.state === "loading") {
    return (
      <div className="space-y-3" data-testid="plugin-detail-permissions-loading" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (rowState.state === "not-found") {
    return <p className="text-sm text-muted-foreground">{tDetail("notFound")}</p>
  }

  // PluginRow stores type/source as plain strings (Dexie row shape); narrow
  // them the same way the manifest is narrowed above. The callout renders
  // null unless the plugin is renderer-JS from an untrusted source, or a VS
  // Code extension no Open VSX signature vouches for.
  const trustCard = (
    <PluginFrontendTrustCard
      pluginId={pluginId}
      type={rowState.row.type as PluginType}
      source={rowState.row.source as PluginSource}
      signedByOpenVsx={manifest?.vscodeExtension?.signedBy === "openvsx"}
    />
  )

  if (allListed.length === 0) {
    return (
      <div className="space-y-4">
        {trustCard}
        <p className="text-sm text-muted-foreground">{tDetail("noPermissions")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {trustCard}

      <PluginDetailGroup
        title={t("listTitle")}
        actions={
          <span className="text-[11px] tabular-nums text-muted-foreground">{allListed.length}</span>
        }
        testId="plugin-permissions-list"
      >
        <PermissionList
          pluginId={pluginId}
          manifest={manifest}
          permissions={allListed}
          granted={granted}
        />
      </PluginDetailGroup>

      <PluginApprovedBinariesCard pluginId={pluginId} />

      <PermissionAuditList entries={auditLog} />
    </div>
  )
}

/**
 * The plugin's recent permission audit events as a flat divided list. The
 * pane is the scroller, so the list grows in place: the newest
 * `AUDIT_PREVIEW_COUNT` show by default and a toggle reveals the rest.
 */
export function PermissionAuditList({ entries }: { entries: PermissionAuditEntry[] }) {
  const t = useTranslations("plugins.permissionReview")
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const overflow = entries.length > AUDIT_PREVIEW_COUNT
  const visible = expanded || !overflow ? entries : entries.slice(0, AUDIT_PREVIEW_COUNT)

  return (
    <PluginDetailGroup title={t("auditLogTitle")} testId="plugin-permissions-audit">
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("auditEmpty")}</p>
      ) : (
        <>
          {/* `AuditLogEntry` pads itself for a framed list; flush it with the
              heading here, where the list is flat. */}
          <ul className="divide-y [&>li]:px-0" id={listId}>
            {visible.map((entry, idx) => (
              <AuditLogEntry key={`${entry.timestamp}-${idx}`} entry={entry} />
            ))}
          </ul>
          {overflow ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0 py-1 text-xs pointer-coarse:h-10"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("auditShowFewer") : t("auditShowAll", { count: entries.length })}
            </Button>
          ) : null}
        </>
      )}
    </PluginDetailGroup>
  )
}
