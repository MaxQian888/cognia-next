"use client"

/**
 * External Bridge Settings — full surface for the MCP server.
 *
 * Plan-path deviation: the spec called for 5 separate sub-components
 * (server-status, scope-toggles, audit-log-table, setup-instructions,
 * tab shell). For MVP we ship a single-file section because the total
 * surface is ~250 lines and splitting it now would just add ceremony.
 * Per-component split can land in Phase 2 once the UI grows.
 *
 * Sections (top-down):
 *   1. Server status + master enable toggle + bearer token
 *   2. Permission scopes (9 toggles)
 *   3. Setup instructions (per-IDE config snippets)
 *   4. Audit log (newest 50)
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CircleIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { generateToken } from "@/lib/external-bridge/token"
import { listMcpAuditLog } from "@/lib/db/mcp-audit-log"
import { getDb } from "@/lib/db/schema"
import {
  getMcpServerStatus,
  startMcpServer,
  stopMcpServer,
  type McpServerStatus,
} from "@/lib/external-bridge/tauri-control"
import { isTauri } from "@/lib/tauri"
import {
  ALL_BRIDGE_SCOPES,
  DEFAULT_EXTERNAL_BRIDGE_SETTINGS,
  type BridgeScope,
  type ExternalBridgeSettings,
} from "@/types/wiki"

/** Phase 1 disables user-repo scopes (M3 in plan). */
const PHASE_1_DISABLED_SCOPES: BridgeScope[] = ["wiki:user-repo", "rag:user-repo"]

/**
 * Default sidecar binary location. Phase 2 plugin packaging owns the real
 * distribution path; for Phase 1 we expect the user (or the dev workflow)
 * to drop a built `cognia-mcp.js` here. The Rust side surfaces a clear
 * error if the file is missing.
 */
function resolveSidecarPath(): string {
  return "${HOME}/.cognia/cognia-mcp.js"
}

/** Tiny status indicator used in the ServerStatusCard header. */
function ServerStatusBadge({ status, desktop }: { status: McpServerStatus; desktop: boolean }) {
  if (!desktop) {
    return (
      <span className="text-[10px] uppercase text-muted-foreground" title="Desktop-only">
        web
      </span>
    )
  }
  return status.running ? (
    <span className="flex items-center gap-1 text-[10px] uppercase text-emerald-500">
      <CircleIcon className="h-2 w-2 fill-current" />
      live
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
      <CircleIcon className="h-2 w-2 fill-current" />
      idle
    </span>
  )
}

const SCOPE_DESCRIPTIONS: Record<BridgeScope, string> = {
  "wiki:cognia": "Public Cognia code wiki — safe to expose.",
  "wiki:user-repo": "Wiki for user-supplied repos. Phase 3 — disabled in Phase 1.",
  "rag:cognia": "Code-level retrieval over Cognia source.",
  "rag:user-repo": "Retrieval over user-supplied repos. Phase 3 — disabled.",
  "runtime:skills": "⚠ Exposes your installed skills' content.",
  "runtime:characters": "⚠ Exposes character configs (may contain personal prompts).",
  "runtime:twins": "⚠ Exposes Twin profiles. PII redaction has run, but review before enabling.",
  "runtime:plugins": "Exposes the list and metadata of installed plugins.",
  "runtime:agent-teams": "Exposes agent-team definitions.",
}

