"use client"

/**
 * The pairing form — scan or paste a one-shot `cgnp3` invitation, redeem it,
 * store the device key.
 *
 * # Two things this file is careful about
 *
 * **Every failure is classified, never echoed.** The step used to render
 * `result.message` straight from the API layer, which is how a browser refusing
 * a self-signed LAN certificate became the user-facing text "Failed to fetch".
 * Now each failure goes through `diagnosePairFailure`, which needs three inputs
 * the raw exception cannot supply: the stage, the invitation's own base URL, and
 * a `no-cors` reachability bit from `probeOriginReachable` — the only signal a
 * browser leaves that separates "the Host refused this origin" from "nothing is
 * listening there". The probe runs *only* on the failure path, so a healthy pair
 * costs nothing.
 *
 * **A one-shot invitation is checked before it is spent.** `diagnoseTransport`
 * runs before the first request, so an `https://<lan-ip>` invitation that no
 * browser can ever complete is rejected while it is still redeemable elsewhere,
 * instead of after the Host has burned it.
 *
 * # Layout
 *
 * The web form is a two-column grid from `lg` up: the invariant "how to get an
 * invitation" material on the left, the field and everything that appears in
 * response to it on the right. Single-column stacking is what made the page grow
 * a scrollbar the moment a payload was pasted — the invitation summary, the
 * storage notice and the error panel all landed under a form that already filled
 * the viewport. Mobile keeps the single column, where it is correct.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
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

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { notify } from "@/lib/capacitor/haptics"
import { recordRecentServer } from "@/lib/connectivity/recent-servers"
import { probeOriginReachable } from "@/lib/connectivity/origin-reachability"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { readClipboardText, writeClipboardText } from "@/lib/tauri/clipboard"
import { saveCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"

import { registerPairPayload } from "./pair-api"
import {
  diagnosePairFailure,
  diagnosePayloadFailure,
  diagnoseTransport,
  type PairFailure,
} from "./pair-failure"
import { PairFailurePanel } from "./pair-failure-panel"
import { DiscoverHelp } from "./discover-help"

export interface PairStepProps {
  prefilledPairPayload?: string
  autoScan?: boolean
  /**
   * Redeem `prefilledPairPayload` on mount without waiting for Submit. Set only
   * for an invitation the user arrived with (desktop "pair in browser" link,
   * `cognia://` deep link) — never for clipboard or typed input.
   */
  autoSubmit?: boolean
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
  | { kind: "error"; failure: PairFailure; action?: ErrorAction }

const HEADLESS_PAIR_COMMANDS = {
  development: "pnpm --silent dev:headless pair --device-name browser",
  compose:
    "docker compose -f deploy/compose/docker-compose.yml --profile server exec cognia-server cognia-server pair --device-name browser",
  kubernetes:
    "kubectl -n <namespace> exec -i cognia-server-0 -- cognia-server pair --device-name browser",
} as const

type HeadlessPairMode = keyof typeof HEADLESS_PAIR_COMMANDS

/** Budget for the failure-path reachability probe. */
const PROBE_TIMEOUT_MS = 2000

function displayPairHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * Ask the peer whether it is there at all, ignoring whether we may read it.
 *
 * Only ever called after a failure, so the extra round trip never sits in the
 * happy path. Non-throwing: an inconclusive probe leaves `peerAnswered`
 * undefined and the taxonomy falls back to its unqualified answer.
 */
async function probePeer(baseUrl: string | undefined): Promise<boolean | undefined> {
  if (!baseUrl) return undefined
  try {
    return await probeOriginReachable(baseUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 500),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
  } catch {
    return undefined
  }
}

