"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import Link from "next/link"
import { CircleIcon, DownloadIcon, ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { getIndexedDBTransport, IndexedDBTransport, loggers } from "@/lib/logging"
import { LogPanel } from "@/components/logging"
import { getMcpServerStatus, type McpServerStatus } from "@/lib/external-bridge/tauri-control"
import { clearMcpAuditLog, listMcpAuditLog } from "@/lib/db/mcp-audit-log"
import { downloadFile } from "@/lib/files/download"
import { defaultMcpRuntimeGateway, type McpRuntimeMetricsSnapshot } from "@/lib/mcp/runtime-gateway"
import { loadMcpOperationsSnapshot } from "@/lib/mcp/operations"
import type { McpAuditLogRow } from "@/types/wiki"

/** Rolling window for the outbound-log overview stats. */
const OVERVIEW_WINDOW_MS = 60 * 60 * 1000

interface McpLogOverview {
  servers: number
  errors: number
  total: number
}

/**
 * "Health & Logs" tab — two directions of MCP health:
 *
 * - **Outbound** (Cognia-as-MCP-client): per-server connect/error/stderr logs
 *   the sidecar produces while connecting to configured MCP servers, bridged
 *   into the unified log store (`lib/mcp/log-bridge.ts`) and rendered here via
 *   the shared `<LogPanel sources={["mcp"]} />` plus a rolling activity summary.
 * - **Inbound** (Cognia-as-MCP-server / External Bridge): the bridge server
 *   status and its request audit log.
 *
 * Desktop-only; full bridge scope configuration stays in the dedicated External
 * Bridge settings section, deep-linked from here. All data comes from existing
 * helpers.
 */
export function McpHealthTab() {
  const t = useTranslations("mcp.health")
  const desktop = isTauri()
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [rows, setRows] = useState<McpAuditLogRow[]>([])
  const [deniedOnly, setDeniedOnly] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [overview, setOverview] = useState<McpLogOverview | null>(null)
  const [runtimeMetrics, setRuntimeMetrics] = useState<McpRuntimeMetricsSnapshot>(() =>
    defaultMcpRuntimeGateway.getMetricsSnapshot()
  )
  const operations = useLiveQuery(() => loadMcpOperationsSnapshot(), [])

  useEffect(() => defaultMcpRuntimeGateway.subscribeMetrics(setRuntimeMetrics), [])

  // Manual refresh (button handler — sets the loading spinner). Not called
  // from an effect, so the synchronous setState is fine here.
  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      setStatus(await getMcpServerStatus())
    } catch (err) {
      loggers.mcp.error("health.statusFailed", err)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  // Initial status load — state is only written in the resolved callback (after
  // the await), so no synchronous setState happens inside the effect body.
  useEffect(() => {
    let cancelled = false
    getMcpServerStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err) => loggers.mcp.error("health.statusFailed", err))
    return () => {
      cancelled = true
    }
  }, [])

  // Audit log — re-fetches whenever the denied-only filter flips.
  useEffect(() => {
    let cancelled = false
    listMcpAuditLog({ deniedOnly, limit: 100 })
      .then((r) => {
        if (!cancelled) setRows(r)
      })
      .catch((err) => loggers.mcp.error("health.logFailed", err))
    return () => {
      cancelled = true
    }
  }, [deniedOnly])

  // Outbound-log activity summary over a rolling 1h window. Reads the shared
  // IndexedDB log store directly (the same store `<LogPanel>` renders), filters
  // to bridged MCP-client entries, and live-refreshes on new logs. State is
  // written only in the async callback, never synchronously in the effect body.
  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    const load = async () => {
      const transport = getIndexedDBTransport()
      if (!transport) return
      const since = new Date(Date.now() - OVERVIEW_WINDOW_MS)
      const entries = await transport.getLogs({ since, limit: 1000 })
      const mcp = entries.filter((e) => e.origin === "mcp" || e.runtime === "mcp")
      if (cancelled) return
      const servers = new Set(
        mcp.map((e) => (typeof e.data?.server === "string" ? e.data.server : e.module))
      )
      const errors = mcp.reduce(
        (n, e) => (e.level === "error" || e.level === "fatal" ? n + 1 : n),
        0
      )
      setOverview({ servers: servers.size, errors, total: mcp.length })
    }

    void load().catch((err) => loggers.mcp.error("health.overviewFailed", err))
    const unsub = IndexedDBTransport.onLogsUpdated(() => {
      void load().catch(() => {})
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [desktop])

  const handleClear = async () => {
    try {
      await clearMcpAuditLog()
      setRows([])
      toast.success(t("cleared"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleExport = async () => {
    try {
      const exported = await listMcpAuditLog({ deniedOnly })
      downloadFile(
        `cognia-mcp-audit-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(exported, null, 2),
        "application/json"
      )
      toast.success(t("exported"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const running = status?.running ?? false

  return (
    <div className="space-y-4" data-testid="mcp-health-tab">
      {/* ---- Outbound: Cognia-as-MCP-client per-server logs ---------------- */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("sectionOutbound")}
      </p>

      <Card data-testid="mcp-health-overview">
        <CardHeader className="pb-3">
          <div className="space-y-1">
            <CardTitle className="text-sm">{t("outboundTitle")}</CardTitle>
            <CardDescription className="text-xs">{t("outboundSubtitle")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {!desktop ? (
            <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="space-y-0.5">
                <p className="text-lg font-semibold tabular-nums">{overview?.servers ?? 0}</p>
                <p className="text-[11px] text-muted-foreground">{t("statServers")}</p>
              </div>
              <div className="space-y-0.5">
                <p className="text-lg font-semibold tabular-nums">{overview?.total ?? 0}</p>
                <p className="text-[11px] text-muted-foreground">{t("statLogs")}</p>
              </div>
              <div className="space-y-0.5">
                <p
                  className={cn(
                    "text-lg font-semibold tabular-nums",
                    (overview?.errors ?? 0) > 0 && "text-destructive"
                  )}
                >
                  {overview?.errors ?? 0}
                </p>
                <p className="text-[11px] text-muted-foreground">{t("statErrors")}</p>
              </div>
              <span className="text-[11px] text-muted-foreground">{t("windowNote")}</span>
              <div className="basis-full border-t pt-3" data-testid="mcp-runtime-metrics">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <Metric label={t("metricWarmReuse")} value={runtimeMetrics.warmReuses} />
                  <Metric label={t("metricCacheHits")} value={runtimeMetrics.capabilityCacheHits} />
                  <Metric label={t("metricRetries")} value={runtimeMetrics.retries} />
                  <Metric label={t("metricTimeouts")} value={runtimeMetrics.timeouts} />
                  <Metric label={t("metricDenials")} value={runtimeMetrics.policyDenials} />
                  <Metric
                    label={t("metricConnectLatency")}
                    value={
                      runtimeMetrics.successfulConnections > 0
                        ? `${Math.round(runtimeMetrics.connectionLatencyMs / runtimeMetrics.successfulConnections)}ms`
                        : "—"
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="mcp-persisted-operations">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("operationsTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("operationsSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {(operations?.servers.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{t("operationsEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] uppercase">{t("colServer")}</TableHead>
                    <TableHead className="text-right text-[10px] uppercase">
                      {t("colEvents")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase">
                      {t("colFailureRate")}
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase">
                      {t("colConnectP95")}
                    </TableHead>
                    <TableHead className="text-[10px] uppercase">{t("colCapability")}</TableHead>
                    <TableHead className="text-[10px] uppercase">{t("colLastError")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {operations?.servers.map((server) => (
                    <TableRow key={server.serverId}>
                      <TableCell className="text-[11px] font-medium">
                        {server.displayName}
                      </TableCell>
                      <TableCell className="text-right text-[11px] tabular-nums">
                        {server.events}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right text-[11px] tabular-nums",
                          server.failures > 0 && "text-destructive"
                        )}
                      >
                        {new Intl.NumberFormat(undefined, {
                          style: "percent",
                          maximumFractionDigits: 1,
                        }).format(server.failureRate)}
                      </TableCell>
                      <TableCell className="text-right text-[11px] tabular-nums">
                        {server.connectP95Ms === undefined ? "—" : `${server.connectP95Ms}ms`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                        {server.capabilityUpdatedAt
                          ? new Date(server.capabilityUpdatedAt).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">
                        {server.lastErrorCode ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium">{t("syncTitle")}</p>
            {(operations?.sync.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">{t("syncEmpty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase">{t("colAgent")}</TableHead>
                      <TableHead className="text-[10px] uppercase">{t("colStatus")}</TableHead>
                      <TableHead className="text-right text-[10px] uppercase">
                        {t("colLag")}
                      </TableHead>
                      <TableHead className="text-right text-[10px] uppercase">
                        {t("colAttempts")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {operations?.sync.map((job) => (
                      <TableRow key={job.agentId}>
                        <TableCell className="font-mono text-[11px]">{job.agentId}</TableCell>
                        <TableCell className="text-[11px]">
                          {t(`syncStatus.${job.status}`)}
                        </TableCell>
                        <TableCell className="text-right text-[11px] tabular-nums">
                          {t("syncLagValue", { seconds: Math.round(job.lagMs / 1000) })}
                        </TableCell>
                        <TableCell className="text-right text-[11px] tabular-nums">
                          {job.attempts}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="mcp-health-server-logs">
        <CardHeader className="pb-3">
          <div className="space-y-1">
            <CardTitle className="text-sm">{t("logsTitle")}</CardTitle>
            <CardDescription className="text-xs">{t("logsSubtitle")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {!desktop ? (
            <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>
          ) : (
            <LogPanel
              sources={["mcp"]}
              showStats={false}
              showTimeline={false}
              includeAgentTrace={false}
              defaultAutoRefresh
              hideToolbarPresets
              maxHeight="22rem"
            />
          )}
        </CardContent>
      </Card>

      {/* ---- Inbound: External Bridge (Cognia-as-MCP-server) --------------- */}
      <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("sectionInbound")}
      </p>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm">
                <CircleIcon
                  className={cn(
                    "size-2.5",
                    running
                      ? "fill-emerald-500 text-emerald-500"
                      : "fill-muted-foreground text-muted-foreground"
                  )}
                />
                {t("bridgeTitle")}
              </CardTitle>
              <CardDescription className="text-xs">{t("bridgeSubtitle")}</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void refreshStatus()}
              disabled={loadingStatus}
              aria-label={t("title")}
            >
              <RefreshCwIcon className={cn("size-3.5", loadingStatus && "animate-spin")} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {!desktop ? (
            <p className="text-muted-foreground">{t("desktopOnly")}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span
                className={cn(
                  "font-medium",
                  running ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                )}
              >
                {running ? t("running") : t("stopped")}
              </span>
              {status?.port != null && (
                <span className="text-muted-foreground">{t("port", { port: status.port })}</span>
              )}
              {status?.startedAt && (
                <span className="text-muted-foreground">
                  {t("startedAt", { time: new Date(status.startedAt).toLocaleString() })}
                </span>
              )}
            </div>
          )}
          <Button asChild variant="outline" size="sm" className="mt-1">
            <Link href="/settings?section=external-bridge">
              <ExternalLinkIcon className="mr-1.5 size-3.5" />
              {t("openBridgeSettings")}
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-sm">{t("auditTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("auditSubtitle")}</CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={deniedOnly}
                  onCheckedChange={(v) => setDeniedOnly(!!v)}
                  aria-label={t("deniedOnly")}
                />
                {t("deniedOnly")}
              </Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground"
                onClick={() => void handleExport()}
                disabled={rows.length === 0}
              >
                <DownloadIcon className="mr-1 size-3" />
                {t("exportLog")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => void handleClear()}
                disabled={rows.length === 0}
              >
                <Trash2Icon className="mr-1 size-3" />
                {t("clearLog")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t("auditEmpty")}</p>
          ) : (
            <div className="overflow-x-auto" data-testid="mcp-health-audit-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] uppercase">{t("colTime")}</TableHead>
                    <TableHead className="text-[10px] uppercase">{t("colTool")}</TableHead>
                    <TableHead className="text-[10px] uppercase">{t("colScope")}</TableHead>
                    <TableHead className="text-[10px] uppercase">{t("colResult")}</TableHead>
                    <TableHead className="text-right text-[10px] uppercase">
                      {t("colLatency")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                        {new Date(row.ts).toLocaleTimeString()}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{row.tool}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">
                        {row.scope}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px]",
                            row.allowed
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : "bg-destructive/10 text-destructive"
                          )}
                        >
                          {row.allowed ? t("allowed") : t("denied")}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-[11px] text-muted-foreground">
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
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  )
}
