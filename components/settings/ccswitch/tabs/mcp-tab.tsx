"use client"

// CCSwitch → MCP servers tab. Lists CCSwitch's mcp_servers entries with
// checkboxes, a strategy radio, and a "Import selected" button. Submit
// routes through the existing `bulkImportMcpServers` (same path used by
// the agent-file MCP import dialog), so collisions follow the established
// "skip / overwrite / duplicate" semantics.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCcswitchMcpServers, useCcswitchStatus } from "@/lib/ccswitch/hooks"
import { importCcswitchMcp } from "@/lib/ccswitch/import"
import type { McpImportStrategy } from "@/lib/db/mcp-servers"
import type { CcswitchMcpServer } from "@/types/ccswitch"
import { isTauri } from "@/lib/tauri"

export function CcswitchMcpTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()
  const { data: status } = useCcswitchStatus(tabReady)
  const {
    data: servers,
    loading,
    error,
    refresh,
  } = useCcswitchMcpServers(tabReady && status?.exists === true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [strategy, setStrategy] = useState<McpImportStrategy>("skip")
  const [importing, setImporting] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default-select all rows whenever the source data refreshes
    setSelected(new Set(servers?.map((s) => s.id) ?? []))
  }, [servers])

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const onImport = async () => {
    if (!servers) return
    const picks = servers.filter((s) => selected.has(s.id))
    setImporting(true)
    setResultText(null)
    try {
      const r = await importCcswitchMcp(picks, strategy)
      setResultText(
        t("mcp.resultSummary", {
          imported: r.imported,
          updated: r.updated,
          skipped: r.skipped,
          errored: r.errored.length,
        })
      )
    } finally {
      setImporting(false)
    }
  }

  const supportedSelected = useMemo(() => selected.size, [selected])

  if (!tabReady) {
    return (
      <SettingsAlert title={t("overview.webModeTitle")}>{t("overview.webModeBody")}</SettingsAlert>
    )
  }

  if (status && !status.exists) {
    return (
      <SettingsEmptyState
        title={t("overview.notFoundTitle")}
        description={t("overview.notFoundBody")}
      />
    )
  }

  if (loading) {
    return <Skeleton className="h-32 w-full" />
  }

  if (error) {
    return (
      <SettingsAlert variant="destructive" title={t("mcp.errorTitle")}>
        {error}
      </SettingsAlert>
    )
  }

  if (!servers?.length) {
    return <SettingsEmptyState title={t("mcp.emptyTitle")} description={t("mcp.emptyBody")} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("mcp.headerHint")}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("providers.refresh")}
        </Button>
      </div>

      <SettingsCard title={t("mcp.listTitle")}>
        <ul className="divide-y">
          {servers.map((s) => (
            <McpRow
              key={s.id}
              server={s}
              checked={selected.has(s.id)}
              onChange={(c) => toggle(s.id, c)}
            />
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard title={t("mcp.strategyTitle")} description={t("mcp.strategyBody")}>
        <RadioGroup
          value={strategy}
          onValueChange={(v) => setStrategy(v as McpImportStrategy)}
          className="space-y-2"
        >
          {(["skip", "overwrite", "duplicate"] as const).map((id) => (
            <div key={id} className="flex items-start gap-2">
              <RadioGroupItem id={`mcp-strategy-${id}`} value={id} className="mt-1" />
              <Label htmlFor={`mcp-strategy-${id}`} className="cursor-pointer">
                <div className="text-sm font-medium">{t(`mcp.strategy.${id}`)}</div>
                <div className="text-xs text-muted-foreground">{t(`mcp.strategy.${id}Desc`)}</div>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </SettingsCard>

      <div className="flex items-center justify-between">
        {resultText && <span className="text-xs text-muted-foreground">{resultText}</span>}
        <Button onClick={onImport} disabled={importing || supportedSelected === 0}>
          {importing ? t("mcp.importing") : t("mcp.importBtn", { count: supportedSelected })}
        </Button>
      </div>
    </div>
  )
}

function McpRow({
  server,
  checked,
  onChange,
}: {
  server: CcswitchMcpServer
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="py-2">
      <label className="flex items-start gap-2 cursor-pointer">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{server.name}</div>
          <div className="text-xs text-muted-foreground">
            {server.transport ?? "stdio"}
            {server.notes && ` · ${server.notes}`}
          </div>
        </div>
      </label>
    </li>
  )
}
