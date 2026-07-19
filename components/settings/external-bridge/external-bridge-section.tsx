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
import { useTranslations } from "next-intl"
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
import { listMcpAuditLog, clearMcpAuditLog } from "@/lib/db/mcp-audit-log"
import {
  getMcpServerStatus,
  startMcpServer,
  stopMcpServer,
  type McpServerStatus,
} from "@/lib/external-bridge/tauri-control"
import { useCapability } from "@/hooks/use-host-profile"
import {
  ALL_BRIDGE_SCOPES,
  DEFAULT_EXTERNAL_BRIDGE_SETTINGS,
  type BridgeScope,
  type ExternalBridgeSettings,
} from "@/types/wiki"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { WikiRebuildCard } from "./wiki-rebuild-card"
import { WikiLintCard } from "./wiki-lint-card"

/** Phase 1 disables user-repo scopes (M3 in plan). */
const PHASE_1_DISABLED_SCOPES: BridgeScope[] = ["wiki:user-repo", "rag:user-repo"]

/**
 * Default sidecar binary location. Resolves the user's home directory via
 * Tauri's path API; falls back to a platform-agnostic default in web mode.
 */
async function resolveSidecarPath(): Promise<string> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path")
    const home = await homeDir()
    const sep = home.includes("\\") ? "\\" : "/"
    return `${home}${sep}.cognia${sep}cognia-mcp.js`
  } catch {
    // Web mode — won't be reached in practice since startMcpServer throws
    // before the sidecar path is used, but return a sensible fallback.
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "~"
    const sep = home.includes("\\") ? "\\" : "/"
    return `${home}${sep}.cognia${sep}cognia-mcp.js`
  }
}

/** Tiny status indicator used in the ServerStatusCard header. */
function ServerStatusBadge({
  status,
  hostAvailable,
}: {
  status: McpServerStatus
  hostAvailable: boolean
}) {
  const t = useTranslations("settings.externalBridge")
  if (!hostAvailable) {
    return <span className="text-[10px] uppercase text-muted-foreground">{t("badgeWeb")}</span>
  }
  return status.running ? (
    <span className="flex items-center gap-1 text-[10px] uppercase text-emerald-500">
      <CircleIcon className="h-2 w-2 fill-current" />
      {t("badgeLive")}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
      <CircleIcon className="h-2 w-2 fill-current" />
      {t("badgeIdle")}
    </span>
  )
}

function getScopeDescription(scope: BridgeScope, t: (key: string) => string): string {
  return t(`scopeDescriptions.${scope}`)
}

