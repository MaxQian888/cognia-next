"use client"

/**
 * Multi-select for MCP servers with a "use character/team default" mode.
 * Distinguishing default from "no servers" matters — empty array means
 * "explicitly disable MCP" while default lets `resolveSendOptions` pick the
 * subset.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { listMcpServers } from "@/lib/db/mcp-servers"
import type { McpServer } from "@/lib/claude/types"
import type { McpPickerMode } from "./types"

export interface McpPickerProps {
  mode: McpPickerMode
  onModeChange: (next: McpPickerMode) => void
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
  /** Test seam — when provided, skips the Dexie fetch. */
  serversForTesting?: McpServer[]
  disabled?: boolean
  testId?: string
}

export function McpPicker({
  mode,
  onModeChange,
  value,
  onChange,
  serversForTesting,
  disabled,
  testId,
}: McpPickerProps) {
  const t = useTranslations("scheduler")
  const [servers, setServers] = useState<McpServer[] | null>(serversForTesting ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (serversForTesting) return
    let cancelled = false
    listMcpServers()
      .then((rows) => {
        if (!cancelled) setServers(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [serversForTesting])

  const selected = new Set(value ?? [])

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  return (
    <div className="space-y-3" data-testid={testId}>
      <RadioGroup
        value={mode}
        onValueChange={(v) => onModeChange(v as McpPickerMode)}
        className="grid grid-cols-1 sm:grid-cols-2 gap-2"
        disabled={disabled}
      >
        <label className="flex items-start gap-2 rounded-md border p-2 hover:bg-muted/40">
          <RadioGroupItem value="default" data-testid={`${testId}-mode-default`} />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("mcp.modes.default.label")}</p>
            <p className="text-xs text-muted-foreground">{t("mcp.modes.default.help")}</p>
          </div>
        </label>
        <label className="flex items-start gap-2 rounded-md border p-2 hover:bg-muted/40">
          <RadioGroupItem value="custom" data-testid={`${testId}-mode-custom`} />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("mcp.modes.custom.label")}</p>
            <p className="text-xs text-muted-foreground">{t("mcp.modes.custom.help")}</p>
          </div>
        </label>
      </RadioGroup>

      {mode === "custom" && (
        <div className="rounded-md border p-3 space-y-2">
          <Label className="text-xs text-muted-foreground">{t("mcp.serverListLabel")}</Label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!servers && !error && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("mcp.loading")}
            </p>
          )}
          {servers && servers.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("mcp.empty")}</p>
          )}
          {servers && servers.length > 0 && (
            <div className="space-y-1.5">
              {servers.map((srv) => (
                <label
                  key={srv.id}
                  className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm hover:bg-muted/40"
                >
                  <Checkbox
                    checked={selected.has(srv.id)}
                    onCheckedChange={() => toggle(srv.id)}
                    disabled={disabled || !srv.enabled}
                    data-testid={`${testId}-server-${srv.id}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {srv.name}
                      {!srv.enabled && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({t("mcp.disabledNote")})
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground font-mono">
                      {srv.transport}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
