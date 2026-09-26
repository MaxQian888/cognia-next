"use client"

/**
 * Agent-scoped `Character.toolFilter` editor.
 *
 * `resolveSendOptions` takes the first defined filter of session → agent → app
 * and REPLACES rather than merges, so this is inherit-or-own: "inherit" writes
 * `undefined`, any mode writes a whole {@link ToolFilterConfig}. The catalog,
 * search and the source → field mapping are the ones the app-wide
 * `ToolCatalogBrowser` uses (`lib/tools/tool-catalog`), labelled from the same
 * `toolCatalog` messages; that browser saves straight into app settings, so
 * this is a controlled twin over the agent's own value.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ToolFilterConfig, ToolFilterMode } from "@cognia/agent-config-types"
import { getToolCatalog, searchToolCatalog, type ToolCatalogEntry } from "@/lib/tools/tool-catalog"
import { InheritSelect } from "./inherit-select"

const FILTER_MODES: ToolFilterMode[] = ["all", "allow", "deny"]

export interface ToolFilterOverrideProps {
  value: ToolFilterConfig | undefined
  onChange: (next: ToolFilterConfig | undefined) => void
}

export function ToolFilterOverride({ value, onChange }: ToolFilterOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.toolFilter")
  const tCatalog = useTranslations("toolCatalog")
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")

  const filtering = value !== undefined && value.mode !== "all"

  useEffect(() => {
    if (!filtering) return
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
  }, [filtering])

  const results = useMemo(() => searchToolCatalog(catalog, query), [catalog, query])

  // MCP servers and individual tools are filtered through separate code paths
  // at send time, so each selection goes into the field its source maps to.
  const selectedTools = new Set(value?.tools ?? [])
  const selectedMcp = new Set(value?.mcpServerIds ?? [])
  const isSelected = (entry: ToolCatalogEntry) =>
    entry.source === "mcp" ? selectedMcp.has(entry.id) : selectedTools.has(entry.id)

  const toggle = (entry: ToolCatalogEntry, checked: boolean) => {
    if (!value) return
    const field = entry.source === "mcp" ? "mcpServerIds" : "tools"
    const next = new Set(value[field] ?? [])
    if (checked) next.add(entry.id)
    else next.delete(entry.id)
    onChange({ ...value, [field]: [...next] })
  }

  return (
    <div className="space-y-2" data-testid="agent-override-tool-filter">
      <InheritSelect<ToolFilterMode>
        id="agent-override-tool-filter-mode"
        label={t("label")}
        description={t("description")}
        value={value?.mode}
        options={FILTER_MODES.map((mode) => ({ value: mode, label: tCatalog(`mode_${mode}`) }))}
        // Changing the mode keeps the selection, so flipping allow ↔ deny does
        // not discard the list the user built.
        onChange={(mode) => onChange(mode === undefined ? undefined : { ...value, mode })}
      />
      {filtering && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tCatalog("searchPlaceholder")}
                aria-label={tCatalog("searchPlaceholder")}
                className="h-7 pl-7 text-xs"
              />
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {tCatalog("selectedCount", { count: selectedTools.size + selectedMcp.size })}
            </Badge>
          </div>
          {loading ? (
            <p className="text-xs italic text-muted-foreground">{tCatalog("loading")}</p>
          ) : results.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">{tCatalog("noResults")}</p>
          ) : (
            <ScrollArea className="max-h-56">
              <ul className="flex flex-col gap-1">
                {results.map((entry) => (
                  <li
                    key={`${entry.source}:${entry.id}`}
                    className="flex items-center gap-2 rounded border px-2 py-1"
                  >
                    <Checkbox
                      checked={isSelected(entry)}
                      onCheckedChange={(checked) => toggle(entry, checked === true)}
                      aria-label={tCatalog("toggleTool", { tool: entry.name })}
                    />
                    <span className="flex-1 truncate font-mono text-[11px]" title={entry.id}>
                      {entry.name}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
                      {tCatalog(`source_${entry.source}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  )
}
