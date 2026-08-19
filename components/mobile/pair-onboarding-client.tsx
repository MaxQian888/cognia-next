"use client"

/**
 * Mobile Pair Onboarding (Capacitor `/pair`).
 *
 * Coordinator for a three-step wizard:
 *
 *   1. **Discover** — auto-scan the LAN for cognia desktops via mDNS, with
 *      an IP-segment fallback driven by the WebRTC ICE-candidate trick.
 *      Discovery remains informational because registration requires a fresh
 *      one-shot Owner invitation.
 *   2. **Pair** — scans or pastes a cgnp3 payload, registers an ES256 device
 *      identity, and persists only its private key in secure storage.
 *   3. **Paired** — connection-health card with refresh probe, diagnostics
 *      collapsible, and a sign-out trigger guarded by biometrics.
 *
 * The coordinator owns the step state and a small set of navigation
 * callbacks; every other piece of behavior lives inside the matching
 * step component (`components/mobile/pair/*`). Pairing accepts only a complete
 * cgnp3 invitation payload; the legacy URL + JWT form is intentionally absent.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { usePlatform } from "@/hooks/use-platform"
import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { companionCredentialBook, type CompanionHostRecord } from "@/lib/companion/credential-book"
import {
  pairAndActivateCompanionHost,
  switchCompanionHost,
} from "@/lib/companion/host-orchestration"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { mobileTransition } from "@/lib/ui/motion"
import { hydrateCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import {
  loadRecentServers,
  recentServersToDiscovered,
  type RecentServer,
} from "@/lib/connectivity/recent-servers"
import { readPairLinkPayload, stripPairLinkPayload } from "@/lib/qr/pair-link"

import { DiscoverStep } from "./pair/discover-step"
import { PairStep } from "./pair/pair-step"
import { PairedStep } from "./pair/paired-step"
import { PairStepper, type PairStep as PairStepName } from "./pair/pair-stepper"

type PhaseLoading = { kind: "loading" }
type PhaseUnpaired = { kind: "unpaired" }
type PhasePaired = {
  kind: "paired"
  baseUrl: string
  deviceId: string
  serverVersion: string
}
type Phase = PhaseLoading | PhaseUnpaired | PhasePaired

export interface Selection {
  pairPayload: string
  autoScan: boolean
  /**
   * Redeem the payload without a second click. Only ever set for an invitation
   * the user *arrived with* — a desktop "pair in browser" link or a `cognia://`
   * deep link — where asking them to press Submit on a code they never typed is
   * pure friction. Clipboard and manual entry always stay confirm-first.
   */
  autoSubmit?: boolean
}

const EMPTY_SELECTION: Selection = {
  pairPayload: "",
  autoScan: false,
}

/** Stepper steps shown on a plain browser — there is no LAN discovery. */
const WEB_STEPS: readonly PairStepName[] = ["pair", "paired"] as const

/**
 * Params other surfaces navigate here with:
 *   - `#payload=<cgnp3|…>`       — a complete one-shot invitation handed over
 *     by the desktop Host's "pair in browser" action, or by a `cognia://`
 *     deep link (which writes the equivalent `?payload=`). Redeemed on
 *     arrival; see {@link resolveParamSelection}.
 *   - `?baseUrl=…&fingerprint=…` — the connection-state scan sheet's
 *     "tap a discovered server" path: pre-fill and lock the pair form.
 *   - `?switchTo=<deviceId>`     — the paired-servers sheet's switch path:
 *     resolve the device to a recent-server entry (recorded at pair time
 *     with `label = deviceId.slice(0, 8)`) and pre-fill its baseUrl so the
 *     user re-validates against that server without typing anything.
 */
export interface PairPageParams {
  mode?: "default" | "add" | "recover"
  state?: "offline" | "incompatible" | "requires-grant" | null
  requiredGrant?: string | null
  switchTo: string | null
  baseUrl: string | null
  fingerprint: string | null
  /** Complete `cgnp3|…` invitation carried by the fragment or query. */
  payload: string | null
}

