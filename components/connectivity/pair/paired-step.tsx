"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
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
  onContinue: () => void
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
        setSignOutError(t("biometricFailed", { reason: out.reason }))
      }
      return
    }
    onAfterSignOut()
  }, [guard, onAfterSignOut, platform, requireBiometricForSignOut, t])

  // Explicit label — `constructor.name` gets mangled by production minifiers.
  // Duck-typed on `onTierChange` (CompanionTransport-only) like the
  // connection-state badge, so partially-mocked transports stay safe.
  const transportName =
    typeof (transport as { onTierChange?: unknown }).onTierChange === "function"
      ? "CompanionTransport"
      : "TauriTransport"

  return (
    <section className="flex flex-col gap-4" data-testid="pair-paired-step">
      <ConnectionHealthCard
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
      <DiagnosticsCard
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        smoke={smoke}
        onCallSmoke={() => void onCallSmoke()}
        onSubscribeSmoke={onSubscribeSmoke}
        t={t}
      />
      {/* Wave 4.x — surface the local-notifications permission CTA only on
          Capacitor where it can actually do something. `checkPermission`
          returns `unsupported` on web/Tauri so the component renders null,
          but this guard avoids spinning up the dynamic import there. */}
      <NotificationPermissionCta />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("signOut.cardTitle")}</CardTitle>
          <CardDescription>{t("signOut.cardDescription")}</CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col items-stretch gap-2">
          <Button
            type="button"
            variant="destructive"
            className="touch-target w-full"
            onClick={() => void onSignOut()}
            data-testid="pair-signout"
          >
            <LogOutIcon className="size-4" aria-hidden="true" />
            {t("signOut.cta")}
          </Button>
          {signOutError ? (
            <Alert variant="destructive" data-testid="pair-signout-error">
              <AlertCircleIcon />
              <AlertDescription>{signOutError}</AlertDescription>
            </Alert>
          ) : null}
        </CardFooter>
      </Card>
      <DiscoverHelp />
      <p className="text-center text-xs text-muted-foreground">
        {t("transportLabel")}: <code className="font-mono">{transportName}</code>
      </p>
    </section>
  )
}

type Translator = ReturnType<typeof useTranslations>

interface ConnectionHealthCardProps {
  baseUrl: string
  deviceId: string
  serverVersion: string
  healthState: HealthState
  healthError: string | null
  lastHeartbeatMs: number
  latencyMs: number | null
  onRefresh: () => void
  onContinue: () => void
  t: Translator
}

function ConnectionHealthCard({
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
}: ConnectionHealthCardProps) {
  const dotClass =
    healthState === "live"
      ? "fill-emerald-500 text-emerald-500"
      : healthState === "checking"
        ? "fill-amber-500 text-amber-500 animate-pulse"
        : "fill-destructive text-destructive"
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
    <Card data-testid="pair-health-card" data-health={healthState}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleIcon className={cn("size-2.5", dotClass)} aria-hidden="true" />
          {t(titleKey)}
          <div className="ml-auto flex items-center gap-1.5">
            <ConnectionStateBadge />
            <Badge variant="outline" className="text-[10px] uppercase">
              {t(badgeKey)}
            </Badge>
          </div>
        </CardTitle>
        <CardDescription>{t(subtitleKey)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
          data-testid="pair-status"
        >
          <dt className="text-muted-foreground">{t("health.device")}</dt>
          <dd className="break-all font-mono text-xs">{deviceId}</dd>
          <dt className="text-muted-foreground">{t("health.server")}</dt>
          <dd className="break-all font-mono text-xs">
            {baseUrl} <span className="text-muted-foreground">v{serverVersion}</span>
          </dd>
          <dt className="text-muted-foreground">{t("health.lastHeartbeat")}</dt>
          <dd>
            {healthState === "checking" ? (
              // Single source of "in flight" feedback is the pulsing status
              // dot in the card title — no second spinner here.
              <span className="text-muted-foreground">{t("health.checking")}</span>
            ) : (
              formatRelative(lastHeartbeatMs)
            )}
          </dd>
          <dt className="text-muted-foreground">{t("health.latency")}</dt>
          <dd>{latencyMs !== null ? `${latencyMs}ms` : t("health.noHeartbeat")}</dd>
        </div>
        {healthError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{healthError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="w-full touch-target sm:w-auto"
          onClick={onRefresh}
          disabled={healthState === "checking"}
          data-testid="pair-refresh"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {t("health.refresh")}
        </Button>
        <Button
          type="button"
          className="w-full touch-target sm:w-auto"
          onClick={onContinue}
          data-testid="pair-continue-cta"
        >
          <MessageCircleIcon className="size-4" aria-hidden="true" />
          {t("health.continueToChat")}
        </Button>
      </CardFooter>
    </Card>
  )
}

interface DiagnosticsCardProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  smoke: SmokeResults
  onCallSmoke: () => void
  onSubscribeSmoke: () => void
  t: Translator
}

function DiagnosticsCard({
  open,
  onOpenChange,
  smoke,
  onCallSmoke,
  onSubscribeSmoke,
  t,
}: DiagnosticsCardProps) {
  return (
    <Card>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full items-start justify-between gap-3 rounded-none px-6 py-3 text-left font-normal hover:bg-transparent"
            data-testid="pair-diagnostics-toggle"
          >
            <span className="flex flex-col gap-1">
              <span className="text-base font-semibold leading-none">{t("diagnostics.title")}</span>
              <span className="text-sm text-muted-foreground">{t("diagnostics.subtitle")}</span>
            </span>
            <span className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground">
              {open ? (
                <ChevronUpIcon className="size-4" aria-hidden="true" />
              ) : (
                <ChevronDownIcon className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only">
                {open ? t("diagnostics.collapse") : t("diagnostics.expand")}
              </span>
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                className="touch-target w-full"
                onClick={onCallSmoke}
                data-testid="smoke-call"
              >
                {t("diagnostics.testRpc")}
              </Button>
              <Button
                type="button"
                variant="outline"
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
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
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
