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
 * # What this component is no longer responsible for
 *
 * The page frame, the title, the stepper and — on web — the "how to mint an
 * invitation" material all belong to `PairShell` now. This file used to carry a
 * two-column grid, a command block with three deployment tabs, and a storage
 * notice, on top of the form; the invariant half of that never changed between
 * states and had no business being re-laid-out every time the field did. What
 * is left here is the one thing that does change: the invitation, and what
 * happened to it.
 *
 * # One subject at a time
 *
 * Before a payload decodes, the field is the subject and gets the room. After
 * it decodes, the *target* is the subject — which Host, which version, how long
 * it stays valid — and the 800-character blob folds into that card's
 * disclosure, still mounted and still editable. A page cannot have two heroes,
 * and the blob was never a candidate for the job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  ClipboardPasteIcon,
  Loader2Icon,
  ScanLineIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { openAppSettings } from "@/lib/capacitor/app-settings"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { notify } from "@/lib/capacitor/haptics"
import { recordRecentServer } from "@/lib/connectivity/recent-servers"
import { probeOriginReachable } from "@/lib/connectivity/origin-reachability"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { readClipboardText } from "@/lib/tauri/clipboard"
import { saveCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"
import { useAccountStore, usesBrowserVault } from "@/stores/account/account-store"

import { registerPairPayload } from "./pair-api"
import {
  diagnosePairFailure,
  diagnosePayloadFailure,
  diagnoseTransport,
  type PairFailure,
} from "./pair-failure"
import { PairFailurePanel } from "./pair-failure-panel"
import { InvitationCard, type InvitationTone } from "./invitation-card"
import { DiscoverHelp } from "./discover-help"

/**
 * What the step is doing, in the vocabulary the narrative panel's scene draws.
 * Reported upward rather than derived by the coordinator because `phase` and
 * the decoded payload both live here, and duplicating that state to draw a
 * picture of it is how the two drift apart.
 */
export type PairActivity = "idle" | "armed" | "pairing" | "failed"

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
  /**
   * Whether this client can store a device key at all, right now.
   *
   * Desktop and mobile always can — secrets go to the OS keyring. A browser
   * keeps them in the Browser Vault, whose session key is derived from the
   * local account password, so it is unusable until the account is unlocked.
   */
  isCredentialStoreReady?: () => boolean
  /** Take the user to the account lock screen. */
  onRequestUnlock?: () => void | Promise<void>
  onPaired: (config: CompanionConfig) => void
  onBack?: () => void
  /** Lets the shell's scene follow what the form is doing. */
  onActivityChange?: (activity: PairActivity) => void
}

type ErrorAction = { label: string; onAction: () => void | Promise<void> }
type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "pairing" }
  | { kind: "error"; failure: PairFailure; action?: ErrorAction }

/** Budget for the failure-path reachability probe. */
const PROBE_TIMEOUT_MS = 2000

/**
 * Can this client keep a device key?
 *
 * Only the web answers "not yet": `getActiveBrowserVault()` is null until
 * someone unlocks the account with its password, and every credential write
 * through it throws `BrowserVaultLockedError`.
 */
function defaultCredentialStoreReady(): boolean {
  return !usesBrowserVault() || getActiveBrowserVault() !== null
}

/**
 * Make the app agree with its own vault, which is what puts the lock screen on
 * screen.
 *
 * There is no route to navigate to: `AccountGate` wraps the whole tree and
 * decides from `useAccountStore().locked`, which is `activeAccountId !==
 * unlockedAccountId`. A locked vault under an "unlocked" account id is exactly
 * the disagreement that hid the gate, so `lock()` — which clears the id, the
 * vault, the database selection and the runtime target together — is the way
 * back to it, not a `router.push`.
 */
