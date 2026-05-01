"use client"

// A2UI MCP Bridge tab — controls the always-on `a2ui-bridge` MCP server
// row + its appsEnabled projection matrix. Mirrors the pattern of the
// generic `mcp-servers-section.tsx` but scoped to a single immutable
// builtin row.

import { useEffect, useState, useTransition } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, XCircleIcon, PlayCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { getDb } from "@/lib/db/schema"
import {
  A2UI_BRIDGE_SERVER_NAME,
  A2UI_BRIDGE_TOOLS,
  defaultA2UIAppsEnabled,
} from "@/lib/a2ui/mcp-tool-schemas"
import { useA2UIStore } from "@/stores/a2ui"
import { useBridgeHealth } from "@/hooks/a2ui"
import type { AgentId, McpServer } from "@/lib/claude/types"

const MANAGED_AGENTS: AgentId[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "codex",
  "gemini",
  "windsurf",
]
const READ_ONLY_AGENTS: AgentId[] = ["cline", "roo-code"]

export function McpBridgeTab() {
  const t = useTranslations("settings.a2ui.mcpBridge")
  const [row, setRow] = useState<McpServer | null>(null)
  const [pending, startTransition] = useTransition()
  const health = useBridgeHealth()
  const liveSurfaces = health.liveSurfaceCount

  useEffect(() => {
    let cancelled = false
    const db = getDb()
    db.mcpServers
      .where("name")
      .equals(A2UI_BRIDGE_SERVER_NAME)
      .first()
      .then((found) => {
        if (!cancelled) setRow(found ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patchAppsEnabled = (agent: AgentId, value: boolean) => {
    if (!row) return
    startTransition(async () => {
      const next = { ...(row.appsEnabled ?? defaultA2UIAppsEnabled()), [agent]: value }
      const db = getDb()
      const updated: McpServer = { ...row, appsEnabled: next, updatedAt: Date.now() }
      await db.mcpServers.put(updated)
      setRow(updated)
    })
  }

  const onTestConnection = () => {
    // Round-trip the in-process server: dispatch a no-op surface and remove it.
    const id = `selftest-${Date.now()}`
    const store = useA2UIStore.getState()
    store.processMessages([
      { type: "createSurface", surfaceId: id, surfaceType: "inline", title: "Self-test" },
      { type: "deleteSurface", surfaceId: id },
    ])
    toast.success(t("toast.testOk"))
  }

  if (!row) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("notSeeded")}
        </CardContent>
      </Card>
    )
  }

  const enabled = row.appsEnabled ?? {}

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {t("status.title")}
                <Badge variant="secondary">{A2UI_BRIDGE_SERVER_NAME}</Badge>
              </CardTitle>
              <CardDescription>{t("status.description")}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={onTestConnection}>
              <PlayCircleIcon className="mr-1 size-3.5" />
              {t("status.testConnection")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("status.toolsCount")}</div>
              <div className="text-base font-mono">{A2UI_BRIDGE_TOOLS.length}</div>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">{t("status.liveSurfaces")}</div>
              <div className="text-base font-mono">{liveSurfaces}</div>
            </div>
          </div>
          {health.isTauri ? (
            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div>
                <div className="text-muted-foreground">{t("status.sidecarDir")}</div>
                <div className="break-all font-mono">{health.sidecarDir ?? "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t("status.socketPath")}</div>
                <div className="break-all font-mono">{health.socketPath ?? "—"}</div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {t("status.webModeNotice")}
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("status.toolsListTitle")}</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {A2UI_BRIDGE_TOOLS.map((tool) => (
                <li key={tool.name} className="flex items-start gap-2 font-mono">
                  <CheckCircle2Icon className="mt-0.5 size-3 shrink-0 text-green-600" />
                  <span>
                    <span className="text-foreground">{tool.name}</span>
                    <span className="ml-2 text-muted-foreground">{tool.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("projection.title")}</CardTitle>
          <CardDescription>{t("projection.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {MANAGED_AGENTS.map((agent) => (
            <div
              key={agent}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div className="space-y-0.5">
                <Label htmlFor={`a2ui-bridge-${agent}`}>{agent}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("projection.agentHelp", { agent })}
                </p>
              </div>
              <Switch
                id={`a2ui-bridge-${agent}`}
                disabled={pending}
                checked={!!enabled[agent]}
                onCheckedChange={(v) => patchAppsEnabled(agent, v)}
              />
            </div>
          ))}
          {READ_ONLY_AGENTS.map((agent) => (
            <div
              key={agent}
              className="flex items-center justify-between rounded-md border px-3 py-2 opacity-60"
            >
              <div className="space-y-0.5">
                <Label>{agent}</Label>
                <p className="text-xs text-muted-foreground">{t("projection.readOnly")}</p>
              </div>
              <XCircleIcon className="size-4 text-muted-foreground" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
