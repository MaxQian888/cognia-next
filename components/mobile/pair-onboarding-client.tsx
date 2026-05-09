"use client"

/**
 * Mobile Pair Onboarding (Capacitor `/pair`).
 *
 * The mobile-end remote-control entry point. Three surfaces:
 *
 *   1. Pre-pair (idle / pairing / error) — single Card with primary
 *      "Scan QR" CTA + manual baseUrl/JWT form. Errors render as
 *      `<Alert variant="destructive">`. v2 QR fingerprints surface as
 *      `<Alert>` with a shield icon and a truncated head/tail.
 *   2. Connection-health card (paired) — replaces the M3.4 smoke screen.
 *      Shows a status dot + `<Badge>` + KV grid (device, server, last
 *      heartbeat, latency). Footer ships a `Continue to chat` CTA that
 *      pushes the user from `/pair` into `<AppShellMobile />` at `/`,
 *      plus a "Refresh status" probe.
 *   3. Diagnostics (collapsed by default) — RPC + WS smoke probes,
 *      results in a `<ScrollArea>`. For users who actually need to
 *      verify the link.
 *
 * The Connection-health card uses the existing `claude_sidecar_status`
 * RPC as a heartbeat proxy (M2.10+ may add a dedicated /healthz endpoint).
 *
 * Sign-out lives in its own Card at the bottom — destructive variant,
 * still gated by `useBiometricGuard`.
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  Loader2Icon,
  LogOutIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  ScanLineIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { parsePairQrPayload } from "@/lib/qr/pair-qr"
import { transport } from "@/lib/tauri"
import {
  clearCompanionConfig,
  hydrateCompanionConfig,
  saveCompanionConfig,
} from "@/lib/tauri/transport-companion"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import { formatRelative } from "@/lib/time/relative"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HealthState = "live" | "checking" | "offline"

type Phase =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "pairing" }
  | {
      kind: "paired"
      deviceId: string
      serverVersion: string
      baseUrl: string
      lastHeartbeatMs: number
      latencyMs: number | null
      healthState: HealthState
      healthError: string | null
    }
  | { kind: "error"; message: string; recoverable: boolean }

interface PairResponseBody {
  device_id: string
  device_jwt: string
  server_version: string
}

interface SmokeResults {
  rpc: unknown
  ws: unknown
}

const SMOKE_RPC = "claude_sidecar_status"
const SMOKE_WS_CHANNEL = "claude://session-event"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PairOnboardingClient() {
  const router = useRouter()
  const t = useTranslations("mobile.pair")
  const guard = useBiometricGuard()

  const [baseUrl, setBaseUrl] = useState("")
  const [pairJwt, setPairJwt] = useState("")
  /**
   * Server TLS fingerprint pulled out of a v2 QR payload (Wave 1.4 / 1.7).
   * Empty when the user pasted a v1 JSON-only payload — pairing still
   * works in that path but the transport layer can't pin.
   */
  const [serverFingerprint, setServerFingerprint] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [smoke, setSmoke] = useState<SmokeResults>({ rpc: undefined, ws: undefined })
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  // Hydrate cache from SecureStorage / localStorage on mount so a paired
  // device skips the form and lands on the health card.
  useEffect(() => {
    let cancelled = false
    void hydrateCompanionConfig()
      .then((cfg) => {
        if (cancelled) return
        if (cfg) {
          setPhase({
            kind: "paired",
            deviceId: cfg.deviceId,
            serverVersion: cfg.serverVersion,
            baseUrl: cfg.baseUrl,
            lastHeartbeatMs: Date.now(),
            latencyMs: null,
            healthState: "live",
            healthError: null,
          })
        } else {
          setPhase({ kind: "idle" })
        }
      })
      .catch(() => {
        if (cancelled) return
        // Hydration failure → still let the user pair (form path).
        setPhase({ kind: "idle" })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onPair = useCallback(async () => {
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "")
    const trimmedJwt = pairJwt.trim()

    const urlError = validateBaseUrl(trimmedUrl)
    if (urlError) {
      setPhase({ kind: "error", message: urlError, recoverable: true })
      return
    }
    const jwtError = validatePairJwt(trimmedJwt)
    if (jwtError) {
      setPhase({ kind: "error", message: jwtError, recoverable: true })
      return
    }

    setPhase({ kind: "pairing" })

    try {
      const response = await fetch(`${trimmedUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair_jwt: trimmedJwt,
          device_label: getDeviceLabel(),
          device_platform: getDevicePlatform(),
          device_pubkey: "",
          app_version: "0.1.0",
        }),
      })

      if (!response.ok) {
        setPhase({
          kind: "error",
          message: describeHttpError(response.status, await safeText(response)),
          recoverable: true,
        })
        return
      }

      const body = (await response.json()) as PairResponseBody
      const config: CompanionConfig = {
        baseUrl: trimmedUrl,
        deviceJwt: body.device_jwt,
        deviceId: body.device_id,
        serverVersion: body.server_version,
      }
      if (serverFingerprint) {
        config.serverFingerprint = serverFingerprint
      }
      await saveCompanionConfig(config)
      setPhase({
        kind: "paired",
        deviceId: config.deviceId,
        serverVersion: config.serverVersion,
        baseUrl: config.baseUrl,
        lastHeartbeatMs: Date.now(),
        latencyMs: null,
        healthState: "live",
        healthError: null,
      })
    } catch (err: unknown) {
      setPhase({
        kind: "error",
        message: describeNetworkError(err),
        recoverable: true,
      })
    }
  }, [baseUrl, pairJwt, serverFingerprint])

  const onSignOut = useCallback(async () => {
    const out = await guard(
      {
        reason: t("signOutReason"),
        title: t("signOutTitle"),
        description: t("signOutDescription"),
      },
      async () => {
        await clearCompanionConfig()
      }
    )
    if (out.kind === "blocked") {
      if (out.reason !== "cancelled") {
        setPhase({
          kind: "error",
          message: t("biometricFailed", { reason: out.reason }),
          recoverable: true,
        })
      }
      return
    }
    setBaseUrl("")
    setPairJwt("")
    setServerFingerprint("")
    setSmoke({ rpc: undefined, ws: undefined })
    setDiagnosticsOpen(false)
    setPhase({ kind: "idle" })
  }, [guard, t])

  const onScanQr = useCallback(async () => {
    setPhase({ kind: "idle" })
    const result = await scanBarcode()
    if (result.kind === "scanned") {
      // Try v2 (cgnp2|...) first; v2 carries the TLS fingerprint. Fall back
      // to v1 bare-JSON for backwards compatibility with M3.4 stubs.
      const decoded = decodePairPayload(result.raw)
      if (decoded.kind === "ok") {
        setBaseUrl(decoded.payload.baseUrl)
        setPairJwt(decoded.payload.pairJwt)
        setServerFingerprint(decoded.payload.fingerprint || "")
        setPhase({ kind: "idle" })
        return
      }
      const legacy = parsePairQrPayload(result.raw)
      if (legacy) {
        setBaseUrl(legacy.baseUrl)
        setPairJwt(legacy.pairJwt)
        setServerFingerprint("")
        setPhase({ kind: "idle" })
        return
      }
      setPhase({
        kind: "error",
        message:
          "QR code scanned but its payload is not a cognia pairing code. Generate a fresh QR from desktop Settings → Companion.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "permission_denied") {
      setPhase({
        kind: "error",
        message:
          "Camera permission denied. Open the system Settings → cognia → Camera to grant access, or paste the pairing code manually.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "unsupported") {
      setPhase({
        kind: "error",
        message:
          "QR scan is only available on the mobile app. Paste the pairing code from desktop Settings → Companion below.",
        recoverable: true,
      })
      return
    }
    if (result.kind === "cancelled") {
      return
    }
    setPhase({
      kind: "error",
      message: `QR scan failed: ${result.message}`,
      recoverable: true,
    })
  }, [])

  const onRefreshHealth = useCallback(async () => {
    setPhase((prev) => {
      if (prev.kind !== "paired") return prev
      return { ...prev, healthState: "checking", healthError: null }
    })
    const startedAt = Date.now()
    try {
      await transport.call(SMOKE_RPC)
      const elapsed = Date.now() - startedAt
      setPhase((prev) => {
        if (prev.kind !== "paired") return prev
        return {
          ...prev,
          lastHeartbeatMs: Date.now(),
          latencyMs: elapsed,
          healthState: "live",
          healthError: null,
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setPhase((prev) => {
        if (prev.kind !== "paired") return prev
        return { ...prev, healthState: "offline", healthError: message }
      })
    }
  }, [])

  const onCallSmoke = useCallback(async () => {
    const startedAt = Date.now()
    try {
      const payload = await transport.call(SMOKE_RPC)
      const elapsed = Date.now() - startedAt
      setSmoke((prev) => ({ ...prev, rpc: payload }))
      setPhase((prev) => {
        if (prev.kind !== "paired") return prev
        return {
          ...prev,
          lastHeartbeatMs: Date.now(),
          latencyMs: elapsed,
          healthState: "live",
          healthError: null,
        }
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSmoke((prev) => ({ ...prev, rpc: { error: message } }))
      setPhase((prev) => {
        if (prev.kind !== "paired") return prev
        return { ...prev, healthState: "offline", healthError: message }
      })
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

  const onContinueToChat = useCallback(() => {
    router.push("/")
  }, [router])

  const transportName = transport.constructor.name

  // -------------------------------------------------------------------------
  // Render — three top-level branches
  // -------------------------------------------------------------------------

  if (phase.kind === "loading") {
    return (
      <main
        className="mx-auto flex min-h-[100dvh] max-w-md items-center justify-center safe-area-py safe-area-px"
        data-testid="pair-onboarding"
      >
        <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">{t("loadingTitle")}</p>
        </div>
      </main>
    )
  }

  if (phase.kind === "paired") {
    return (
      <main
        className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col gap-4 p-4 safe-area-py safe-area-px sm:max-w-lg sm:p-6 md:max-w-xl"
        data-testid="pair-onboarding"
      >
        <PairHeader t={t} />
        <ConnectionHealthCard
          phase={phase}
          onRefresh={() => void onRefreshHealth()}
          onContinue={onContinueToChat}
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
        <SignOutCard onSignOut={() => void onSignOut()} t={t} />
        <p className="text-center text-xs text-muted-foreground">
          {t("transportLabel")}: <code className="font-mono">{transportName}</code>
        </p>
      </main>
    )
  }

  // Pre-pair (idle / pairing / error)
  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col gap-4 p-4 safe-area-py safe-area-px sm:max-w-lg sm:p-6 md:max-w-xl"
      data-testid="pair-onboarding"
    >
      <PairHeader t={t} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanLineIcon className="size-4" aria-hidden="true" />
            {t("formCardTitle")}
          </CardTitle>
          <CardDescription>{t("formCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void onPair()
            }}
          >
            <Button
              type="button"
              size="lg"
              className="touch-target w-full"
              onClick={() => void onScanQr()}
              disabled={phase.kind === "pairing"}
              data-testid="pair-scan-qr"
            >
              <ScanLineIcon className="size-5" aria-hidden="true" />
              {t("scanCta")}
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">{t("manualDivider")}</span>
              <Separator className="flex-1" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pair-baseurl" className="text-sm font-medium">
                {t("baseUrlLabel")}
              </Label>
              <Input
                id="pair-baseurl"
                type="url"
                inputMode="url"
                placeholder="https://192.168.1.42:7891"
                value={baseUrl}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="touch-target"
                disabled={phase.kind === "pairing"}
                data-testid="pair-baseurl"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pair-jwt" className="text-sm font-medium">
                {t("tokenLabel")}
              </Label>
              <Textarea
                id="pair-jwt"
                placeholder="eyJ..."
                value={pairJwt}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setPairJwt(e.target.value)}
                className="min-h-24 font-mono text-xs"
                disabled={phase.kind === "pairing"}
                data-testid="pair-jwt"
              />
            </div>

            {serverFingerprint ? (
              <Alert
                className="border-emerald-500/40 bg-emerald-500/5"
                data-testid="pair-fingerprint-pin"
              >
                <ShieldCheckIcon className="text-emerald-600 dark:text-emerald-400" />
                <AlertTitle className="text-emerald-700 dark:text-emerald-300">
                  {t("fingerprintPinned")}
                </AlertTitle>
                <AlertDescription>
                  <span className="break-all font-mono text-[10px]">
                    {serverFingerprint.slice(0, 16)}…{serverFingerprint.slice(-16)}
                  </span>
                  <span className="text-xs">{t("fingerprintHint")}</span>
                </AlertDescription>
              </Alert>
            ) : null}

            {phase.kind === "error" ? (
              <Alert variant="destructive" data-testid="pair-error">
                <AlertCircleIcon />
                <AlertTitle>{t("errorTitle")}</AlertTitle>
                <AlertDescription>{phase.message}</AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="touch-target w-full"
              disabled={phase.kind === "pairing"}
              data-testid="pair-submit"
            >
              {phase.kind === "pairing" ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  {t("submitInProgress")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        {t("transportLabel")}: <code className="font-mono">{transportName}</code>
      </p>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type Translator = ReturnType<typeof useTranslations>

function PairHeader({ t }: { t: Translator }) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
    </header>
  )
}

function ConnectionHealthCard({
  phase,
  onRefresh,
  onContinue,
  t,
}: {
  phase: Extract<Phase, { kind: "paired" }>
  onRefresh: () => void
  onContinue: () => void
  t: Translator
}) {
  const dotClass =
    phase.healthState === "live"
      ? "fill-emerald-500 text-emerald-500"
      : phase.healthState === "checking"
        ? "fill-amber-500 text-amber-500 animate-pulse"
        : "fill-destructive text-destructive"
  const titleKey =
    phase.healthState === "live"
      ? "connectedTitle"
      : phase.healthState === "checking"
        ? "checkingTitle"
        : "offlineTitle"
  const subtitleKey = phase.healthState === "offline" ? "offlineSubtitle" : "connectedSubtitle"
  const badgeKey =
    phase.healthState === "live"
      ? "health.live"
      : phase.healthState === "checking"
        ? "health.checking"
        : "health.offline"
  return (
    <Card data-testid="pair-health-card" data-health={phase.healthState}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleIcon className={cn("size-2.5", dotClass)} aria-hidden="true" />
          {t(titleKey)}
          <Badge variant="outline" className="ml-auto text-[10px] uppercase">
            {t(badgeKey)}
          </Badge>
        </CardTitle>
        <CardDescription>{t(subtitleKey)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
          data-testid="pair-status"
        >
          <dt className="text-muted-foreground">{t("health.device")}</dt>
          <dd className="break-all font-mono text-xs">{phase.deviceId}</dd>
          <dt className="text-muted-foreground">{t("health.server")}</dt>
          <dd className="break-all font-mono text-xs">
            {phase.baseUrl} <span className="text-muted-foreground">v{phase.serverVersion}</span>
          </dd>
          <dt className="text-muted-foreground">{t("health.lastHeartbeat")}</dt>
          <dd>
            {phase.healthState === "checking" ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3" />
                {t("health.checking")}
              </span>
            ) : (
              formatRelative(phase.lastHeartbeatMs)
            )}
          </dd>
          <dt className="text-muted-foreground">{t("health.latency")}</dt>
          <dd>{phase.latencyMs !== null ? `${phase.latencyMs}ms` : t("health.noHeartbeat")}</dd>
        </div>
        {phase.healthError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{phase.healthError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="w-full touch-target sm:w-auto"
          onClick={onRefresh}
          disabled={phase.healthState === "checking"}
          data-testid="pair-refresh"
        >
          <RefreshCwIcon
            className={cn("size-4", phase.healthState === "checking" && "animate-spin")}
            aria-hidden="true"
          />
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

function DiagnosticsCard({
  open,
  onOpenChange,
  smoke,
  onCallSmoke,
  onSubscribeSmoke,
  t,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  smoke: SmokeResults
  onCallSmoke: () => void
  onSubscribeSmoke: () => void
  t: Translator
}) {
  return (
    <Card>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 px-6 text-left"
            data-testid="pair-diagnostics-toggle"
            aria-expanded={open}
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
          </button>
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

function SignOutCard({ onSignOut, t }: { onSignOut: () => void; t: Translator }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("signOut.cardTitle")}</CardTitle>
        <CardDescription>{t("signOut.cardDescription")}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button
          type="button"
          variant="destructive"
          className="touch-target w-full"
          onClick={onSignOut}
          data-testid="pair-signout"
        >
          <LogOutIcon className="size-4" aria-hidden="true" />
          {t("signOut.cta")}
        </Button>
      </CardFooter>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns an error string if the URL is not a usable LAN companion server
 * URL, otherwise null. Accepts http or https with an explicit host;
 * rejects empty / non-http / IP-without-host strings.
 */
export function validateBaseUrl(input: string): string | null {
  if (!input) return "Server base URL is required."
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return "Enter a URL like http://192.168.1.42:7890."
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must start with http:// or https://."
  }
  if (!parsed.host) return "URL is missing a host."
  return null
}

/**
 * Returns an error string if the JWT is not shaped like a JWT
 * (`header.payload.signature`, base64url of each part), otherwise null.
 * We don't verify the signature client-side — that's the server's job.
 */
export function validatePairJwt(input: string): string | null {
  if (!input) return "Pair JWT is required."
  const parts = input.split(".")
  if (parts.length !== 3) return "Pair JWT must have three dot-separated parts."
  if (parts.some((p) => p.length === 0)) return "Pair JWT segments must be non-empty."
  if (!parts.every(isBase64Url)) return "Pair JWT must be base64url encoded."
  return null
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function describeHttpError(status: number, body: string): string {
  if (status === 401) {
    return "Pairing code rejected — it may have expired (5-minute lifetime) or already been used. Generate a fresh one in desktop Settings → Companion."
  }
  if (status === 403) {
    return "Server refused the pairing request — check the desktop Companion settings for an allow-list."
  }
  if (status === 404) {
    return "Server doesn't expose /api/v1/auth/pair — confirm the desktop is running cognia v0.2+ with companion enabled."
  }
  if (status >= 500) {
    return `Server error (HTTP ${status}). Check the desktop's logs and try again.`
  }
  return body ? `pair failed (HTTP ${status}): ${body}` : `pair failed (HTTP ${status}).`
}

export function describeNetworkError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return "Could not reach the desktop server. Check the URL, that the desktop has the Companion server enabled, and that both devices are on the same network."
  }
  return raw
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown-device"
  return navigator.userAgent || "unknown-device"
}

function getDevicePlatform(): string {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  if (cap?.getPlatform) {
    return cap.getPlatform()
  }
  return "web"
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}
