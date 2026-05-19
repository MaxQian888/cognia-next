"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  Loader2Icon,
  LockIcon,
  ScanLineIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { parsePairQrPayload } from "@/lib/qr/pair-qr"
import { pinnedFetch } from "@/lib/tauri/pinned-fetch"
import { saveCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"

import {
  describeHttpError,
  describeNetworkError,
  getDeviceLabel,
  getDevicePlatform,
  safeText,
  validateBaseUrl,
  validatePairJwt,
} from "./pair-helpers"

interface PairResponseBody {
  device_id: string
  device_jwt: string
  server_version: string
  /** ADR-0021 — optional for legacy desktops without WebRTC support. */
  rendezvous_id?: string
  /** ADR-0021 — 32-byte HMAC secret, URL-safe base64 (unpadded). */
  rendezvous_secret?: string
}

export interface PairStepProps {
  /** Pre-fill the URL field, e.g. after the user picked a discovered server. */
  prefilledBaseUrl?: string
  /** Pre-fill the pair-JWT field (rare — used after a QR scan from discover). */
  prefilledPairJwt?: string
  /** Pre-fill the TLS fingerprint pin. */
  prefilledFingerprint?: string
  /** When true, the URL field is read-only — discover already validated it. */
  lockBaseUrl?: boolean
  /** Bubble a successful pair up to the coordinator. */
  onPaired: (config: CompanionConfig) => void
  /** "Back to discover" handler. */
  onBack?: () => void
}

type ErrorAction = { label: string; onAction: () => void | Promise<void> }
type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "pairing" }
  | { kind: "error"; message: string; action?: ErrorAction }