export function PairStep({
  prefilledPairPayload = "",
  autoScan = false,
  autoSubmit = false,
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

  const acceptPayload = useCallback((raw: string) => {
    const decoded = decodePairPayload(raw)
    if (decoded.kind !== "ok") {
      setPhase({ kind: "error", failure: diagnosePayloadFailure(decoded) })
      return false
    }
    setPayload(raw.trim())
    setPhase({ kind: "idle" })
    return true
  }, [])

  const completePairing = useCallback(
    async (raw: string) => {
      if (!acceptPayload(raw)) return
      const canonicalPayload = raw.trim()
      const decoded = decodePairPayload(canonicalPayload)
      const baseUrl = decoded.kind === "ok" ? decoded.payload.baseUrl : undefined

      // Cheapest check first, and the only one that runs while the invitation
      // is still redeemable: a transport this browser can never complete.
      if (baseUrl) {
        const transportFailure = diagnoseTransport(baseUrl, webMode)
        if (transportFailure) {
          setPhase({ kind: "error", failure: transportFailure })
          return
        }
      }

      setPhase({ kind: "pairing" })
      const result = await registerPairPayload(canonicalPayload)
      if (result.kind === "invalid_payload") {
        setPhase({ kind: "error", failure: diagnosePayloadFailure(result.outcome) })
        return
      }
      if (result.kind !== "ok") {
        const peerAnswered = await probePeer(result.baseUrl)
        setPhase({
          kind: "error",
          failure: diagnosePairFailure(result.error, {
            stage: "register",
            baseUrl: result.baseUrl,
            webMode,
            peerAnswered,
          }),
        })
        return
      }
      try {
        await persistPairing(result.config)
      } catch (error) {
        setPhase({
          kind: "error",
          failure: diagnosePairFailure(error, {
            stage: "persist",
            baseUrl: result.config.baseUrl,
            webMode,
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
    [acceptPayload, onPaired, persistPairing, webMode]
  )

  const onScanQr = useCallback(async () => {
    setPhase({ kind: "scanning" })
    const result = await scanBarcode()
    if (result.kind === "scanned") {
      await completePairing(result.raw)
      return
    }
    if (result.kind === "cancelled") {
      setPhase({ kind: "idle" })
      return
    }
    const detail =
      result.kind === "permission_denied"
        ? t("scanError.permissionDenied")
        : result.kind === "unsupported"
          ? t("scanError.unsupported")
          : t("scanError.failed", { message: result.message })
    setPhase({
      kind: "error",
      failure: {
        stage: "decode",
        kind: "scan_failed",
        // The scanner already produced the exact sentence; routing it through
        // the network taxonomy would only make it vaguer.
        detail,
        bodyText: detail,
        remedies: result.kind === "unsupported" ? ["freshInvitation"] : [],
        retryable: result.kind !== "unsupported",
        invitationSpent: false,
      },
      action:
        result.kind === "permission_denied"
          ? { label: t("scanError.openSettings"), onAction: () => void openAppSettings() }
          : undefined,
    })
  }, [completePairing, t])

  const autoScanFiredRef = useRef(false)
  useEffect(() => {
    if (autoScan && !autoScanFiredRef.current) {
      autoScanFiredRef.current = true
      void onScanQr()
    }
  }, [autoScan, onScanQr])

  // Arrived carrying a complete invitation → redeem it. Guarded by a ref
  // rather than the phase so a failed attempt lands on the manual form with
  // the error instead of retrying a one-shot invitation the Host already
  // burned.
  const autoSubmitFiredRef = useRef(false)
  useEffect(() => {
    if (!autoSubmit || autoSubmitFiredRef.current || !prefilledPairPayload) return
    autoSubmitFiredRef.current = true
    void completePairing(prefilledPairPayload)
  }, [autoSubmit, completePairing, prefilledPairPayload])

  // Clipboard sniff (web only): the headless `cognia-server pair` command
  // prints the invitation to a terminal, so the overwhelmingly common arrival
  // state is "it is already on the clipboard". Fill the field, never submit —
  // the clipboard is ambient, not an intent. Silent on refusal: Firefox and
  // Safari gate `readText()` behind a user gesture, and the paste button is
  // still right there.
  const clipboardSniffedRef = useRef(false)
  useEffect(() => {
    if (!webMode || clipboardSniffedRef.current || prefilledPairPayload) return
    clipboardSniffedRef.current = true
    let cancelled = false
    void (async () => {
      let clipboard: string | null = null
      try {
        clipboard = (await readClipboardText()) ?? null
      } catch {
        return
      }
      if (cancelled || !clipboard) return
      const candidate = clipboard.trim()
      if (decodePairPayload(candidate).kind !== "ok") return
      setPayload((current) => (current ? current : candidate))
    })()
    return () => {
      cancelled = true
    }
  }, [webMode, prefilledPairPayload])

  const onPair = useCallback(async () => {
    await completePairing(payload)
  }, [completePairing, payload])

  const onClearPayload = useCallback(() => {
    setPayload("")
    setPhase({ kind: "idle" })
  }, [])

  const onPastePayload = useCallback(async () => {
    let clipboard: string | null = null
    try {
      clipboard = (await readClipboardText()) ?? null
    } catch {
      clipboard = null
    }
    if (!clipboard?.trim()) {
      setPhase({
        kind: "error",
        failure: {
          stage: "decode",
          kind: "clipboard_unavailable",
          detail: t("web.clipboardReadFailed"),
          bodyText: t("web.clipboardReadFailed"),
          remedies: [],
          retryable: false,
          invitationSpent: false,
        },
      })
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
      setCommandCopied(false)
    }
  }, [headlessPairMode])

  const busy = phase.kind === "pairing" || phase.kind === "scanning"

  const headlessHelp = webMode ? (
    <div className="rounded-xl border bg-muted/35 p-3.5" data-testid="pair-headless-help">
      <div className="flex items-start gap-2.5">
        <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
                aria-label={commandCopied ? t("web.commandCopied") : t("web.copyCommand")}
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
      {/* The localStorage-credential warning. Demoted from a standalone Alert
          to a line inside this block — it is standing context about how web
          pairing works, not an event, and a second full-width callout is what
          pushed the form past the fold. Still unconditional in web mode. */}
      <p
        className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground"
        data-testid="pair-web-storage-notice"
      >
        <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>{t("web.storageNotice")}</span>
      </p>
    </div>
  ) : null

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="pair-pair-step"
      style={{ paddingBottom: keyboard.keyboardHeight ? keyboard.keyboardHeight + 16 : undefined }}
    >
      <form
        className={cn(
          "grid items-start gap-4",
          // Two columns only where there is room for them; the mobile shell is
          // narrower than `lg` on every device it runs on.
          webMode && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        )}
        onSubmit={(event) => {
          event.preventDefault()
          void onPair()
        }}
      >
        {headlessHelp ? <div className="flex flex-col gap-4">{headlessHelp}</div> : null}

        <div className="flex min-w-0 flex-col gap-3">
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
              <div className="flex items-center gap-1">
                {webMode ? (
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
                ) : null}
                {payload ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={onClearPayload}
                    disabled={busy}
                    data-testid="pair-clear-payload"
                  >
                    <XIcon className="size-3.5" aria-hidden="true" />
                    {t("web.clearPayload")}
                  </Button>
                ) : null}
              </div>
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
              className="min-h-24 resize-none font-mono text-xs"
              disabled={busy}
              data-testid="pair-payload"
            />
            {/* One status line under the field, always the same slot: the
                verified-invitation summary when the payload decodes, the
                paste hint before that. Swapping in place is what keeps
                pasting a key from growing the page. */}
            {invitation ? (
              <p
                className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs leading-relaxed"
                data-testid="pair-invitation-summary"
              >
                <ShieldCheckIcon
                  className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="font-medium">
                    {t("invitationSummary.title", { host: displayPairHost(invitation.baseUrl) })}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {t("invitationSummary.description", {
                      version: invitation.serverVersion,
                      expiresAt: new Date(invitation.expiresAt),
                    })}
                  </span>
                </span>
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {webMode ? t("web.pasteHint") : t("codeHint")}
              </p>
            )}
          </div>

          <Button
            type="submit"
            size="lg"
            disabled={busy || !payload.trim()}
            data-testid="pair-submit"
          >
            {phase.kind === "pairing" ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {phase.kind === "pairing" ? t("submitInProgress") : t("submit")}
          </Button>

          {phase.kind === "error" ? (
            <PairFailurePanel
              failure={phase.failure}
              action={phase.action}
              onRetry={phase.failure.retryable ? () => void onPair() : undefined}
              onStartOver={payload ? onClearPayload : undefined}
            />
          ) : null}
        </div>
      </form>

      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
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
