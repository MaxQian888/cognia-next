import React, { useState } from "react"
import { ToolBrowser } from "./ToolBrowser"
import { useCliTranslations } from "../i18n"
import type { McpPanelTool } from "../runtime/mcp-panel-model"

export interface McpToolsPanelProps {
  server: string
  tools: McpPanelTool[]
  onToggle: (toolName: string, enabled: boolean) => void
  onBack: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}
export function McpToolsPanel({
  server,
  tools,
  onToggle,
  onBack,
  isActive,
  maxRows,
  width,
}: McpToolsPanelProps) {
  const t = useCliTranslations("cliUiCommon")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const entries = tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description ?? "",
    source: server,
    enabled: overrides[tool.name] ?? tool.enabled,
    detail: tool.inputSchema
      ? `## ${t("toolsBrowser.schema")}\n\n\x60\x60\x60json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\x60\x60\x60`
      : t("toolsBrowser.schemaUnknown"),
  }))
  return (
    <ToolBrowser
      title={t("toolsBrowser.mcpTitle", {
        server,
        enabled: entries.filter((entry) => entry.enabled).length,
        total: entries.length,
      })}
      entries={entries}
      width={width}
      maxRows={maxRows}
      isActive={isActive}
      onClose={onBack}
      onToggle={(entry) => {
        const enabled = !entry.enabled
        onToggle(entry.name, enabled)
        setOverrides((current) => ({ ...current, [entry.id]: enabled }))
      }}
    />
  )
}