export function ExternalBridgeSection() {
  const t = useTranslations("settings.externalBridge")
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
    return <div className="p-4 text-sm text-muted-foreground">{t("loading")}</div>
  }

  return (
    <div className="space-y-4 p-4">
      <ServerStatusCard settings={settings} onChange={persist} />
      <ScopeTogglesCard settings={settings} onChange={persist} />
      <WikiRebuildCard />
      <WikiLintCard />
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
  const t = useTranslations("settings.externalBridge")
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rotateConfirming, setRotateConfirming] = useState(false)
  const [serverStatus, setServerStatus] = useState<McpServerStatus>({
    running: false,
    port: null,
    startedAt: null,
  })
  const hostAvailable = useCapability("mcp-runtime")

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
      if (!hostAvailable) return
      try {
        if (enabled) {
          const port = await startMcpServer({
            port: next.httpPort ?? 0,
            token: next.bearerToken!,
            settings: next,
            sidecarPath: await resolveSidecarPath(),
          })
          onChange({ ...next, httpPort: port })
          toast.success(t("server.toastServerStarted", { port }))
        } else {
          await stopMcpServer()
          toast.success(t("server.toastServerStopped"))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [settings, onChange, hostAvailable, t]
  )

  const onRotateToken = useCallback(async () => {
    setRotateConfirming(false)
    setBusy(true)
    try {
      const next = await generateToken()
      await onChange({ ...settings, bearerToken: next, tokenRotatedAt: Date.now() })
      toast.success(t("server.toastTokenRegenerated"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [settings, onChange, t])

  const onCopyToken = useCallback(async () => {
    if (!settings.bearerToken) return
    await navigator.clipboard.writeText(settings.bearerToken)
    toast.success(t("server.toastTokenCopied"))
  }, [settings.bearerToken, t])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <KeyRoundIcon className="h-4 w-4" />
            {t("server.title")}
            <ServerStatusBadge status={serverStatus} hostAvailable={hostAvailable} />
          </span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label={t("server.toggleAriaLabel")}
          />
        </CardTitle>
        <CardDescription className="text-xs">
          {settings.enabled
            ? serverStatus.running && serverStatus.port !== null
              ? t("server.statusHttpListening", { port: serverStatus.port })
              : t("server.statusStdioActive")
            : t("server.statusOff")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Label className="text-muted-foreground">{t("server.bearerTokenLabel")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs break-all">
              {settings.bearerToken
                ? showToken
                  ? settings.bearerToken
                  : "•".repeat(16)
                : t("server.tokenNone")}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowToken((s) => !s)}
              disabled={!settings.bearerToken}
            >
              {showToken ? t("server.hide") : t("server.show")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCopyToken}
              disabled={!settings.bearerToken}
              aria-label={t("server.copyTokenAria")}
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRotateConfirming(true)}
              disabled={busy || !settings.bearerToken}
              aria-label={t("server.rotateTokenAria")}
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {settings.bearerToken && (
          <p className="text-xs text-muted-foreground">{t("server.regenerateWarning")}</p>
        )}
      </CardContent>
      <AlertDialog open={rotateConfirming} onOpenChange={setRotateConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("server.rotateConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("server.rotateConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("server.rotateConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onRotateToken}>
              {t("server.rotateConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const tScope = useTranslations("settings.externalBridge")
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
        <CardTitle className="text-sm font-medium">{tScope("scopes.title")}</CardTitle>
        <CardDescription className="text-xs">{tScope("scopes.description")}</CardDescription>
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
                <p className="text-xs text-muted-foreground">
                  {getScopeDescription(scope, tScope)}
                </p>
              </div>
              <Switch
                checked={checked}
                disabled={disabled}
                onCheckedChange={(v) => onToggleScope(scope, v)}
                aria-label={tScope("scopes.toggleAria", { scope })}
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

type SetupVariant = "claude-desktop-stdio" | "claude-desktop-http" | "cursor" | "goose"

const SETUP_VARIANTS: SetupVariant[] = [
  "claude-desktop-stdio",
  "claude-desktop-http",
  "cursor",
  "goose",
]

function SetupInstructionsCard({ settings }: { settings: ExternalBridgeSettings }) {
  const t = useTranslations("settings.externalBridge")
  const [variant, setVariant] = useState<SetupVariant>("claude-desktop-stdio")

  const snippet = useMemo(() => {
    const port = settings.httpPort ?? 3001
    const token = settings.bearerToken ?? "<paste-bearer-token>"

    switch (variant) {
      case "claude-desktop-stdio":
        return JSON.stringify(
          {
            mcpServers: {
              cognia: { command: "node", args: ["/path/to/cognia-mcp.js"] },
            },
          },
          null,
          2
        )
      case "claude-desktop-http":
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
      case "cursor":
        // Cursor's mcp.json mirrors Claude Desktop's mcpServers but lives at
        // ~/.cursor/mcp.json (or .cursor/mcp.json in-project). The shape is
        // identical to Claude Desktop's HTTP form when targeting our bridge.
        return JSON.stringify(
          {
            mcpServers: {
              cognia: {
                url: `http://127.0.0.1:${port}/mcp`,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2
        )
      case "goose":
        // Goose uses YAML under ~/.config/goose/config.yaml. Single MCP entry
        // tied to the HTTP transport so the operator doesn't have to install
        // a sidecar wrapper script.
        return [
          "extensions:",
          "  cognia:",
          "    type: streamable_http",
          `    uri: http://127.0.0.1:${port}/mcp`,
          "    headers:",
          `      Authorization: "Bearer ${token}"`,
        ].join("\n")
    }
  }, [variant, settings.httpPort, settings.bearerToken])

  const onCopy = useCallback(async () => {
    await navigator.clipboard.writeText(snippet)
    toast.success(t("setup.toastCopied"))
  }, [snippet, t])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("setup.title")}</CardTitle>
        <CardDescription className="text-xs">{t("setup.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={variant} onValueChange={(v) => setVariant(v as SetupVariant)}>
            <SelectTrigger className="w-full sm:w-[260px]" aria-label={t("setup.clientLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETUP_VARIANTS.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`setup.variants.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCopy}
            className="sm:ml-auto"
            aria-label={t("setup.copyAria")}
          >
            <CopyIcon className="h-3.5 w-3.5" /> {t("setup.copy")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(`setup.variantHelp.${variant}`)}</p>
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
  const t = useTranslations("settings.externalBridge")
  const [confirming, setConfirming] = useState(false)
  const onClear = useCallback(async () => {
    setConfirming(false)
    try {
      await clearMcpAuditLog()
      toast.success(t("audit.toastCleared"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [t])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-sm font-medium">{t("audit.title")}</CardTitle>
          <CardDescription className="text-xs">{t("audit.description")}</CardDescription>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(true)}
          disabled={rows.length === 0}
          aria-label={t("audit.clearAria")}
        >
          {t("audit.clear")}
        </Button>
      </CardHeader>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("audit.clearConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("audit.clearConfirmDesc", { count: rows.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("audit.clearCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onClear}>{t("audit.clearConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("audit.empty")}</p>
        ) : (
          <div className="max-h-[300px] overflow-x-auto overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px] whitespace-nowrap">{t("audit.time")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("audit.tool")}</TableHead>
                  <TableHead className="whitespace-nowrap">{t("audit.scope")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap">{t("audit.status")}</TableHead>
                  <TableHead className="w-[80px] whitespace-nowrap text-right">
                    {t("audit.latency")}
                  </TableHead>
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
                        <span className="text-emerald-500">{t("audit.statusOk")}</span>
                      ) : (
                        <span className="text-amber-500" title={row.reason}>
                          {t("audit.statusDeny")}
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