export function readPairParams(search?: string, hash?: string): PairPageParams {
  if (typeof window === "undefined" && search === undefined) {
    return {
      mode: "default",
      state: null,
      requiredGrant: null,
      switchTo: null,
      baseUrl: null,
      fingerprint: null,
      payload: null,
    }
  }
  const rawSearch = search ?? window.location.search
  const rawHash = hash ?? (typeof window === "undefined" ? "" : window.location.hash)
  const p = new URLSearchParams(rawSearch)
  const rawMode = p.get("mode")
  const rawState = p.get("state")
  return {
    mode: rawMode === "add" || rawMode === "recover" ? rawMode : "default",
    state:
      rawState === "offline" || rawState === "incompatible" || rawState === "requires-grant"
        ? rawState
        : null,
    requiredGrant: p.get("requiredGrant"),
    switchTo: p.get("switchTo"),
    baseUrl: p.get("baseUrl"),
    fingerprint: p.get("fingerprint"),
    payload: readPairLinkPayload(rawSearch, rawHash),
  }
}

/**
 * Turn the incoming params into a pair-step selection, or `null` for a plain
 * `/pair` visit.
 *
 * Only a complete invitation qualifies. `baseUrl` / `switchTo` deliberately do
 * not: Owner invitations are one-shot and are never stored in recent-server
 * records, so a server address alone cannot pre-fill anything redeemable —
 * re-pairing always needs a fresh cgnp3 payload from the Host.
 */
export function resolveParamSelection(
  params: PairPageParams,
  _recents: RecentServer[]
): Selection | null {
  if (!params.payload) return null
  return { pairPayload: params.payload, autoScan: false, autoSubmit: true }
}

/** Reveal the manual-entry escape on the loading screen after this long. */
const SLOW_HINT_MS = 2500
/** Hard ceiling: stop waiting on hydration and show the discover step. */
const CEILING_MS = 8000