function defaultRequestUnlock(): Promise<void> {
  return useAccountStore.getState().lock()
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
  isCredentialStoreReady = defaultCredentialStoreReady,
  onRequestUnlock = defaultRequestUnlock,
  onPaired,
  onBack,
  onActivityChange,
}: PairStepProps) {
  const t = useTranslations("mobile.pair")
  // The unlock button is the account subsystem's own affordance; borrowing its
  // label keeps the two screens saying the same word for the same act.
  const tAccount = useTranslations("account.gate")
  const keyboard = useKeyboardInsets()
  const [payload, setPayload] = useState(prefilledPairPayload)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
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

      // The second pre-flight, and the reason this one cannot wait until the
      // write fails: the Host burns the invitation at registration, before this
      // client ever reaches its credential store. Submitting with a locked
      // vault therefore spends a one-shot code on a save that is already known
      // to throw, and leaves the only way forward — unlock, pair again —
      // needing an invitation that no longer exists. Checked here, nothing has
      // been sent and the string in the field is still redeemable.
      if (!isCredentialStoreReady()) {
        setPhase({
          kind: "error",
          failure: {
            stage: "persist",
            kind: "vault_locked",
            detail: t("failure.body.vaultLockedPending"),
            bodyText: t("failure.body.vaultLockedPending"),
            remedies: ["unlockAccount"],
            retryable: true,
            invitationSpent: false,
            baseUrl,
          },
          action: { label: tAccount("unlockAccount"), onAction: onRequestUnlock },
        })
        return
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
        // Reachable when the vault is locked *between* the pre-flight and the
        // write — an idle auto-lock mid-request, or a store this component does
        // not own. The invitation is spent by now, so the panel's own copy
        // still says "get a fresh one"; the button goes where that sentence
        // has always pointed and never led.
        const failure = diagnosePairFailure(error, {
          stage: "persist",
          baseUrl: result.config.baseUrl,
          webMode,
        })
        setPhase({
          kind: "error",
          failure,
          action:
            failure.kind === "vault_locked"
              ? { label: tAccount("unlockAccount"), onAction: onRequestUnlock }
              : undefined,
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
    [
      acceptPayload,
      isCredentialStoreReady,
      onPaired,
      onRequestUnlock,
      persistPairing,
      t,
      tAccount,
      webMode,
    ]
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

  const busy = phase.kind === "pairing" || phase.kind === "scanning"
  const failure = phase.kind === "error" ? phase.failure : null

  // The card's tone is the single owner of "what happened to this invitation".
  // Rendering the green summary from the decoded payload alone is what put a
  // "ready" line, a "locked" panel and a "spent" banner on screen at once.
  const invitationTone: InvitationTone = failure
    ? failure.invitationSpent
      ? "spent"
      : "failed"
    : "ready"

  const activity: PairActivity =
    phase.kind === "error"
      ? "failed"
      : phase.kind === "pairing"
        ? "pairing"
        : invitation
          ? "armed"
          : "idle"
  useEffect(() => {
    onActivityChange?.(activity)
  }, [activity, onActivityChange])

  const rawField = (
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
      className={cn("resize-none font-mono text-xs", invitation ? "min-h-16" : "min-h-20")}
      disabled={busy}
      data-testid="pair-payload"
    />
  )

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="pair-pair-step"
      style={{ paddingBottom: keyboard.keyboardHeight ? keyboard.keyboardHeight + 16 : undefined }}
    >
      <form
        className="flex min-w-0 flex-col gap-3"
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

        {invitation ? (
          <InvitationCard
            invitation={invitation}
            tone={invitationTone}
            onClear={onClearPayload}
            disabled={busy}
          >
            {rawField}
          </InvitationCard>
        ) : (
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
            {rawField}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {webMode ? t("web.pasteHint") : t("codeHint")}
            </p>
          </div>
        )}

        <Button type="submit" size="lg" disabled={busy || !payload.trim()} data-testid="pair-submit">
          {phase.kind === "pairing" ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          {phase.kind === "pairing" ? t("submitInProgress") : t("submit")}
        </Button>

        {failure ? (
          <PairFailurePanel
            failure={failure}
            action={phase.kind === "error" ? phase.action : undefined}
            onRetry={failure.retryable ? () => void onPair() : undefined}
            onStartOver={payload ? onClearPayload : undefined}
          />
        ) : null}
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
