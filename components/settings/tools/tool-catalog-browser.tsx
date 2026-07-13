"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { useSettingsStore } from "@/stores/settings/settings-store"
import type { ToolFilterConfig, ToolFilterMode } from "@cognia/agent-config-types"
import {
  getToolCatalog,
  searchToolCatalog,
  type ToolCatalogEntry,
  type ToolRiskLevel,
  type ToolSource,
} from "@/lib/tools/tool-catalog"

const ALL_SOURCES: ToolSource[] = ["builtin", "mcp", "plugin", "native-anthropic"]
const ALL_RISKS: ToolRiskLevel[] = ["low", "medium", "high"]
const FILTER_MODES: ToolFilterMode[] = ["all", "allow", "deny"]

/**
 * Unified tool/MCP search + filter browser. Aggregates every tool source via
 * `getToolCatalog()` and lets the user build a global allow/deny
 * {@link ToolFilterConfig} (persisted to `AppSettings.toolFilter`). Mirrors the
 * Codex `enabled_tools`/deny model and the Hermes `tools` switches, but over a
 * single searchable catalog.
 *
 * Resolution: `resolveSendOptions` applies the saved filter (global → character
 * → session) after the existing allow/deny union; `deny` always wins.
 */
export function ToolCatalogBrowser() {
  const t = useTranslations("toolCatalog")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [sourceFilter, setSourceFilter] = useState<ToolSource | "all">("all")
  const [riskFilter, setRiskFilter] = useState<ToolRiskLevel | "all">("all")

  const filter: ToolFilterConfig = settings?.toolFilter ?? { mode: "all" }
  // MCP servers and individual tools live in distinct fields of ToolFilterConfig
  // (`mcpServerIds` vs `tools`) because `resolveSendOptions` filters them through
  // separate code paths. The browser must write each entry into the field its
  // source maps to, or the selection is silently ignored at send time.
  const selectedTools = useMemo(() => new Set(filter.tools ?? []), [filter.tools])
  const selectedMcp = useMemo(() => new Set(filter.mcpServerIds ?? []), [filter.mcpServerIds])
  const isSelected = (entry: ToolCatalogEntry) =>
    entry.source === "mcp" ? selectedMcp.has(entry.id) : selectedTools.has(entry.id)
  const selectedCount = selectedTools.size + selectedMcp.size

  useEffect(() => {
    let alive = true
    getToolCatalog()
      .then((entries) => {
        if (alive) setCatalog(entries)
      })
      .catch(() => {
        if (alive) setCatalog([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const results = useMemo(
    () =>
      searchToolCatalog(catalog, query, {
        sources: sourceFilter === "all" ? undefined : [sourceFilter],
        riskLevels: riskFilter === "all" ? undefined : [riskFilter],
      }),
    [catalog, query, sourceFilter, riskFilter]
  )

  async function setMode(mode: ToolFilterMode) {
    await save({ toolFilter: { ...filter, mode } })
  }

  async function toggleTool(entry: ToolCatalogEntry, checked: boolean) {
    if (entry.source === "mcp") {
      const next = new Set(selectedMcp)
      if (checked) next.add(entry.id)
      else next.delete(entry.id)
      await save({ toolFilter: { ...filter, mcpServerIds: [...next] } })
    } else {
      const next = new Set(selectedTools)
      if (checked) next.add(entry.id)
      else next.delete(entry.id)
      await save({ toolFilter: { ...filter, tools: [...next] } })
    }
  }

  const filteringActive = filter.mode !== "all"

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filter mode selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("modeLabel")}</span>
          <Select value={filter.mode} onValueChange={(v) => void setMode(v as ToolFilterMode)}>
            <SelectTrigger className="h-7 w-[160px] text-xs" aria-label={t("modeLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTER_MODES.map((m) => (
                <SelectItem key={m} value={m} className="text-xs">
                  {t(`mode_${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filteringActive && (
            <Badge variant="secondary" className="text-[10px]">
              {t("selectedCount", { count: selectedCount })}
            </Badge>
          )}
        </div>

        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <SearchIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-7 pl-7 text-xs"
              aria-label={t("searchPlaceholder")}
            />
          </div>
          <Select
            value={sourceFilter}
            onValueChange={(v) => setSourceFilter(v as ToolSource | "all")}
          >
            <SelectTrigger className="h-7 w-[130px] text-xs" aria-label={t("sourceLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                {t("sourceAll")}
              </SelectItem>
              {ALL_SOURCES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {t(`source_${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={riskFilter}
            onValueChange={(v) => setRiskFilter(v as ToolRiskLevel | "all")}
          >
            <SelectTrigger className="h-7 w-[120px] text-xs" aria-label={t("riskLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                {t("riskAll")}
              </SelectItem>
              {ALL_RISKS.map((r) => (
                <SelectItem key={r} value={r} className="text-xs">
                  {t(`risk_${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Results */}
        {loading ? (
          <div className="text-xs text-muted-foreground italic">{t("loading")}</div>
        ) : results.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">{t("noResults")}</div>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="flex flex-col gap-1">
              {results.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 rounded border px-2 py-1.5">
                  <Checkbox
                    checked={isSelected(entry)}
                    disabled={!filteringActive}
                    onCheckedChange={(c) => void toggleTool(entry, c === true)}
                    aria-label={t("toggleTool", { tool: entry.name })}
                  />
                  <span className="font-mono text-[11px] truncate flex-1" title={entry.id}>
                    {entry.name}
                  </span>
                  <Badge variant="outline" className="text-[9px] uppercase shrink-0">
                    {t(`source_${entry.source}`)}
                  </Badge>
                  {entry.riskLevel && (
                    <Badge variant="outline" className="text-[9px] uppercase shrink-0">
                      {t(`risk_${entry.riskLevel}`)}
                    </Badge>
                  )}
                  {!entry.enabled && (
                    <Badge variant="secondary" className="text-[9px] shrink-0">
                      {t("disabled")}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

export default ToolCatalogBrowser