export function PairOnboardingClient() {
  const router = useRouter()
  const t = useTranslations("mobile.pair")
  // A plain browser has no camera plugin or LAN discovery, so it lands on the
  // form where the user pastes the complete one-shot cgnp3 payload.
  const platform = usePlatform()
  const isWebHost = platform === "web"
  const unpairedStep: PairStepName = isWebHost ? "pair" : "discover"
  const unpairedSelection = useMemo<Selection>(() => EMPTY_SELECTION, [])

  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [step, setStep] = useState<PairStepName>("discover")
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  // `true` once hydration has been slow enough to warrant a manual escape on
  // the loading screen. The full-page spinner used to be a dead end: if the
  // SecureStorage round-trip stalled on device (observed after sign-out),
  // there was no way out and the user was stuck on "checking for an existing
  // pairing" forever. We now reveal a "set up manually" affordance early and
  // hard-fall-through to the discover step as a backstop.
  const [hydrateSlow, setHydrateSlow] = useState(false)
  const [recoveryHosts, setRecoveryHosts] = useState<CompanionHostRecord[]>([])
  const [pendingRecoveryHostId, setPendingRecoveryHostId] = useState<string | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const reduce = useReducedMotion()
  // Recently-paired servers (localStorage) — surfaced as the Discover step's
  // "Recent" group so the user can one-tap reconnect even after sign-out.
  // Read once on mount (synchronous; localStorage is hot for first paint).
  const [recentServers] = useState<DiscoveredServer[]>(() =>
    recentServersToDiscovered(loadRecentServers())
  )
  // Incoming `?baseUrl=…` / `?switchTo=…` navigation (scan sheet / switch
  // sheet). Read once on mount; resolved against the recent-server log.
  const [paramSelection] = useState<Selection | null>(() =>
    resolveParamSelection(readPairParams(), loadRecentServers())
  )
  const [pairParams] = useState<PairPageParams>(() => readPairParams())
  const switchToParam = pairParams.switchTo

  // Spend the link the moment it is read into state. A one-shot invitation is
  // consumed by the first registration, so leaving it in the address bar turns
  // a refresh into "invitation already used" and parks a live secret in the
  // user's history until it expires.
  useEffect(() => {
    if (!pairParams.payload || typeof window === "undefined") return
    stripPairLinkPayload(window)
  }, [pairParams.payload])

  useEffect(() => {
    if (pairParams.mode !== "recover") return
    const accountId = platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : getActiveRuntimeTargetContext()?.accountId
    if (!accountId) return
    void companionCredentialBook().list(accountId).then(setRecoveryHosts).catch(() => setRecoveryHosts([]))
  }, [pairParams.mode, platform])

  // Hydrate cache from storage on mount; if a config exists, jump to the
  // paired step and let the user verify before continuing to chat.
  //
  // The hydrate is wrapped in two timers so the loading screen can never
  // become a dead end:
  //   • SLOW_HINT_MS — surface a manual-entry button + reassurance copy.
  //   • CEILING_MS   — give up waiting and drop the user on the discover
  //     step. Re-pairing from there still works even if the storage read
  //     never settled (a fresh pair overwrites whatever was stuck).
  useEffect(() => {
    let cancelled = false
    let settled = false

    const fallThrough = () => {
      if (cancelled || settled) return
      settled = true
      setPhase({ kind: "unpaired" })
      setSelection(unpairedSelection)
      setStep(unpairedStep)
    }

    const slowTimer = setTimeout(() => {
      if (!cancelled && !settled) setHydrateSlow(true)
    }, SLOW_HINT_MS)
    const ceilingTimer = setTimeout(fallThrough, CEILING_MS)

    const finish = () => {
      clearTimeout(slowTimer)
      clearTimeout(ceilingTimer)
    }

    void hydrateCompanionConfig()
      .then((cfg) => {
        if (cancelled || settled) return
        settled = true
        finish()
        if (cfg && pairParams.mode !== "add") {
          setPhase({
            kind: "paired",
            baseUrl: cfg.baseUrl,
            deviceId: cfg.deviceId,
            serverVersion: cfg.serverVersion,
          })
          // An invitation in the URL outranks an existing pairing: the user
          // followed a link a Host minted seconds ago, so showing them the
          // "you are already paired" card would strand a live invitation they
          // deliberately came here to redeem (re-pair, or add a second Host).
          const alreadyOnTarget =
            paramSelection === null && (switchToParam !== null ? cfg.deviceId === switchToParam : true)
          if (alreadyOnTarget) {
            setStep("paired")
          } else if (paramSelection) {
            setSelection(paramSelection)
            setStep("pair")
          } else {
            // switchTo for a device with no recent-server record — the
            // Discover step (with its Recent group) is the best landing.
            setSelection(unpairedSelection)
            setStep(unpairedStep)
          }
        } else if (paramSelection) {
          setPhase({ kind: "unpaired" })
          setSelection(paramSelection)
          setStep("pair")
        } else {
          setPhase({ kind: "unpaired" })
          setSelection(unpairedSelection)
          setStep(unpairedStep)
        }
      })
      .catch(() => {
        if (cancelled || settled) return
        settled = true
        finish()
        setPhase({ kind: "unpaired" })
        setSelection(unpairedSelection)
        setStep(unpairedStep)
      })

    return () => {
      cancelled = true
      finish()
    }
    // unpairedStep/-Selection are platform-derived and stable after mount;
    // paramSelection/switchToParam are read-once mount state.
  }, [unpairedStep, unpairedSelection, pairParams.mode, paramSelection, switchToParam])

  const onSkipLoading = useCallback(() => {
    setPhase({ kind: "unpaired" })
    setSelection(unpairedSelection)
    setStep(unpairedStep)
  }, [unpairedStep, unpairedSelection])

  const onSelectServer = useCallback((server: DiscoveredServer) => {
    void server
    setSelection(EMPTY_SELECTION)
    setStep("pair")
  }, [])

  const onSkipDiscover = useCallback(() => {
    setSelection(EMPTY_SELECTION)
    setStep("pair")
  }, [])

  // "Scan QR" shortcut from Discover — jump to the pair step with the camera
  // launching automatically.
  const onScanShortcut = useCallback(() => {
    setSelection({ ...EMPTY_SELECTION, autoScan: true })
    setStep("pair")
  }, [])

  const onBackToDiscover = useCallback(() => {
    setSelection(EMPTY_SELECTION)
    setStep("discover")
  }, [])

  const onPaired = useCallback((cfg: CompanionConfig) => {
    setPhase({
      kind: "paired",
      baseUrl: cfg.baseUrl,
      deviceId: cfg.deviceId,
      serverVersion: cfg.serverVersion,
    })
    setStep("paired")
  }, [])

  const persistPairing = useCallback(
    async (config: CompanionConfig) => {
      const accountId =
        getActiveRuntimeTargetContext()?.accountId ??
        (platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : config.accountId)
      if (!accountId) throw new Error(t("accountContextMissing"))
      await pairAndActivateCompanionHost({ accountId, platform: isWebHost ? "web" : "mobile", config })
    },
    [isWebHost, platform, t]
  )

  const onContinueToChat = useCallback(() => {
    router.push("/")
  }, [router])

  const onAfterSignOut = useCallback(() => {
    setPhase({ kind: "unpaired" })
    setSelection(unpairedSelection)
    setStep(unpairedStep)
  }, [unpairedStep, unpairedSelection])

  const onRecoverySwitch = useCallback(
    async (hostId: string) => {
      const accountId =
        getActiveRuntimeTargetContext()?.accountId ??
        (platform === "mobile" ? DEFAULT_LOCAL_ACCOUNT_ID : null)
      if (!accountId || pendingRecoveryHostId) return
      setPendingRecoveryHostId(hostId)
      setRecoveryError(null)
      try {
        await switchCompanionHost({
          accountId,
          hostId,
          platform: isWebHost ? "web" : "mobile",
          force: true,
        })
        const config = await hydrateCompanionConfig()
        if (config) onPaired(config)
      } catch (error) {
        setRecoveryError(
          t("recovery.switchFailed", {
            reason: error instanceof Error ? error.message : String(error),
          })
        )
      } finally {
        setPendingRecoveryHostId(null)
      }
    },
    [isWebHost, onPaired, pendingRecoveryHostId, platform, t]
  )

  if (phase.kind === "loading") {
    return (
      <main
        className="mx-auto flex min-h-[100dvh] max-w-md items-center justify-center safe-area-py safe-area-px"
        data-testid="pair-onboarding"
        data-step="loading"
      >
        <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">{t("loadingTitle")}</p>
          {hydrateSlow ? (
            <div className="flex flex-col items-center gap-2 pt-1">
              <p className="max-w-xs text-center text-xs text-muted-foreground">
                {t("loadingSlow")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSkipLoading}
                data-testid="pair-loading-skip"
              >
                {t("loadingManualCta")}
              </Button>
            </div>
          ) : null}
        </div>
      </main>
    )
  }

  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-4 py-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] safe-area-pt sm:max-w-lg sm:px-6 md:max-w-xl"
      data-testid="pair-onboarding"
      data-step={step}
      data-mode={pairParams.mode}
    >
      <div className="my-auto flex w-full flex-col gap-4" data-testid="pair-onboarding-content">
        <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {isWebHost ? t("web.title") : t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isWebHost ? t("web.intro") : t("intro")}
          </p>
        </div>
        <PairStepper current={step} steps={isWebHost ? WEB_STEPS : undefined} />
        {pairParams.mode === "recover" ? (
          <div className="rounded-lg border bg-muted/60 p-3 text-sm" data-testid="pair-recovery-context">
            <p className="font-medium">{t(`recovery.${pairParams.state ?? "offline"}.title`)}</p>
            <p className="mt-1 text-muted-foreground">
              {pairParams.state === "requires-grant"
                ? t("recovery.requiresGrant.description", {
                    grant: pairParams.requiredGrant ?? t("recovery.requiresGrant.unknownGrant"),
                  })
                : t(`recovery.${pairParams.state ?? "offline"}.description`)}
            </p>
            {pairParams.state === "requires-grant" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("recovery.requiresGrant.instructions")}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {recoveryHosts.map((host) => (
                <Button
                  key={host.hostId}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pendingRecoveryHostId !== null}
                  onClick={() => void onRecoverySwitch(host.hostId)}
                >
                  {t("recovery.switchTo", { name: host.label })}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelection(EMPTY_SELECTION)
                  setStep("pair")
                }}
              >
                {t("recovery.repair")}
              </Button>
            </div>
            {recoveryError ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {recoveryError}
              </p>
            ) : null}
          </div>
        ) : null}
        </header>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -8 }}
            transition={mobileTransition("fast")}
          >
          {step === "discover" && !isWebHost ? (
            <DiscoverStep
              history={recentServers}
              onSelect={onSelectServer}
              onSkip={onSkipDiscover}
              onScanShortcut={onScanShortcut}
            />
          ) : null}

          {step === "pair" ? (
            <PairStep
              key={selection.pairPayload}
              prefilledPairPayload={selection.pairPayload}
              autoScan={selection.autoScan}
              autoSubmit={selection.autoSubmit}
              webMode={isWebHost}
              persistPairing={persistPairing}
              onPaired={onPaired}
              onBack={isWebHost ? undefined : onBackToDiscover}
            />
          ) : null}

          {step === "paired" && phase.kind === "paired" ? (
            <PairedStep
              baseUrl={phase.baseUrl}
              deviceId={phase.deviceId}
              serverVersion={phase.serverVersion}
              onContinue={onContinueToChat}
              onAfterSignOut={onAfterSignOut}
            />
          ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </main>
  )
}
