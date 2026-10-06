"use client"

import { useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertCircleIcon,
  ChevronDownIcon,
  LogOutIcon,
  MessageCircleIcon,
  RefreshCwIcon,
} from "lucide-react"

import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import { DiscoverHelp } from "./discover-help"
import { NotificationPermissionCta } from "@/components/mobile/notifications/notification-permission-cta"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBiometricBlockReason } from "@/hooks/use-biometric-block-reason"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import { usePlatform } from "@/hooks/use-platform"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { companionCredentialBook } from "@/lib/companion/credential-book"
import { removeCompanionHost } from "@/lib/companion/host-removal"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { transport } from "@/lib/tauri"
import { formatRelative } from "@cognia/time"
import { cn } from "@/lib/utils"

const SMOKE_RPC = "claude_sidecar_status"
const SMOKE_WS_CHANNEL = "claude://session-event"

type HealthState = "live" | "checking" | "offline"

interface SmokeResults {
  rpc: unknown
  ws: unknown
}

export interface PairedStepProps {
  baseUrl: string
  deviceId: string
  serverVersion: string
  onContinue: () => void | Promise<void>
  /** Fires after the storage is cleared and the user passed the biometric guard. */
  onAfterSignOut: () => void
}

export function PairedStep({
  baseUrl,
  deviceId,
  serverVersion,
  onContinue,
  onAfterSignOut,
}: PairedStepProps) {
  const t = useTranslations("mobile.pair")
  const guard = useBiometricGuard()
  const blockReason = useBiometricBlockReason()
  // Settings → Security → "Require biometrics to sign out". `useCompanionSignOut`
  // has always honoured this flag; this second sign-out path prompted
  // unconditionally, so switching the row off silently only worked on one of
  // the two surfaces that sign a companion out.
  const requireBiometricForSignOut =
    useSettingsStore((s) => s.settings?.biometricRequiredFor?.signOut) ??
    DEFAULT_BIOMETRIC_GUARD.signOut
  const platform = usePlatform()

  const [lastHeartbeatMs, setLastHeartbeatMs] = useState<number>(() => Date.now())
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [healthState, setHealthState] = useState<HealthState>("live")
  const [healthError, setHealthError] = useState<string | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [smoke, setSmoke] = useState<SmokeResults>({ rpc: undefined, ws: undefined })
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const onRefresh = useCallback(async () => {
    setHealthState("checking")
    setHealthError(null)
    const startedAt = Date.now()
    try {
      await transport.call(SMOKE_RPC)
      setLastHeartbeatMs(Date.now())
      setLatencyMs(Date.now() - startedAt)
      setHealthState("live")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setHealthState("offline")
      setHealthError(message)
    }
  }, [])

  const onCallSmoke = useCallback(async () => {
    const startedAt = Date.now()
    try {
      const payload = await transport.call(SMOKE_RPC)
      setSmoke((prev) => ({ ...prev, rpc: payload }))
      setLastHeartbeatMs(Date.now())
      setLatencyMs(Date.now() - startedAt)
      setHealthState("live")
      setHealthError(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSmoke((prev) => ({ ...prev, rpc: { error: message } }))
      setHealthState("offline")
      setHealthError(message)
    }
  }, [])

  const onSubscribeSmoke = useCallback(() => {
    let lastFrame: unknown = null
    const unsub = transport.subscribe(SMOKE_WS_CHANNEL, (payload) => {
      lastFrame = payload
      setSmoke((prev) => ({ ...prev, ws: payload }))
    })
    setTimeout(() => {
      unsub()
      setSmoke((prev) => ({
        ...prev,
        ws: prev.ws ?? lastFrame ?? "(no frame within 5s — connection alone counts as smoke)",
      }))
    }, 5000)
  }, [])

  const onSignOut = useCallback(async () => {
    setSignOutError(null)
    const performSignOut = async () => {
      const accountId =
        getActiveRuntimeTargetContext()?.accountId ??
        (platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : null)
      if (!accountId) throw new Error(t("accountContextMissing"))
      const book = companionCredentialBook()
      const [active, hosts] = await Promise.all([book.getActive(accountId), book.list(accountId)])
      if (!active) return
      const alternatives = hosts.filter((host) => host.hostId !== active.hostId)
      let fallbackHostId: string | undefined
      if (alternatives.length > 0) {
        const choices = alternatives.map((host) => host.hostId).join(", ")
        const selected = window.prompt(
          t("signOutFallbackPrompt", { choices }),
          alternatives[0].hostId
        )
        if (!selected) throw new Error(t("signOutFallbackRequired"))
        if (!alternatives.some((host) => host.hostId === selected)) {
          throw new Error(t("signOutFallbackInvalid"))
        }
        fallbackHostId = selected
      }
      await removeCompanionHost({
        accountId,
        hostId: active.hostId,
        platform: platform === "web" ? "web" : "mobile",
        ...(fallbackHostId ? { fallbackHostId } : {}),
      })
    }

    if (!requireBiometricForSignOut) {
      try {
        await performSignOut()
      } catch (err) {
        setSignOutError(err instanceof Error ? err.message : String(err))
        return
      }
      onAfterSignOut()
      return
    }

    const out = await guard(
      {
        reason: t("signOutReason"),
        title: t("signOutTitle"),
        description: t("signOutDescription"),
      },
      performSignOut
    )
    if (out.kind === "blocked") {
      if (out.reason !== "cancelled") {
        setSignOutError(t("biometricFailed", { reason: blockReason(out.reason) }))
      }
      return
    }
    onAfterSignOut()
  }, [blockReason, guard, onAfterSignOut, platform, requireBiometricForSignOut, t])

  // Explicit label — `constructor.name` gets mangled by production minifiers.
  // Duck-typed on `onTierChange` (CompanionTransport-only) like the
  // connection-state badge, so partially-mocked transports stay safe.
  const transportName =
    typeof (transport as { onTierChange?: unknown }).onTierChange === "function"
      ? "CompanionTransport"
      : "TauriTransport"

  // One flat column, no cards: the live status leads, then a hairline list of
  // secondary rows (diagnostics, help, sign-out). Stacked cards spent a third
  // of a phone screen on frames and padding around four short blocks.
  return (
    <section className="flex flex-col gap-6" data-testid="pair-paired-step">
      <ConnectionHealth
        baseUrl={baseUrl}
        deviceId={deviceId}
        serverVersion={serverVersion}
        healthState={healthState}
        healthError={healthError}
        lastHeartbeatMs={lastHeartbeatMs}
        latencyMs={latencyMs}
        onRefresh={() => void onRefresh()}
        onContinue={onContinue}
        t={t}
      />
      {/* Wave 4.x — surface the local-notifications permission CTA only on
          Capacitor where it can actually do something. `checkPermission`
          returns `unsupported` on web/Tauri so the component renders null,
          but this guard avoids spinning up the dynamic import there. */}
      <NotificationPermissionCta />
      <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
        <DiagnosticsRow
          open={diagnosticsOpen}
          onOpenChange={setDiagnosticsOpen}
          smoke={smoke}
          onCallSmoke={() => void onCallSmoke()}
          onSubscribeSmoke={onSubscribeSmoke}
          t={t}
        />
        <DiscoverHelp flush />
        <div className="flex flex-col gap-2 py-1">
          <Button
            type="button"
            variant="ghost"
            className="touch-target h-auto w-full items-start justify-start gap-3 px-0 py-2.5 text-left font-normal whitespace-normal text-destructive hover:bg-transparent hover:text-destructive"
            onClick={() => void onSignOut()}
            data-testid="pair-signout"
          >
            <LogOutIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{t("signOut.cta")}</span>
              <span className="text-xs text-muted-foreground">{t("signOut.cardDescription")}</span>
            </span>
          </Button>
          {signOutError ? (
            <Alert variant="destructive" className="mb-2" data-testid="pair-signout-error">
              <AlertCircleIcon />
              <AlertDescription>{signOutError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
      <p className="text-center text-[11px] text-muted-foreground/80">
        {t("transportLabel")}: <code className="font-mono">{transportName}</code>
      </p>
    </section>
  )
}

type Translator = ReturnType<typeof useTranslations>

interface ConnectionHealthProps {
  baseUrl: string
  deviceId: string
  serverVersion: string
  healthState: HealthState
  healthError: string | null
  lastHeartbeatMs: number
  latencyMs: number | null
  onRefresh: () => void
  onContinue: () => void | Promise<void>
  t: Translator
}

function ConnectionHealth({
  baseUrl,
  deviceId,
  serverVersion,
  healthState,
  healthError,
  lastHeartbeatMs,
  latencyMs,
  onRefresh,
  onContinue,
  t,
}: ConnectionHealthProps) {
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const continueToChat = async () => {
    setContinuing(true)
    setContinueError(null)
    try {
      await onContinue()
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err))
    } finally {
      setContinuing(false)
    }
  }
  const dotClass =
    healthState === "live"
      ? "bg-emerald-500"
      : healthState === "checking"
        ? "bg-amber-500 animate-pulse"
        : "bg-destructive"
  const titleKey =
    healthState === "live"
      ? "connectedTitle"
      : healthState === "checking"
        ? "checkingTitle"
        : "offlineTitle"
  const subtitleKey = healthState === "offline" ? "offlineSubtitle" : "connectedSubtitle"
  const badgeKey =
    healthState === "live"
      ? "health.live"
      : healthState === "checking"
        ? "health.checking"
        : "health.offline"
  return (
    <div className="flex flex-col gap-4" data-testid="pair-health-card" data-health={healthState}>
      <div className="flex items-start gap-3">
        <span className="relative mt-1.5 flex size-2.5 shrink-0" aria-hidden="true">
          {healthState === "live" ? (
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60 motion-reduce:hidden" />
          ) : null}
          <span className={cn("relative size-2.5 rounded-full", dotClass)} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-base font-semibold leading-tight">{t(titleKey)}</p>
          <p className="text-sm text-muted-foreground">{t(subtitleKey)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ConnectionStateBadge />
          <Badge variant="outline" className="text-[10px] uppercase">
            {t(badgeKey)}
          </Badge>
        </div>
      </div>
      <dl
        className="flex flex-col divide-y divide-border/60 border-y border-border/60 text-sm"
        data-testid="pair-status"
      >
        <StatusRow label={t("health.device")}>
          <span className="break-all font-mono text-xs">{deviceId}</span>
        </StatusRow>
        <StatusRow label={t("health.server")}>
          <span className="break-all font-mono text-xs">{baseUrl}</span>{" "}
          <span className="text-xs text-muted-foreground">v{serverVersion}</span>
        </StatusRow>
        <StatusRow label={t("health.lastHeartbeat")}>
          {healthState === "checking" ? (
            // Single source of "in flight" feedback is the pulsing status
            // dot in the header — no second spinner here.
            <span className="text-muted-foreground">{t("health.checking")}</span>
          ) : (
            formatRelative(lastHeartbeatMs)
          )}
        </StatusRow>
        <StatusRow label={t("health.latency")}>
          <span className="tabular-nums">
            {latencyMs !== null ? `${latencyMs}ms` : t("health.noHeartbeat")}
          </span>
        </StatusRow>
      </dl>
      {healthError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{healthError}</AlertDescription>
        </Alert>
      ) : null}
      {continueError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{continueError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button
          type="button"
          variant="outline"
          className="touch-target"
          onClick={onRefresh}
          disabled={healthState === "checking"}
          data-testid="pair-refresh"
        >
          <RefreshCwIcon
            className={cn("size-4", healthState === "checking" && "animate-spin")}
            aria-hidden="true"
          />
          {t("health.refresh")}
        </Button>
        <Button
          type="button"
          className="touch-target"
          onClick={() => void continueToChat()}
          disabled={continuing}
          aria-busy={continuing}
          data-testid="pair-continue-cta"
        >
          <MessageCircleIcon className="size-4" aria-hidden="true" />
          {t("health.continueToChat")}
        </Button>
      </div>
    </div>
  )
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

interface DiagnosticsRowProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  smoke: SmokeResults
  onCallSmoke: () => void
  onSubscribeSmoke: () => void
  t: Translator
}

function DiagnosticsRow({
  open,
  onOpenChange,
  smoke,
  onCallSmoke,
  onSubscribeSmoke,
  t,
}: DiagnosticsRowProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="touch-target h-auto w-full items-center justify-between gap-2 px-0 py-3 font-normal hover:bg-transparent"
          data-testid="pair-diagnostics-toggle"
        >
          <span className="flex items-center gap-3 text-sm font-medium">
            <ActivityIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("diagnostics.title")}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
          <span className="sr-only">
            {open ? t("diagnostics.collapse") : t("diagnostics.expand")}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pb-4">
          <p className="text-xs text-muted-foreground">{t("diagnostics.subtitle")}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="touch-target w-full"
              onClick={onCallSmoke}
              data-testid="smoke-call"
            >
              {t("diagnostics.testRpc")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="touch-target w-full"
              onClick={onSubscribeSmoke}
              data-testid="smoke-ws"
            >
              {t("diagnostics.testWs")}
            </Button>
          </div>

          <DiagnosticPanel
            label={t("diagnostics.rpcResultLabel")}
            value={smoke.rpc}
            waitingLabel={t("diagnostics.rpcWaiting")}
            testid="smoke-call-result"
          />
          <DiagnosticPanel
            label={t("diagnostics.wsResultLabel")}
            value={smoke.ws}
            waitingLabel={t("diagnostics.wsWaiting")}
            testid="smoke-ws-result"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function DiagnosticPanel({
  label,
  value,
  waitingLabel,
  testid,
}: {
  label: string
  value: unknown
  waitingLabel: string
  testid: string
}) {
  const has = value !== undefined
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {has ? (
        <ScrollArea className="h-32 rounded-md border bg-muted/40">
          <pre className="p-3 text-xs font-mono leading-relaxed" data-testid={testid}>
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </pre>
        </ScrollArea>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {waitingLabel}
        </p>
      )}
    </div>
  )
}
