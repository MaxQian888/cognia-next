"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckIcon,
  ClipboardPasteIcon,
  CopyIcon,
  InfoIcon,
  Loader2Icon,
  ScanLineIcon,
  ShieldCheckIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { notify } from "@/lib/capacitor/haptics"
import { recordRecentServer } from "@/lib/connectivity/recent-servers"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { readClipboardText, writeClipboardText } from "@/lib/tauri/clipboard"
import { saveCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"

import { registerPairPayload } from "./pair-api"
import { DiscoverHelp } from "./discover-help"

export interface PairStepProps {
  prefilledPairPayload?: string
  autoScan?: boolean
  webMode?: boolean
  persistPairing?: (config: CompanionConfig) => Promise<void>
  onPaired: (config: CompanionConfig) => void
  onBack?: () => void
}

type ErrorAction = { label: string; onAction: () => void | Promise<void> }
type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "pairing" }
  | { kind: "error"; message: string; action?: ErrorAction }

const HEADLESS_PAIR_COMMANDS = {
  development: "pnpm --silent dev:headless pair --device-name browser",
  compose:
    "docker compose -f deploy/compose/docker-compose.yml --profile server exec cognia-server cognia-server pair --device-name browser",
  kubernetes:
    "kubectl -n <namespace> exec -i cognia-server-0 -- cognia-server pair --device-name browser",
} as const

type HeadlessPairMode = keyof typeof HEADLESS_PAIR_COMMANDS

function displayPairHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function PairStep({
  prefilledPairPayload = "",
  autoScan = false,
  webMode = false,
  persistPairing = saveCompanionConfig,
  onPaired,
  onBack,
}: PairStepProps) {
  const t = useTranslations("mobile.pair")
  const keyboard = useKeyboardInsets()
  const [payload, setPayload] = useState(prefilledPairPayload)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [commandCopied, setCommandCopied] = useState(false)
  const [headlessPairMode, setHeadlessPairMode] = useState<HeadlessPairMode>("development")
  const decodedPayload = useMemo(() => decodePairPayload(payload), [payload])
  const invitation = decodedPayload.kind === "ok" ? decodedPayload.payload : null

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
        await persistPairing(result.config)
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
    [acceptPayload, onPaired, persistPairing, t]
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

  const onPastePayload = useCallback(async () => {
    const clipboard = await readClipboardText()
    if (!clipboard?.trim()) {
      setPhase({ kind: "error", message: t("web.clipboardReadFailed") })
      return
    }
    setPayload(clipboard.trim())
    setPhase({ kind: "idle" })
  }, [t])

  const onCopyCommand = useCallback(async () => {
    try {
      await writeClipboardText(HEADLESS_PAIR_COMMANDS[headlessPairMode])
      setCommandCopied(true)
    } catch {
      setPhase({ kind: "error", message: t("web.clipboardWriteFailed") })
    }
  }, [headlessPairMode, t])

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
            {webMode ? (
              <div className="rounded-lg border bg-muted/35 p-3.5" data-testid="pair-headless-help">
                <div className="flex items-start gap-2.5">
                  <TerminalIcon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t("web.headlessTitle")}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("web.headlessDescription")}
                    </p>
                  </div>
                </div>
                <Tabs
                  value={headlessPairMode}
                  onValueChange={(value) => {
                    setHeadlessPairMode(value as HeadlessPairMode)
                    setCommandCopied(false)
                  }}
                  className="mt-3 gap-2"
                >
                  <TabsList className="grid h-auto w-full grid-cols-3">
                    <TabsTrigger value="development" className="text-xs">
                      {t("web.commandMode.development")}
                    </TabsTrigger>
                    <TabsTrigger value="compose" className="text-xs">
                      {t("web.commandMode.compose")}
                    </TabsTrigger>
                    <TabsTrigger value="kubernetes" className="text-xs">
                      {t("web.commandMode.kubernetes")}
                    </TabsTrigger>
                  </TabsList>
                  {(Object.keys(HEADLESS_PAIR_COMMANDS) as HeadlessPairMode[]).map((mode) => (
                    <TabsContent key={mode} value={mode}>
                      <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                        <code
                          className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap"
                          data-testid="pair-headless-command"
                        >
                          {HEADLESS_PAIR_COMMANDS[mode]}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          onClick={() => void onCopyCommand()}
                          aria-label={
                            commandCopied ? t("web.commandCopied") : t("web.copyCommand")
                          }
                          data-testid="pair-copy-command"
                        >
                          {commandCopied ? (
                            <CheckIcon className="size-3.5" aria-hidden="true" />
                          ) : (
                            <CopyIcon className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                    </TabsContent>
                  ))}
                </Tabs>
                {headlessPairMode !== "development" ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {t("web.deploymentCommandHint")}
                  </p>
                ) : null}
              </div>
            ) : null}

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
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="pair-payload">{t("tokenLabel")}</Label>
                {webMode ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void onPastePayload()}
                      disabled={busy}
                      data-testid="pair-paste-clipboard"
                    >
                      <ClipboardPasteIcon className="size-3.5" aria-hidden="true" />
                      {t("web.pasteClipboard")}
                    </Button>
                    {payload ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setPayload("")
                          setPhase({ kind: "idle" })
                        }}
                        disabled={busy}
                        data-testid="pair-clear-payload"
                      >
                        <XIcon className="size-3.5" aria-hidden="true" />
                        {t("web.clearPayload")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Textarea
                id="pair-payload"
                value={payload}
                onChange={(event) => {
                  setPayload(event.target.value)
                  if (phase.kind === "error") setPhase({ kind: "idle" })
                }}
                placeholder={t("payloadPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="min-h-28 font-mono text-xs"
                disabled={busy}
                data-testid="pair-payload"
              />
            </div>

            {invitation ? (
              <Alert
                className="border-emerald-500/40 bg-emerald-500/5"
                data-testid="pair-invitation-summary"
              >
                <ShieldCheckIcon className="text-emerald-600 dark:text-emerald-400" />
                <AlertTitle>
                  {t("invitationSummary.title", { host: displayPairHost(invitation.baseUrl) })}
                </AlertTitle>
                <AlertDescription>
                  {t("invitationSummary.description", {
                    version: invitation.serverVersion,
                    expiresAt: new Date(invitation.expiresAt),
                  })}
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
