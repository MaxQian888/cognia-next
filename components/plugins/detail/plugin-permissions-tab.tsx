"use client"

// Governance → Permissions: the cross-plugin permission matrix. Two tables
// (sensitive / standard) keyed on the guard's `DANGEROUS_PERMISSIONS`; each
// row lists a permission, how many plugins hold it, and a chip per holder.
// Chips open the existing `PluginPermissionReview` dialog through the shared
// zustand store.
//
// A "Review by plugin" strip at the top opens that dialog for any plugin
// that asks for permissions, without going through the per-row menu.
//
// Layout: flat sections under small headings, separated by hairlines — no
// cards, and no bordered box around the tables. The governance pane is the
// scroll surface, so nothing here scrolls on its own (a table only scrolls
// sideways when its columns cannot fit). Column visibility follows the
// section's own width (anonymous `@container`), not the viewport.
//
// Plugins are named the way the Library names them: the manifest's localized
// name in the UI language, not the raw English `row.name`.

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ShieldCheckIcon, AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { usePlugins, usePluginPermissions } from "@/hooks/plugins"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginPermission } from "@/types/plugin"
import type { PluginRow } from "@/lib/db/plugin-types"

/** A plugin as the matrix shows it: its id and its name in the UI language. */
interface Holder {
  id: string
  name: string
}

interface MatrixEntry {
  permission: PluginPermission
  holders: Holder[]
}

/**
 * Every permission any plugin declares, optionally requests, or has been
 * granted, with the plugins holding it — split into the sensitive set and
 * the rest. Pure.
 */
export function buildPermissionMatrix(
  rows: readonly PluginRow[],
  getGranted: (id: string) => PluginPermission[],
  dangerous: ReadonlySet<string>,
  displayName: (row: PluginRow) => string
): { dangerous: MatrixEntry[]; normal: MatrixEntry[] } {
  const holdersByPermission = new Map<PluginPermission, Holder[]>()

  for (const row of rows) {
    const manifest = row.manifest as {
      permissions?: PluginPermission[]
      optionalPermissions?: PluginPermission[]
    }
    const held = [
      ...(manifest.permissions ?? []),
      ...(manifest.optionalPermissions ?? []),
      ...getGranted(row.id),
    ]
    for (const perm of held) {
      const list = holdersByPermission.get(perm) ?? []
      if (!list.some((existing) => existing.id === row.id)) {
        list.push({ id: row.id, name: displayName(row) })
      }
      holdersByPermission.set(perm, list)
    }
  }

  // Sorted by permission id for a stable render.
  const entries = Array.from(holdersByPermission, ([permission, holders]) => ({
    permission,
    holders,
  })).sort((a, b) => a.permission.localeCompare(b.permission))

  return {
    dangerous: entries.filter((entry) => dangerous.has(entry.permission)),
    normal: entries.filter((entry) => !dangerous.has(entry.permission)),
  }
}

export function PluginPermissionsTab() {
  const t = useTranslations("plugins.permissions")
  const locale = useLocale()
  const { all, loading } = usePlugins()
  const perms = usePluginPermissions()
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)

  const displayName = useMemo(
    () => (row: PluginRow) => localizePluginText(row, locale).name || row.name,
    [locale]
  )

  const { dangerous, normal } = useMemo(
    () =>
      buildPermissionMatrix(
        all,
        perms.getGranted,
        new Set<string>(perms.dangerous as string[]),
        displayName
      ),
    [all, perms, displayName]
  )

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("loading")}
      </p>
    )
  }

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <ShieldCheckIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t("emptyAll")}</p>
      </div>
    )
  }

  const totalEntries = dangerous.length + normal.length

  return (
    <div className="@container space-y-5" data-testid="plugin-permissions-tab">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
      </div>

      <BulkReview rows={all} displayName={displayName} onOpen={openPermissionReview} />

      {totalEntries === 0 ? (
        <p className="border-t pt-4 text-sm text-muted-foreground">{t("noPermissions")}</p>
      ) : (
        <>
          {dangerous.length > 0 && (
            <PermissionSection
              title={t("dangerousSection")}
              danger
              entries={dangerous}
              onOpenReview={openPermissionReview}
            />
          )}
          {normal.length > 0 && (
            <PermissionSection
              title={t("normalSection")}
              entries={normal}
              onOpenReview={openPermissionReview}
            />
          )}
        </>
      )}
    </div>
  )
}

function BulkReview({
  rows,
  displayName,
  onOpen,
}: {
  rows: readonly PluginRow[]
  displayName: (row: PluginRow) => string
  onOpen: (id: string) => void
}) {
  const t = useTranslations("plugins.permissions")
  const permissioned = rows.filter((row) => {
    const declared = (row.manifest as { permissions?: unknown[] }).permissions ?? []
    const optional = (row.manifest as { optionalPermissions?: unknown[] }).optionalPermissions ?? []
    return declared.length + optional.length > 0
  })
  if (permissioned.length === 0) return null
  return (
    <section className="space-y-2 border-t pt-4" aria-labelledby="plugin-permissions-bulk">
      <h4 id="plugin-permissions-bulk" className="text-xs font-medium text-muted-foreground">
        {t("bulkHeading")}
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {permissioned.map((row) => {
          const name = displayName(row)
          return (
            <Button
              key={row.id}
              size="sm"
              variant="outline"
              className="h-7 text-xs pointer-coarse:h-10"
              onClick={() => onOpen(row.id)}
              aria-label={t("reviewAria", { name })}
            >
              {name}
            </Button>
          )
        })}
      </div>
    </section>
  )
}

function PermissionSection({
  title,
  entries,
  danger,
  onOpenReview,
}: {
  title: string
  entries: MatrixEntry[]
  danger?: boolean
  onOpenReview: (id: string) => void
}) {
  const t = useTranslations("plugins.permissions")
  return (
    <section className="space-y-2 border-t pt-4">
      <div className="flex items-center gap-2">
        {danger ? (
          <AlertTriangleIcon className="size-4 text-destructive" aria-hidden="true" />
        ) : (
          <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        <h4 className={cn("text-sm font-semibold", danger && "text-destructive")}>{title}</h4>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("col.permission")}</TableHead>
            <TableHead className="hidden @md:table-cell">{t("col.holders")}</TableHead>
            <TableHead>{t("col.plugins")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.permission} className={cn(danger && "hover:bg-destructive/5")}>
              <TableCell className="align-top font-mono text-xs">
                <span className={cn(danger && "font-semibold text-destructive")}>
                  {entry.permission}
                </span>
              </TableCell>
              <TableCell className="hidden align-top @md:table-cell">
                <Badge variant={danger ? "destructive" : "outline"}>{entry.holders.length}</Badge>
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap gap-1">
                  {entry.holders.map((holder) => (
                    <Button
                      key={holder.id}
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs pointer-coarse:h-10"
                      onClick={() => onOpenReview(holder.id)}
                      aria-label={t("reviewAria", { name: holder.name })}
                    >
                      {holder.name}
                    </Button>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