export function ExternalBridgeSection() {
  const [settings, setSettings] = useState<ExternalBridgeSettings | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSettings()
      .then((row) => {
        if (cancelled) return
        setSettings(row.externalBridge ?? { ...DEFAULT_EXTERNAL_BRIDGE_SETTINGS })
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(async (next: ExternalBridgeSettings) => {
    setSettings(next)
    await saveSettings({ externalBridge: next })
  }, [])

  const auditRows = useLiveQuery(async () => listMcpAuditLog({ limit: 50 }), [], [])

  if (loading || !settings) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <div className="space-y-4 p-4">
      <ServerStatusCard settings={settings} onChange={persist} />
      <ScopeTogglesCard settings={settings} onChange={persist} />
      <SetupInstructionsCard settings={settings} />
      <AuditLogCard rows={auditRows ?? []} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Server status + token
// ─────────────────────────────────────────────────────────────────────────────

function ServerStatusCard({
  settings,
  onChange,
}: {
  settings: ExternalBridgeSettings
  onChange: (next: ExternalBridgeSettings) => void
}) {
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverStatus, setServerStatus] = useState<McpServerStatus>({
    running: false,
    port: null,
    startedAt: null,
  })
  const desktop = isTauri()

  // Poll the Rust HTTP server status every 3 s while the section is mounted —
  // covers external `mcp_server_stop` triggers (e.g. Tauri shutdown handler)
  // without a full page reload.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const status = await getMcpServerStatus()
        if (!cancelled) setServerStatus(status)
      } catch {
        // swallow — web mode + desktop init races both fall here
      }
      if (!cancelled) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const onToggleEnabled = useCallback(
    async (enabled: boolean) => {
      const next: ExternalBridgeSettings = { ...settings, enabled }
      // Generate a token on first enable so the HTTP transport works out of
      // the box (stdio doesn't need it but the server requires one regardless).
      if (enabled && !next.bearerToken) {
        next.bearerToken = await generateToken()
        next.tokenRotatedAt = Date.now()
      }
      onChange(next)
      // Drive the Rust HTTP server. Web mode silently no-ops via the wrapper.
      if (!desktop) return
      try {
        if (enabled) {
          const port = await startMcpServer({
            port: next.httpPort ?? 0,
            token: next.bearerToken!,
            settings: next,
            sidecarPath: resolveSidecarPath(),
          })
          onChange({ ...next, httpPort: port })
          toast.success(`MCP HTTP server listening on 127.0.0.1:${port}`)
        } else {
          await stopMcpServer()
          toast.success("MCP server stopped.")
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [settings, onChange, desktop]
  )

  const onRotateToken = useCallback(async () => {
    setBusy(true)
    try {
      const next = await generateToken()
      await onChange({ ...settings, bearerToken: next, tokenRotatedAt: Date.now() })
      toast.success("New token generated. Old token is now invalid.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [settings, onChange])

  const onCopyToken = useCallback(async () => {
    if (!settings.bearerToken) return
    await navigator.clipboard.writeText(settings.bearerToken)
    toast.success("Token copied to clipboard.")
  }, [settings.bearerToken])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <KeyRoundIcon className="h-4 w-4" />
            MCP server
            <ServerStatusBadge status={serverStatus} desktop={desktop} />
          </span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label="Enable MCP server"
          />
        </CardTitle>
        <CardDescription className="text-xs">
          {settings.enabled
            ? serverStatus.running && serverStatus.port !== null
              ? `HTTP transport listening on 127.0.0.1:${serverStatus.port}.`
              : "Stdio transport active. Tauri HTTP server is offline — toggle off and on to restart."
            : "Server is off. No external traffic accepted."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-muted-foreground">Bearer token (HTTP only)</Label>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
              {settings.bearerToken
                ? showToken
                  ? settings.bearerToken
                  : "•".repeat(16)
                : "(none)"}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowToken((s) => !s)}
              disabled={!settings.bearerToken}
            >
              {showToken ? "Hide" : "Show"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCopyToken}
              disabled={!settings.bearerToken}
              aria-label="Copy token"
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onRotateToken}
              disabled={busy}
              aria-label="Rotate token"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {settings.bearerToken && (
          <p className="text-xs text-muted-foreground">
            ⚠ Regenerating invalidates the old token immediately.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope toggles
// ─────────────────────────────────────────────────────────────────────────────

function ScopeTogglesCard({
  settings,
  onChange,
}: {
  settings: ExternalBridgeSettings
  onChange: (next: ExternalBridgeSettings) => void
}) {
  const enabledSet = useMemo(() => new Set(settings.enabledScopes), [settings.enabledScopes])

  const onToggleScope = useCallback(
    (scope: BridgeScope, enabled: boolean) => {
      if (PHASE_1_DISABLED_SCOPES.includes(scope)) return
      const next = new Set(enabledSet)
      if (enabled) next.add(scope)
      else next.delete(scope)
      onChange({ ...settings, enabledScopes: Array.from(next) })
    },
    [enabledSet, settings, onChange]
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Permission scopes</CardTitle>
        <CardDescription className="text-xs">
          Each scope is opt-in. Default install ships with only the public-code wiki scopes enabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {ALL_BRIDGE_SCOPES.map((scope) => {
          const checked = enabledSet.has(scope)
          const disabled = PHASE_1_DISABLED_SCOPES.includes(scope)
          return (
            <div
              key={scope}
              className="flex items-start justify-between gap-3 rounded border bg-card px-3 py-2"
            >
              <div className="space-y-0.5">
                <Label className="font-mono text-xs">{scope}</Label>
                <p className="text-xs text-muted-foreground">{SCOPE_DESCRIPTIONS[scope]}</p>
              </div>
              <Switch
                checked={checked}
                disabled={disabled}
                onCheckedChange={(v) => onToggleScope(scope, v)}
                aria-label={`Toggle ${scope}`}
              />
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup instructions
// ─────────────────────────────────────────────────────────────────────────────

function SetupInstructionsCard({ settings }: { settings: ExternalBridgeSettings }) {
  const [variant, setVariant] = useState<"stdio" | "http">("stdio")
  const snippet = useMemo(() => {
    if (variant === "stdio") {
      return JSON.stringify(
        {
          mcpServers: {
            cognia: { command: "node", args: ["/path/to/cognia-mcp.js"] },
          },
        },
        null,
        2
      )
    }
    const port = settings.httpPort ?? 3001
    const token = settings.bearerToken ?? "<paste-bearer-token>"
    return JSON.stringify(
      {
        mcpServers: {
          cognia: {
            transport: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    )
  }, [variant, settings.httpPort, settings.bearerToken])

  const onCopy = useCallback(async () => {
    await navigator.clipboard.writeText(snippet)
    toast.success("Snippet copied.")
  }, [snippet])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Setup snippet</CardTitle>
        <CardDescription className="text-xs">
          Paste into Claude Code / Cursor / Cline MCP config. Stdio is the most portable; HTTP
          requires the Tauri sidecar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={variant === "stdio" ? "default" : "outline"}
            onClick={() => setVariant("stdio")}
          >
            stdio
          </Button>
          <Button
            size="sm"
            variant={variant === "http" ? "default" : "outline"}
            onClick={() => setVariant("http")}
          >
            HTTP
          </Button>
          <Button size="sm" variant="ghost" onClick={onCopy} className="ml-auto">
            <CopyIcon className="h-3.5 w-3.5" /> Copy
          </Button>
        </div>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
          <code>{snippet}</code>
        </pre>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log (newest 50)
// ─────────────────────────────────────────────────────────────────────────────

function AuditLogCard({ rows }: { rows: Awaited<ReturnType<typeof listMcpAuditLog>> }) {
  const onClear = useCallback(async () => {
    await getDb().mcpAuditLog.clear()
    toast.success("Audit log cleared.")
  }, [])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-sm font-medium">Recent MCP calls</CardTitle>
          <CardDescription className="text-xs">
            Newest 50 calls. Capped at 5000 total — older rows are pruned automatically.
          </CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={rows.length === 0}>
          Clear
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No calls yet.</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Time</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[80px] text-right">Latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {new Date(row.ts).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.tool}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.scope}
                    </TableCell>
                    <TableCell>
                      {row.allowed ? (
                        <span className="text-emerald-500">OK</span>
                      ) : (
                        <span className="text-amber-500" title={row.reason}>
                          DENY
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {row.latencyMs}ms
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
