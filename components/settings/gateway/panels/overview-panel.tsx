"use client"

/**
 * Settings → Gateway → Overview.
 *
 * The read-only face of the gateway: run state, the durable call counters, the
 * routing snapshot the listener is serving from, the client connect snippets,
 * and the upstream self-check.
 *
 * Most of what this renders already existed and was simply never shown.
 * `GatewayStatus` carries `callsTotal`, `lastCallAt`, `snapshotGeneratedAtMs`,
 * `snapshotProviderCount` and `snapshotAliasCount`; before this panel every one
 * of them appeared only in a test fixture. `/healthz/upstream` was likewise
 * fully implemented Rust-side with no caller anywhere in the app.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  CheckCircle2Icon,
  CopyIcon,
  Loader2Icon,
  StethoscopeIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse, MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { RollingNumber } from "@/components/settings/subagents/motion/rolling-number"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { gatewayProbeUpstream } from "@/lib/tauri/gateway"
import type { GatewayUpstreamProbeResult } from "@/types/gateway"

import type { GatewayPanelContext } from "../gateway-section"

export interface GatewayOverviewPanelProps {
  ctx: GatewayPanelContext
  /** True while a start/stop round-trip is in flight. */
  starting: boolean
  onToggleEnabled: (next: boolean) => Promise<void>
  onRefreshStatus: () => Promise<void>
}

export function GatewayOverviewPanel({
  ctx,
  starting,
  onToggleEnabled,
  onRefreshStatus,
}: GatewayOverviewPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, status } = ctx

  const port = status?.boundPort ?? config.port
  const baseUrl = `http://127.0.0.1:${port}`
  const running = status?.running ?? false

  const copySnippet = useCallback(
    async (value: string) => {
      await navigator.clipboard.writeText(value).catch(() => {})
      toast.success(t("copied"))
    },
    [t]
  )

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<ActivityIcon className="size-4" />}
        title={t("serverHeading")}
        description={t("enabledHelp")}
        badge={running ? t("badgeRunning") : t("badgeStopped")}
        badgeVariant={running ? "default" : "outline"}
        headerAction={
          <div className="flex items-center gap-2">
            {starting ? (
              <Loader2Icon
                className="size-3.5 animate-spin text-muted-foreground"
                data-testid="gateway-toggle-pending"
                aria-hidden
              />
            ) : null}
            <Switch
              id="gw-enabled"
              // Also disabled mid-flight: without it a double-click queues a
              // stop behind a start and the UI ends up disagreeing with Rust.
              disabled={!status?.hasToken || starting}
              checked={running}
              onCheckedChange={(next) => void onToggleEnabled(next)}
              aria-label={t("enabled")}
            />
          </div>
        }
      >
        {!status?.hasToken && <p className="text-xs text-muted-foreground">{t("requiresKey")}</p>}

        <div className="grid grid-cols-2 gap-2 @lg/gateway-pane:grid-cols-4">
          <StatTile
            label={t("statCalls")}
            value={<RollingNumber value={status?.callsTotal ?? 0} />}
            testId="gateway-stat-calls"
          />
          <StatTile
            label={t("statLastCall")}
            value={
              status?.lastCallAt ? new Date(status.lastCallAt).toLocaleTimeString() : t("statNever")
            }
            testId="gateway-stat-last-call"
          />
          <StatTile
            label={t("statProviders")}
            value={<RollingNumber value={status?.snapshotProviderCount ?? 0} />}
            testId="gateway-stat-providers"
          />
          <StatTile
            label={t("statAliases")}
            value={<RollingNumber value={status?.snapshotAliasCount ?? 0} />}
            testId="gateway-stat-aliases"
          />
        </div>

        <p className="text-xs text-muted-foreground" data-testid="gateway-snapshot-age">
          {status?.snapshotGeneratedAtMs
            ? t("snapshotGeneratedAt", {
                time: new Date(status.snapshotGeneratedAtMs).toLocaleString(),
              })
            : t("snapshotNone")}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="gateway-routing-authority">
          {status?.localRoutingEnabled
            ? t("localRoutingActive", {
                revision: status.routingPolicyRevision ?? t("routingRevisionUnavailable"),
              })
            : t("localRoutingLegacy")}
        </p>
        {status?.localRoutingEnabled && status.routingStrategy ? (
          <p className="text-xs text-muted-foreground" data-testid="gateway-auto-strategy">
            {t("autoStrategy", { strategy: status.routingStrategy })}
          </p>
        ) : null}
        {status?.routingStrategyUnavailable ? (
          <p className="text-xs text-destructive" role="alert">
            {t("strategyUnavailable", { strategy: status.routingStrategyUnavailable })}
          </p>
        ) : null}
      </SettingsCard>

      <UpstreamSelfCheckCard running={running} onProbed={onRefreshStatus} />

      <SettingsCard title={t("connectHeading")} description={t("connectHelp")}>
        {[
          { label: t("anthropicSnippet"), value: `ANTHROPIC_BASE_URL=${baseUrl}` },
          { label: t("openaiSnippet"), value: `OPENAI_BASE_URL=${baseUrl}/v1` },
        ].map((snippet) => (
          <div key={snippet.label} className="space-y-1">
            <p className="text-xs text-muted-foreground">{snippet.label}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {snippet.value}
              </code>
              <Button size="sm" variant="outline" onClick={() => void copySnippet(snippet.value)}>
                <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
                {t("copy")}
              </Button>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t("authNote")}</p>
      </SettingsCard>
    </div>
  )
}

