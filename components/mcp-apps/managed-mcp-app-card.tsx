"use client"

import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { openExternal } from "@/lib/tauri/opener"
import {
  callMcpAppTool,
  getMcpAppToolRisk,
  loadMcpAppForTool,
  promoteMcpAppDownload,
  type LoadedMcpApp,
} from "@/lib/mcp/apps-runtime"
import type { McpAppApprovals } from "@/lib/mcp/apps-sandbox"
import type { McpResultBlock } from "@/lib/claude/parts-extensions"
import { McpAppFrame } from "./mcp-app-frame"

const CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const
const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const

export interface ManagedMcpAppCardProps {
  part: ToolUIPart
  namespacedToolName: string
  sessionId: string
  blocks?: McpResultBlock[]
}

export function ManagedMcpAppCard({
  part,
  namespacedToolName,
  sessionId,
  blocks,
}: ManagedMcpAppCardProps) {
  const t = useTranslations("mcpApps")
  const [app, setApp] = useState<LoadedMcpApp>()
  const [loadError, setLoadError] = useState(false)
  const [approved, setApproved] = useState<Set<string>>(() => new Set())
  const [quarantine, setQuarantine] = useState<unknown[][]>([])

  useEffect(() => {
    let disposed = false
    void loadMcpAppForTool(namespacedToolName, sessionId)
      .then((loaded) => {
        if (!disposed) setApp(loaded)
      })
      .catch(() => {
        if (!disposed) setLoadError(true)
      })
    return () => {
      disposed = true
    }
  }, [namespacedToolName, sessionId])

  const requested = useMemo(() => requestedApprovals(app?.csp, app?.permissions), [app])
  const allApproved = requested.every((entry) => approved.has(entry.id))
  const approvals = useMemo(
    () => (app && allApproved ? approveAll(app.csp, app.permissions) : {}),
    [allApproved, app]
  )

  const authorizeToolCall = useCallback(
    (request: { name: string }) => {
      if (!app) return false
      const risk = getMcpAppToolRisk(app.server, request.name)
      const first = window.confirm(
        t("confirmToolCall", { server: app.server.name, tool: request.name, risk })
      )
      if (!first || risk !== "destructive") return first
      return window.confirm(t("confirmDestructiveToolCall", { tool: request.name }))
    },
    [app, t]
  )
  const callTool = useCallback(
    async (request: { name: string; arguments?: Record<string, unknown> }) => {
      if (!app) return { isError: true, content: [] }
      return callMcpAppTool({
        serverId: app.server.id,
        toolName: request.name,
        args: request.arguments,
        scopeId: sessionId,
      })
    },
    [app, sessionId]
  )
  const confirmOpenLink = useCallback(
    (request: { hostname: string }) => window.confirm(t("confirmOpenLink", request)),
    [t]
  )
  const confirmDownload = useCallback(() => window.confirm(t("confirmDownload")), [t])
  const quarantineDownload = useCallback((contents: unknown[]) => {
    setQuarantine((current) => [...current, contents])
  }, [])

  if (!app) {
    return loadError ? (
      <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
        {t("resourceError")}
      </div>
    ) : null
  }

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="managed-mcp-app">
      <div className="text-xs text-muted-foreground">
        {t("provenance", { server: app.server.name, uri: app.resourceUri })}
      </div>
      {!allApproved ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("reviewTitle")}</p>
          {requested.map((entry) => (
            <label key={entry.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={approved.has(entry.id)}
                onCheckedChange={(checked) =>
                  setApproved((current) => {
                    const next = new Set(current)
                    if (checked === true) next.add(entry.id)
                    else next.delete(entry.id)
                    return next
                  })
                }
                aria-label={entry.label}
              />
              <span>{entry.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <McpAppFrame
          html={app.html}
          csp={app.csp}
          permissions={app.permissions}
          approvals={approvals}
          provenance={{
            serverId: app.server.id,
            serverName: app.server.name,
            resourceUri: app.resourceUri,
          }}
          toolInput={isRecord(part.input) ? part.input : undefined}
          toolResult={{
            content: blocks ?? [],
            structuredContent: isRecord(part.output) ? part.output : undefined,
          }}
          authorizeToolCall={authorizeToolCall}
          callTool={callTool}
          confirmOpenLink={confirmOpenLink}
          openLink={openExternal}
          confirmDownload={confirmDownload}
          quarantineDownload={quarantineDownload}
        />
      )}
      {quarantine.map((contents, index) => (
        <div key={index} className="flex items-center justify-between gap-2 rounded border p-2">
          <span className="text-xs">{t("quarantinedDownload", { count: contents.length })}</span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void promoteMcpAppDownload(app.server, sessionId, contents).then((saved) => {
                  if (saved > 0) {
                    setQuarantine((current) =>
                      current.filter((_, candidate) => candidate !== index)
                    )
                  }
                })
              }}
            >
              {t("saveDownload")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setQuarantine((current) => current.filter((_, candidate) => candidate !== index))
              }
            >
              {t("discardDownload")}
            </Button>
          </div>
        </div>
      ))}
    </section>
  )
}

function requestedApprovals(
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions
): Array<{ id: string; label: string }> {
  const entries: Array<{ id: string; label: string }> = []
  for (const key of CSP_KEYS) {
    for (const origin of csp?.[key] ?? []) {
      entries.push({ id: `origin:${key}:${origin}`, label: `${key}: ${origin}` })
    }
  }
  for (const key of PERMISSION_KEYS) {
    if (permissions?.[key]) entries.push({ id: `permission:${key}`, label: key })
  }
  return entries
}

function approveAll(
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions
): McpAppApprovals {
  return {
    origins: Object.fromEntries(CSP_KEYS.map((key) => [key, csp?.[key] ?? []])),
    permissions: Object.fromEntries(
      PERMISSION_KEYS.map((key) => [key, Boolean(permissions?.[key])])
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