export function PairStep({
  prefilledBaseUrl = "",
  prefilledPairJwt = "",
  prefilledFingerprint = "",
  lockBaseUrl = false,
  onPaired,
  onBack,
}: PairStepProps) {
  const t = useTranslations("mobile.pair")
  const keyboard = useKeyboardInsets()

  // Local form state seeded from the props once on mount. The parent
  // remounts this component (via `key`) when a different server is picked,
  // which gives us a fresh seed without a tedious useEffect-sync dance.
  const [baseUrl, setBaseUrl] = useState(prefilledBaseUrl)
  const [pairJwt, setPairJwt] = useState(prefilledPairJwt)
  const [serverFingerprint, setServerFingerprint] = useState(prefilledFingerprint)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })

  const onScanQr = useCallback(async () => {
    // Wave 4 / ADR-0026 — flip to `scanning` so the UI can render an
    // indeterminate overlay while the mlkit native modal launches. (On
    // some Android emulators there's a ~500 ms lag between the button tap
    // and the camera view appearing — without the overlay it looks frozen.)
    setPhase({ kind: "scanning" })
    const result = await scanBarcode()
    if (result.kind === "scanned") {
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
      setPhase({ kind: "error", message: t("scanError.notPairCode") })
      return
    }
    if (result.kind === "permission_denied") {
      // Wave 4 — Apple does not expose a programmatic re-prompt once the
      // user has denied camera access. Surface a CTA that deep-links to
      // Settings → cognia → Camera so the user can flip the toggle.
      setPhase({
        kind: "error",
        message: t("scanError.permissionDenied"),
        action: {
          label: t("scanError.openSettings"),
          onAction: () => void openAppSettings(),
        },
      })
      return
    }
    if (result.kind === "unsupported") {
      setPhase({ kind: "error", message: t("scanError.unsupported") })
      return
    }
    if (result.kind === "cancelled") {
      setPhase({ kind: "idle" })
      return
    }
    setPhase({ kind: "error", message: t("scanError.failed", { message: result.message }) })
  }, [t])

  const onPair = useCallback(async () => {
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "")
    const trimmedJwt = pairJwt.trim()

    const urlError = validateBaseUrl(trimmedUrl)
    if (urlError) {
      setPhase({ kind: "error", message: urlError })
      return
    }
    const jwtError = validatePairJwt(trimmedJwt)
    if (jwtError) {
      setPhase({ kind: "error", message: jwtError })
      return
    }

    setPhase({ kind: "pairing" })
    try {
      // Use `pinnedFetch` so Capacitor routes through the native HTTP stack
      // with `serverTrustMode: "self-signed"` — the desktop's TLS cert is
      // self-signed (M2.9) and browser fetch can't reach it.
      const response = await pinnedFetch(`${trimmedUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair_jwt: trimmedJwt,
          device_label: getDeviceLabel(),
          device_platform: getDevicePlatform(),
          device_pubkey: "",
          app_version: "0.1.0",
        }),
        serverFingerprint: serverFingerprint || undefined,
      })

      if (!response.ok) {
        setPhase({
          kind: "error",
          message: describeHttpError(response.status, await safeText(response)),
        })
        return
      }

      const body = (await response.json()) as PairResponseBody

      // P0.3 — app-layer fingerprint attestation. After pair redeem, call
      // /api/v1/whoami and confirm the server reports the same TLS
      // fingerprint the QR encoded. Catches "connected to the wrong cognia"
      // and most cert-rotation cases. Not strict TLS pinning — see
      // mobile/docs/p0-tls-trust-setup.md.
      if (serverFingerprint) {
        try {
          const whoami = await pinnedFetch(`${trimmedUrl}/api/v1/whoami`, {
            method: "GET",
            headers: { Authorization: `Bearer ${body.device_jwt}` },
            serverFingerprint,
          })
          if (whoami.ok) {
            const data = (await whoami.json()) as { tls_fingerprint?: string }
            const reported = (data.tls_fingerprint ?? "").toLowerCase()
            const expected = serverFingerprint.toLowerCase()
            if (reported && reported !== expected) {
              setPhase({
                kind: "error",
                message: t("fingerprintMismatch", {
                  expected: expected.slice(0, 8),
                  reported: reported.slice(0, 8),
                }),
              })
              return
            }
          }
        } catch {
          // Attestation is best-effort; a transport hiccup here shouldn't
          // block pairing because the JWT itself is already redeemed.
        }
      }

      const config: CompanionConfig = {
        baseUrl: trimmedUrl,
        deviceJwt: body.device_jwt,
        deviceId: body.device_id,
        serverVersion: body.server_version,
      }
      if (serverFingerprint) {
        config.serverFingerprint = serverFingerprint
      }
      // ADR-0021 — opt the device into the WebRTC tier when the desktop
      // returns a rendezvous tuple. Legacy desktops omit both fields, in
      // which case the transport stays on HTTPS+WS only.
      if (body.rendezvous_id && body.rendezvous_secret) {
        config.rendezvousId = body.rendezvous_id
        config.rendezvousSecret = body.rendezvous_secret
      }
      await saveCompanionConfig(config)
      onPaired(config)
    } catch (err) {
      setPhase({ kind: "error", message: describeNetworkError(err) })
    }
  }, [baseUrl, pairJwt, serverFingerprint, onPaired, t])

  const isPairing = phase.kind === "pairing"

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="pair-pair-step"
      style={{ paddingBottom: keyboard.keyboardHeight ? keyboard.keyboardHeight + 16 : undefined }}
    >
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
              disabled={isPairing || phase.kind === "scanning"}
              data-testid="pair-scan-qr"
            >
              {phase.kind === "scanning" ? (
                <>
                  <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
                  {t("scanning")}
                </>
              ) : (
                <>
                  <ScanLineIcon className="size-5" aria-hidden="true" />
                  {t("scanCta")}
                </>
              )}
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">{t("manualDivider")}</span>
              <Separator className="flex-1" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="pair-baseurl"
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                {t("baseUrlLabel")}
                {lockBaseUrl ? (
                  <LockIcon
                    className="size-3 text-muted-foreground"
                    aria-label={t("discover.baseUrlLocked")}
                  />
                ) : null}
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
                disabled={isPairing}
                readOnly={lockBaseUrl}
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
                disabled={isPairing}
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
                <AlertDescription className="flex flex-col gap-2">
                  <span>{phase.message}</span>
                  {phase.action ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void phase.action?.onAction()}
                      data-testid="pair-error-action"
                    >
                      {phase.action.label}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="touch-target w-full"
              disabled={isPairing}
              data-testid="pair-submit"
            >
              {isPairing ? (
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

      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="touch-target self-center"
          onClick={onBack}
          disabled={isPairing}
          data-testid="pair-back-to-discover"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("discover.backToDiscover")}
        </Button>
      ) : null}
    </section>
  )
}