function StatTile({
  label,
  value,
  testId,
}: {
  label: string
  value: React.ReactNode
  testId: string
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2" data-testid={testId}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/**
 * Drives `gateway_probe_upstream`, the IPC path onto the loopback-only
 * `/healthz/upstream` route. Every row is a real, billable upstream call, so
 * this never runs on mount — only on an explicit click.
 */
function UpstreamSelfCheckCard({
  running,
  onProbed,
}: {
  running: boolean
  onProbed: () => Promise<void>
}) {
  const t = useTranslations("settings.gateway")
  const [model, setModel] = useState("")
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<GatewayUpstreamProbeResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onProbe = useCallback(async () => {
    const target = model.trim()
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const rows = await gatewayProbeUpstream(target)
      setResults(rows)
      // A probe counts toward callsTotal / in-flight, so pull fresh status.
      await onProbed()
    } catch (e) {
      setResults(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [model, onProbed])

  return (
    <SettingsCard
      icon={<StethoscopeIcon className="size-4" />}
      title={t("selfCheckHeading")}
      description={t("selfCheckHelp")}
    >
      <div className="flex flex-col gap-2 @lg/gateway-pane:flex-row @lg/gateway-pane:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="gw-probe-model" className="text-xs">
            {t("selfCheckModel")}
          </Label>
          <Input
            id="gw-probe-model"
            value={model}
            placeholder={t("selfCheckModelPlaceholder")}
            className="font-mono text-xs"
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              void onProbe()
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          // Probing a stopped gateway would report against throwaway state, so
          // Rust refuses it; disable rather than surface that as an error.
          disabled={!running || busy || !model.trim()}
          onClick={() => void onProbe()}
          data-testid="gateway-probe-run"
        >
          {busy ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
          ) : (
            <StethoscopeIcon className="mr-1.5 size-3.5" aria-hidden />
          )}
          {t("selfCheckRun")}
        </Button>
      </div>

      {!running && <p className="text-xs text-muted-foreground">{t("selfCheckNeedsRunning")}</p>}
      <p className="text-xs text-muted-foreground">{t("selfCheckBillingWarning")}</p>

      <MotionCollapse open={error !== null}>
        {error ? (
          <p className="text-xs text-destructive" data-testid="gateway-probe-error">
            {error}
          </p>
        ) : null}
      </MotionCollapse>

      <MotionCollapse open={results !== null && results.length > 0}>
        <ul className="space-y-1" data-testid="gateway-probe-results">
          {(results ?? []).map((row) => (
            <li
              key={`${row.providerId}-${row.modelId}`}
              className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {row.providerId} · {row.modelId}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t("latencyMs", { ms: row.latencyMs })}
              </span>
              <MotionStatusSwap swapKey={`${row.providerId}-${row.ok}`}>
                {row.ok ? (
                  <CheckCircle2Icon className="size-3.5 text-emerald-500" aria-hidden />
                ) : (
                  <XCircleIcon className="size-3.5 text-destructive" aria-hidden />
                )}
              </MotionStatusSwap>
              <Badge variant={row.ok ? "secondary" : "destructive"} className="shrink-0">
                {row.status ?? t("selfCheckNoStatus")}
              </Badge>
            </li>
          ))}
        </ul>
      </MotionCollapse>

      {(results ?? []).some((row) => row.error) && (
        <ul className="space-y-1">
          {(results ?? [])
            .filter((row) => row.error)
            .map((row) => (
              <li key={`${row.providerId}-err`} className="text-[11px] text-muted-foreground">
                <span className="font-mono">{row.providerId}</span>: {row.error}
              </li>
            ))}
        </ul>
      )}
    </SettingsCard>
  )
}
