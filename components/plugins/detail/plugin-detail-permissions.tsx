"use client"

// Permissions sub-tab — inline twin of the modal PluginPermissionReview.
// Renders the same Table shape with declared / optional / granted columns
// + per-row tier select + grant/revoke buttons, using the exported
// `PermissionRow` from `plugin-permission-review.tsx` so behavior can't
// drift between the two surfaces.
//
// Tier API is already exposed end-to-end (`getTier` / `setTier` on
// `usePluginPermissions`) — nothing new required at the data layer.

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { usePluginPermissions, usePluginRow } from "@/hooks/plugins"
import { Skeleton } from "@/components/ui/skeleton"
import { PermissionRow } from "../plugin-permission-review"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AuditLogEntry } from "../audit-log-entry"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

export function PluginDetailPermissions({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.permissionReview")
  const tDetail = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)
  const perms = usePluginPermissions()

  const manifest =
    rowState.state === "ready" ? (rowState.row.manifest as unknown as PluginManifest) : undefined
  const declared = useMemo(() => manifest?.permissions ?? [], [manifest])
  const optional = useMemo(() => manifest?.optionalPermissions ?? [], [manifest])
  const justifications = useMemo(() => manifest?.permissionJustifications ?? {}, [manifest])
  const granted = useMemo(() => new Set(perms.getGranted(pluginId)), [perms, pluginId])
  const allListed = useMemo<PluginPermission[]>(() => {
    const set = new Set<PluginPermission>([...declared, ...optional, ...granted])
    return Array.from(set).sort()
  }, [declared, optional, granted])

  const auditLog = useMemo(
    () =>
      perms.auditLog
        .filter((entry) => entry.pluginId === pluginId)
        .slice(-25)
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

  if (allListed.length === 0) {
    return <p className="text-sm text-muted-foreground">{tDetail("noPermissions")}</p>
  }

  return (
    <div className="space-y-3">
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[8rem]">{t("colPermission")}</TableHead>
                <TableHead className="hidden md:table-cell min-w-[6rem] text-center">
                  {t("colDeclared")}
                </TableHead>
                <TableHead className="hidden md:table-cell min-w-[6rem] text-center">
                  {t("colOptional")}
                </TableHead>
                <TableHead className="min-w-[5rem] text-center">{t("colGranted")}</TableHead>
                <TableHead className="min-w-[9rem]">{t("colTier")}</TableHead>
                <TableHead className="min-w-[6rem] text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allListed.map((perm) => (
                <PermissionRow
                  key={perm}
                  perm={perm}
                  declared={declared.includes(perm)}
                  optional={optional.includes(perm)}
                  granted={granted.has(perm)}
                  dangerous={perms.isDangerous(perm)}
                  onGrant={() => perms.grant(pluginId, perm, { grantedBy: "user" })}
                  onRevoke={() => perms.revoke(pluginId, perm)}
                  tier={perms.getTier(pluginId, perm)}
                  onTierChange={(tier) => perms.setTier(pluginId, perm, tier)}
                  description={justifications[perm] ?? perms.descriptions[perm] ?? perm}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="space-y-1">
        <h3 className="text-xs font-semibold">{t("auditLogTitle")}</h3>
        <Card className="p-0">
          <ScrollArea className="max-h-[20vh]">
            {auditLog.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{t("auditEmpty")}</p>
            ) : (
              <ul className="divide-y">
                {auditLog.map((entry, idx) => (
                  <AuditLogEntry key={idx} entry={entry} />
                ))}
              </ul>
            )}
          </ScrollArea>
        </Card>
      </div>
    </div>
  )
}
