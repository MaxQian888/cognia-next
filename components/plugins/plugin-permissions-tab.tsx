"use client"

// Permissions tab — full-fidelity aggregated permission matrix replacing the
// previous instructional placeholder. The view is split into two tables
// (sensitive / standard) keyed on `DANGEROUS_PERMISSIONS`. Each row lists a
// permission, the count of plugins holding it, and a chip per holder. Chips
// click through to the existing `PluginPermissionReview` dialog via the
// shared zustand store.
//
// A "Per-plugin review" panel at the top lets the user open the review
// dialog for any installed plugin without going through the per-card menu —
// useful as a quick-glance bulk audit surface.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheckIcon, AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
import { usePluginsStore } from "@/stores/plugins"
import type { PluginPermission } from "@/types/plugin"
import type { PluginRow } from "@/lib/db/plugin-types"

interface MatrixEntry {
  permission: PluginPermission
  holders: PluginRow[]
}

function buildMatrix(
  rows: PluginRow[],
  getGranted: (id: string) => PluginPermission[]
): { dangerous: MatrixEntry[]; normal: MatrixEntry[] } {
  const holdersByPermission = new Map<PluginPermission, PluginRow[]>()

  const collect = (row: PluginRow, permissions: PluginPermission[]) => {
    for (const perm of permissions) {
      const list = holdersByPermission.get(perm) ?? []
      if (!list.find((existing) => existing.id === row.id)) list.push(row)
      holdersByPermission.set(perm, list)
    }
  }

  for (const row of rows) {
    const declared = ((row.manifest as { permissions?: PluginPermission[] }).permissions ??
      []) as PluginPermission[]
    const optional = ((row.manifest as { optionalPermissions?: PluginPermission[] })
      .optionalPermissions ?? []) as PluginPermission[]
    const granted = getGranted(row.id)
    collect(row, [...declared, ...optional, ...granted])
  }

  // Sort permissions alphabetically for stable rendering.
  const entries: MatrixEntry[] = Array.from(holdersByPermission.entries())
    .map(([permission, holders]) => ({ permission, holders }))
    .sort((a, b) => a.permission.localeCompare(b.permission))

  return { dangerous: [], normal: entries }
}

export function PluginPermissionsTab() {
  const t = useTranslations("plugins.permissions")
  const { all, loading } = usePlugins()
  const perms = usePluginPermissions()
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)

  const { dangerous, normal } = useMemo(() => {
    const dangerousSet = new Set<string>(perms.dangerous as string[])
    const built = buildMatrix(all, perms.getGranted)
    return {
      dangerous: built.normal.filter((e) => dangerousSet.has(e.permission)),
      normal: built.normal.filter((e) => !dangerousSet.has(e.permission)),
    }
  }, [all, perms])

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  if (all.length === 0) {
    return (
      <Card className="p-8 text-center space-y-3">
        <ShieldCheckIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("emptyAll")}</p>
      </Card>
    )
  }

  const totalEntries = dangerous.length + normal.length

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
      </div>

      <BulkReview rows={all} onOpen={openPermissionReview} />

      {totalEntries === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("noPermissions")}</Card>
      ) : (
        <div className="space-y-5">
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
        </div>
      )}
    </div>
  )
}

function BulkReview({ rows, onOpen }: { rows: PluginRow[]; onOpen: (id: string) => void }) {
  const t = useTranslations("plugins.permissions")
  if (rows.length === 0) return null
  return (
    <Card className="p-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t("bulkHeading")}</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((row) => (
          <Button
            key={row.id}
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onOpen(row.id)}
            aria-label={t("reviewAria", { name: row.name })}
          >
            {row.name}
          </Button>
        ))}
      </div>
    </Card>
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
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        {danger ? (
          <AlertTriangleIcon className="size-4 text-destructive" />
        ) : (
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
        )}
        <h4 className={cn("text-sm font-semibold", danger && "text-destructive")}>{title}</h4>
      </div>
      <div className={cn("rounded-md border overflow-x-auto", danger && "border-destructive/30")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.permission")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("col.holders")}</TableHead>
              <TableHead>{t("col.plugins")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.permission}>
                <TableCell className="font-mono text-xs">
                  <span className={cn(danger && "text-destructive")}>{entry.permission}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant={danger ? "destructive" : "outline"}>{entry.holders.length}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {entry.holders.map((row) => (
                      <Button
                        key={row.id}
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => onOpenReview(row.id)}
                        aria-label={t("reviewAria", { name: row.name })}
                      >
                        {row.name}
                      </Button>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
