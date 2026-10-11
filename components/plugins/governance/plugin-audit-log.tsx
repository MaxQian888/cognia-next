"use client"

// Cross-plugin audit log view. Reads `usePluginPermissions().auditLog`
// (the guard's in-memory ring buffer — up to 200 most recent entries),
// applies the user's plugin + permission filters, and renders the result
// via the shared `<AuditLogEntry>` component so the per-plugin modal and
// this surface stay visually identical.
//
// "Export CSV" downloads the currently-visible rows as a CSV blob. We
// intentionally include the filtered set, not the entire ring buffer,
// because the filter chips visually narrow the surface and exporting the
// full buffer would surprise the user.
//
// Plugins are named the way the Library names them (the manifest's localized
// name), in the filter and on every row; the id stays in the CSV and as the
// row's hover title. A plugin no longer installed falls back to its id.
//
// Flat: the list sits under the filters between hairlines, with no card and
// no inner scroller — the governance pane already scrolls, and a 60vh box
// inside it meant two scrollbars fighting over one wheel.

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePluginPermissions, usePlugins } from "@/hooks/plugins"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import type { PermissionAuditEntry } from "@/lib/plugin/security/permission-guard"
import { AuditLogEntry } from "../audit-log-entry"

const ALL = "__all__"

function entriesToCsv(entries: PermissionAuditEntry[]): string {
  const header = "timestamp,pluginId,permission,action,allowed,context"
  const rows = entries.map((entry) =>
    [
      new Date(entry.timestamp).toISOString(),
      entry.pluginId,
      entry.permission,
      entry.action,
      String(entry.allowed),
      entry.context ?? "",
    ]
      .map(csvCell)
      .join(",")
  )
  return [header, ...rows].join("\n")
}

function csvCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function PluginAuditLog() {
  const t = useTranslations("plugins.audit")
  const locale = useLocale()
  const perms = usePluginPermissions()
  const { all } = usePlugins()
  const [pluginFilter, setPluginFilter] = useState<string>(ALL)
  const [permissionFilter, setPermissionFilter] = useState<string>(ALL)

  /** id → the name the Library shows, for every installed plugin. */
  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of all) {
      const name = localizePluginText(row, locale).name.trim()
      if (name) map.set(row.id, name)
    }
    return map
  }, [all, locale])

  const pluginOptions = useMemo(() => {
    const set = new Set<string>()
    for (const entry of perms.auditLog) set.add(entry.pluginId)
    return Array.from(set, (id) => ({ id, label: nameById.get(id) ?? id })).sort((a, b) =>
      a.label.localeCompare(b.label, locale)
    )
  }, [perms.auditLog, nameById, locale])

  const permissionOptions = useMemo(() => {
    const set = new Set<string>()
    for (const entry of perms.auditLog) set.add(entry.permission)
    return Array.from(set).sort()
  }, [perms.auditLog])

  const filtered = useMemo(() => {
    return perms.auditLog
      .filter((entry) => (pluginFilter === ALL ? true : entry.pluginId === pluginFilter))
      .filter((entry) => (permissionFilter === ALL ? true : entry.permission === permissionFilter))
      .slice()
      .reverse()
  }, [perms.auditLog, pluginFilter, permissionFilter])

  const handleExport = () => {
    if (typeof window === "undefined") return
    const csv = entriesToCsv(filtered)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = t("exportFilename")
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="@container space-y-3" data-testid="plugin-audit-log">
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pluginFilter} onValueChange={setPluginFilter}>
          <SelectTrigger
            aria-label={t("filterPluginLabel")}
            className="h-8 w-full text-xs pointer-coarse:h-10 @md:w-[12rem]"
            data-testid="plugin-audit-filter-plugin"
          >
            <SelectValue placeholder={t("filterPluginAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filterPluginAll")}</SelectItem>
            {pluginOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={permissionFilter} onValueChange={setPermissionFilter}>
          <SelectTrigger
            aria-label={t("filterPermissionLabel")}
            className="h-8 w-full text-xs pointer-coarse:h-10 @md:w-[14rem]"
            data-testid="plugin-audit-filter-permission"
          >
            <SelectValue placeholder={t("filterPermissionAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("filterPermissionAll")}</SelectItem>
            {permissionOptions.map((perm) => (
              <SelectItem key={perm} value={perm}>
                <code className="font-mono text-xs">{perm}</code>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:h-10"
          onClick={handleExport}
          disabled={filtered.length === 0}
          data-testid="plugin-audit-export"
        >
          <DownloadIcon className="mr-1.5 size-3.5" />
          {t("exportCsv")}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <p className="border-t py-3 text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y border-y" data-testid="plugin-audit-log-list">
          {filtered.map((entry, idx) => (
            <AuditLogEntry
              key={`${entry.timestamp}-${idx}`}
              entry={entry}
              showPlugin
              pluginName={nameById.get(entry.pluginId)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
