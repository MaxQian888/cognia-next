"use client"

// Configure tab — full-fidelity surface listing every installed plugin with
// its config-schema state and a per-row "Configure" CTA. Replaces the
// instructional placeholder that previously re-rendered PluginPanelGrid.
//
// State derivation:
//   * no-schema     — manifest.configSchema is missing or not an object;
//                     the Configure button is disabled.
//   * configured    — row.config has at least one key written.
//   * unconfigured  — schema is present but no config has been saved yet.
//
// Search filters by name / id / description (matches the global panel
// search behavior). Clicking Configure delegates to the existing
// `PluginConfigForm` dialog via `usePluginsStore.openConfigure`, so this tab
// shares the same dialog instance the per-card menu uses.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SettingsIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { usePlugins } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"

type ConfigState = "configured" | "unconfigured" | "no-schema"

export function deriveConfigState(row: PluginRow): ConfigState {
  const schema = (row.manifest as { configSchema?: unknown }).configSchema
  if (!schema || typeof schema !== "object") return "no-schema"
  const config = row.config ?? {}
  return Object.keys(config).length > 0 ? "configured" : "unconfigured"
}

function matchesQuery(row: PluginRow, q: string): boolean {
  if (!q) return true
  const lower = q.toLowerCase()
  const description = ((row.manifest as { description?: string }).description ?? "").toLowerCase()
  return (
    row.name.toLowerCase().includes(lower) ||
    row.id.toLowerCase().includes(lower) ||
    description.includes(lower)
  )
}

export function PluginConfigureTab() {
  const t = useTranslations("plugins.configure")
  const { all, loading } = usePlugins()
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const [query, setQuery] = useState("")

  const rows = useMemo(() => all.filter((row) => matchesQuery(row, query)), [all, query])

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  if (all.length === 0) {
    return (
      <Card className="p-8 text-center space-y-3">
        <SettingsIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
      </div>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("search")}
        className="w-full sm:max-w-md"
        aria-label={t("search")}
      />

      {rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t("emptyFiltered")}</Card>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col.plugin")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("col.version")}</TableHead>
                <TableHead>{t("col.state")}</TableHead>
                <TableHead className="text-right">{t("col.action")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ConfigureRow key={row.id} row={row} onConfigure={openConfigure} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function ConfigureRow({ row, onConfigure }: { row: PluginRow; onConfigure: (id: string) => void }) {
  const t = useTranslations("plugins.configure")
  const state = deriveConfigState(row)
  const description = (row.manifest as { description?: string }).description

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium truncate">{row.name}</span>
          {description ? (
            <span className="text-xs text-muted-foreground truncate">{description}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
        v{row.version}
      </TableCell>
      <TableCell>
        <StateBadge state={state} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant={state === "configured" ? "outline" : "default"}
          disabled={state === "no-schema"}
          onClick={() => onConfigure(row.id)}
          aria-label={t("actionAria", { name: row.name })}
        >
          <SettingsIcon className="size-3.5 mr-1.5" />
          {t("action")}
        </Button>
      </TableCell>
    </TableRow>
  )
}

function StateBadge({ state }: { state: ConfigState }) {
  const t = useTranslations("plugins.configure.state")
  if (state === "configured") {
    return <Badge variant="secondary">{t("configured")}</Badge>
  }
  if (state === "unconfigured") {
    return <Badge variant="outline">{t("unconfigured")}</Badge>
  }
  return (
    <Badge variant="outline" className="opacity-60">
      {t("noSchema")}
    </Badge>
  )
}
