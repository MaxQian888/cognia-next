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
  Loader2Icon,
  StethoscopeIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet"
import { MotionCollapse, MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
import { RollingNumber } from "@/components/settings/subagents/motion/rolling-number"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { gatewayProbeUpstream } from "@/lib/tauri/gateway"
import type { GatewayUpstreamProbeResult } from "@/types/gateway"

import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"

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

  return (
    <GatewayPanelStack>
      <GatewayPanelSection
        icon={<ActivityIcon className="size-4" />}
        title={t("serverHeading")}
        description={t("enabledHelp")}
        badge={running ? t("badgeRunning") : t("badgeStopped")}
        badgeVariant={running ? "default" : "outline"}
        action={
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
          <Alert variant="destructive">
            <AlertDescription>
              {t("strategyUnavailable", { strategy: status.routingStrategyUnavailable })}
            </AlertDescription>
          </Alert>
        ) : null}
      </GatewayPanelSection>

      <UpstreamSelfCheckSection running={running} onProbed={onRefreshStatus} />

      <GatewayPanelSection title={t("connectHeading")} description={t("connectHelp")}>
        {[
          { label: t("anthropicSnippet"), value: `ANTHROPIC_BASE_URL=${baseUrl}` },
          { label: t("openaiSnippet"), value: `OPENAI_BASE_URL=${baseUrl}/v1` },
        ].map((snippet) => (
          <div key={snippet.label} className="flex flex-col gap-1">
            <Label
              htmlFor={`gw-snippet-${snippet.label}`}
              className="text-xs text-muted-foreground"
            >
              {snippet.label}
            </Label>
            <Snippet code={snippet.value}>
              <SnippetInput id={`gw-snippet-${snippet.label}`} className="text-xs" />
              <SnippetCopyButton
                aria-label={`${t("copy")} ${snippet.label}`}
                title={t("copy")}
                onCopy={() => toast.success(t("copied"))}
                onError={(error) =>
                  toast.error(error instanceof Error ? error.message : t("copyFailed"))
                }
              />
            </Snippet>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t("authNote")}</p>
      </GatewayPanelSection>
    </GatewayPanelStack>
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
    <Item variant="muted" size="sm" data-testid={testId}>
      <ItemContent>
        <ItemDescription className="text-[11px]">{label}</ItemDescription>
        <ItemTitle className="text-sm tabular-nums">{value}</ItemTitle>
      </ItemContent>
    </Item>
  )
}

/**
 * Drives `gateway_probe_upstream`, the IPC path onto the loopback-only
 * `/healthz/upstream` route. Every row is a real, billable upstream call, so
 * this never runs on mount — only on an explicit click.
 */
function UpstreamSelfCheckSection({
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
    <GatewayPanelSection
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

      {!running ? (
        <Alert>
          <AlertDescription>{t("selfCheckNeedsRunning")}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("selfCheckBillingWarning")}</p>

      <MotionCollapse open={error !== null}>
        {error ? (
          <Alert variant="destructive" data-testid="gateway-probe-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </MotionCollapse>

      <MotionCollapse open={results !== null && results.length > 0}>
        <ItemGroup data-testid="gateway-probe-results">
          {(results ?? []).map((row) => (
            <Item
              key={`${row.providerId}-${row.modelId}`}
              role="listitem"
              size="sm"
              variant="muted"
            >
              <ItemContent className="min-w-0">
                <ItemTitle className="truncate font-mono text-xs">
                  {row.providerId} · {row.modelId}
                </ItemTitle>
                <ItemDescription className="text-xs tabular-nums">
                  {t("latencyMs", { ms: row.latencyMs })}
                </ItemDescription>
              </ItemContent>
              <MotionStatusSwap swapKey={`${row.providerId}-${row.ok}`}>
                <Badge
                  variant={row.ok ? "secondary" : "destructive"}
                  aria-label={t(row.ok ? "logFilterOk" : "logFilterErrors")}
                >
                  {row.ok ? (
                    <CheckCircle2Icon className="size-3.5" aria-hidden />
                  ) : (
                    <XCircleIcon className="size-3.5" aria-hidden />
                  )}
                  {row.status ?? t("selfCheckNoStatus")}
                </Badge>
              </MotionStatusSwap>
            </Item>
          ))}
        </ItemGroup>
      </MotionCollapse>

      {(results ?? []).some((row) => row.error) && (
        <ItemGroup>
          {(results ?? [])
            .filter((row) => row.error)
            .map((row) => (
              <Item key={`${row.providerId}-err`} role="listitem" size="sm">
                <ItemContent>
                  <ItemTitle className="font-mono text-xs">{row.providerId}</ItemTitle>
                  <ItemDescription className="line-clamp-none text-[11px]">
                    {row.error}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
        </ItemGroup>
      )}
    </GatewayPanelSection>
  )
}
