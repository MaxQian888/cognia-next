"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  InfoIcon,
  Loader2Icon,
  ScanLineIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { notify } from "@/lib/capacitor/haptics"
import { recordRecentServer } from "@/lib/connectivity/recent-servers"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { saveCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"

import { registerPairPayload } from "./pair-api"
import { DiscoverHelp } from "./discover-help"

export interface PairStepProps {
  prefilledPairPayload?: string
  autoScan?: boolean
  webMode?: boolean
  onPaired: (config: CompanionConfig) => void
  onBack?: () => void
}

type ErrorAction = { label: string; onAction: () => void | Promise<void> }
type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "pairing" }
  | { kind: "error"; message: string; action?: ErrorAction }

export function PairStep({
  prefilledPairPayload = "",
  autoScan = false,
  webMode = false,
  onPaired,
  onBack,
}: PairStepProps) {
  const t = useTranslations("mobile.pair")
  const keyboard = useKeyboardInsets()
  const [payload, setPayload] = useState(prefilledPairPayload)
  const [fingerprint, setFingerprint] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })

  const acceptPayload = useCallback(
    (raw: string) => {
      const decoded = decodePairPayload(raw)
      if (decoded.kind !== "ok") {
        setPhase({
          kind: "error",
          message:
            decoded.kind === "version_mismatch"
              ? t("payloadError.versionMismatch", { got: decoded.got })
              : t("payloadError.invalid"),
        })
        return false
      }
      setPayload(raw.trim())
      setFingerprint(decoded.payload.fingerprint)
      setPhase({ kind: "idle" })
      return true
    },
    [t]
  )

  const completePairing = useCallback(
    async (raw: string) => {
      if (!acceptPayload(raw)) return
      const canonicalPayload = raw.trim()
      setPhase({ kind: "pairing" })
      const result = await registerPairPayload(canonicalPayload)
      if (result.kind !== "ok") {
        setPhase({ kind: "error", message: result.message })
        return
      }
      try {
        await saveCompanionConfig(result.config)
      } catch (error) {
        setPhase({
          kind: "error",
          message: t("persistenceError", {
            message: error instanceof Error ? error.message : String(error),
          }),
        })
        return
      }
      recordRecentServer({
        baseUrl: result.config.baseUrl,
        fingerprint: result.config.serverFingerprint,
        label: result.config.deviceId.slice(0, 8),
        deviceId: result.config.deviceId,
        serverVersion: result.config.serverVersion,
      })
      void notify("success")
      onPaired(result.config)
    },
    [acceptPayload, onPaired, t]
  )

  const onScanQr = useCallback(async () => {
    setPhase({ kind: "scanning" })
    const result = await scanBarcode()
    if (result.kind === "scanned") {
      await completePairing(result.raw)
      return
    }
    if (result.kind === "permission_denied") {
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
  }, [completePairing, t])

  const autoScanFiredRef = useRef(false)
  useEffect(() => {
    if (autoScan && !autoScanFiredRef.current) {
      autoScanFiredRef.current = true
      void onScanQr()
    }
  }, [autoScan, onScanQr])

  const onPair = useCallback(async () => {
    await completePairing(payload)
  }, [completePairing, payload])

  const busy = phase.kind === "pairing" || phase.kind === "scanning"
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
            {webMode ? t("web.formCardTitle") : t("formCardTitle")}
          </CardTitle>
          <CardDescription>
            {webMode ? t("web.formCardDescription") : t("formCardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void onPair()
            }}
          >
            {!webMode ? (
              <Button
                type="button"
                size="lg"
                className="touch-target w-full"
                onClick={() => void onScanQr()}
                disabled={busy}
                data-testid="pair-scan-qr"
              >
                {phase.kind === "scanning" ? (
                  <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
                ) : (
                  <ScanLineIcon className="size-5" aria-hidden="true" />
                )}
                {phase.kind === "scanning" ? t("scanning") : t("scanCta")}
              </Button>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pair-payload">{t("tokenLabel")}</Label>
              <Textarea
                id="pair-payload"
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                placeholder={t("payloadPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="min-h-28 font-mono text-xs"
                disabled={busy}
                data-testid="pair-payload"
              />
            </div>

            {fingerprint ? (
              <Alert className="border-emerald-500/40 bg-emerald-500/5">
                <ShieldCheckIcon className="text-emerald-600 dark:text-emerald-400" />
                <AlertTitle>{t("fingerprintPinned")}</AlertTitle>
                <AlertDescription className="break-all font-mono text-[10px]">
                  {fingerprint.slice(0, 16)}…{fingerprint.slice(-16)}
                </AlertDescription>
              </Alert>
            ) : null}

            {webMode ? (
              <Alert data-testid="pair-web-storage-notice">
                <InfoIcon aria-hidden="true" />
                <AlertTitle>{t("web.storageNoticeTitle")}</AlertTitle>
                <AlertDescription>{t("web.storageNotice")}</AlertDescription>
              </Alert>
            ) : null}

            {phase.kind === "error" ? (
              <Alert variant="destructive" data-testid="pair-error">
                <AlertCircleIcon />
                <AlertTitle>{t("errorTitle")}</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>{phase.message}</span>
                  {phase.action ? (
                    <Button type="button" size="sm" variant="outline" onClick={phase.action.onAction}>
                      {phase.action.label}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" size="lg" disabled={busy} data-testid="pair-submit">
              {phase.kind === "pairing" ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {phase.kind === "pairing" ? t("submitInProgress") : t("submit")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={busy}
          data-testid="pair-back-to-discover"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("discover.backToDiscover")}
        </Button>
      ) : null}
      {webMode ? null : <DiscoverHelp />}
    </section>
  )
}
