"use client"

/**
 * Mobile Pair Onboarding (Capacitor `/pair`).
 *
 * Coordinator for a three-step wizard:
 *
 *   1. **Discover** — auto-scan the LAN for cognia desktops via mDNS, with
 *      an IP-segment fallback driven by the WebRTC ICE-candidate trick.
 *      Tapping a server prefills its baseUrl on step 2.
 *   2. **Pair** — QR scanner + manual baseUrl/JWT form. POSTs to
 *      `/api/v1/auth/pair`, persists the device JWT through
 *      `companion-storage` (SecureStorage on Capacitor, localStorage on web).
 *   3. **Paired** — connection-health card with refresh probe, diagnostics
 *      collapsible, and a sign-out trigger guarded by biometrics.
 *
 * The coordinator owns the step state and a small set of navigation
 * callbacks; every other piece of behavior lives inside the matching
 * step component (`components/mobile/pair/*`). The validation /
 * error-formatting helpers used to live here directly — they were moved
 * to `pair-helpers.ts` and are re-exported below to keep
 * `import { validateBaseUrl } from "@/components/mobile/pair-onboarding-client"`
 * working for the existing test suite.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { usePlatform } from "@/hooks/use-platform"
import { mobileTransition } from "@/lib/ui/motion"
import { buildTimeServerUrl } from "@/lib/platform/web-companion"
import { hydrateCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import { loadRecentServers, recentServersToDiscovered } from "@/lib/connectivity/recent-servers"

import { DiscoverStep } from "./pair/discover-step"
import { PairStep } from "./pair/pair-step"
import { PairedStep } from "./pair/paired-step"
import { PairStepper, type PairStep as PairStepName } from "./pair/pair-stepper"

export {
  describeHttpError,
  describeNetworkError,
  validateBaseUrl,
  validatePairJwt,
} from "./pair/pair-helpers"

type PhaseLoading = { kind: "loading" }
type PhaseUnpaired = { kind: "unpaired" }
type PhasePaired = {
  kind: "paired"
  baseUrl: string
  deviceId: string
  serverVersion: string
}
type Phase = PhaseLoading | PhaseUnpaired | PhasePaired

interface Selection {
  baseUrl: string
  pairJwt: string
  fingerprint: string
  locked: boolean
  autoScan: boolean
}

const EMPTY_SELECTION: Selection = {
  baseUrl: "",
  pairJwt: "",
  fingerprint: "",
  locked: false,
  autoScan: false,
}

/** Stepper steps shown on a plain browser — there is no LAN discovery. */
const WEB_STEPS: readonly PairStepName[] = ["pair", "paired"] as const

/** Reveal the manual-entry escape on the loading screen after this long. */
const SLOW_HINT_MS = 2500
/** Hard ceiling: stop waiting on hydration and show the discover step. */
const CEILING_MS = 8000

export function PairOnboardingClient() {
  const router = useRouter()
  const t = useTranslations("mobile.pair")
  // ADR-0059 C2 — a plain browser has no camera plugin and no LAN to scan:
  // skip the Discover step, land straight on the manual pair form, and
  // pre-fill (and lock) the server URL when the deployment baked one in via
  // NEXT_PUBLIC_COGNIA_SERVER_URL.
  const platform = usePlatform()
  const isWebHost = platform === "web"
  const unpairedStep: PairStepName = isWebHost ? "pair" : "discover"
  const unpairedSelection = useMemo<Selection>(() => {
    if (!isWebHost) return EMPTY_SELECTION
    const envUrl = buildTimeServerUrl()
    return { ...EMPTY_SELECTION, baseUrl: envUrl ?? "", locked: envUrl !== null }
  }, [isWebHost])

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
  const reduce = useReducedMotion()
  // Recently-paired servers (localStorage) — surfaced as the Discover step's
  // "Recent" group so the user can one-tap reconnect even after sign-out.
  // Read once on mount (synchronous; localStorage is hot for first paint).
  const [recentServers] = useState<DiscoveredServer[]>(() =>
    recentServersToDiscovered(loadRecentServers())
  )

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
        if (cfg) {
          setPhase({
            kind: "paired",
            baseUrl: cfg.baseUrl,
            deviceId: cfg.deviceId,
            serverVersion: cfg.serverVersion,
          })
          setStep("paired")
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
    // unpairedStep/-Selection are platform-derived and stable after mount.
  }, [unpairedStep, unpairedSelection])

  const onSkipLoading = useCallback(() => {
    setPhase({ kind: "unpaired" })
    setSelection(unpairedSelection)
    setStep(unpairedStep)
  }, [unpairedStep, unpairedSelection])

  const onSelectServer = useCallback((server: DiscoveredServer) => {
    setSelection({
      baseUrl: server.baseUrl,
      pairJwt: "",
      fingerprint: server.fingerprint ?? "",
      locked: true,
      autoScan: false,
    })
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

  const onContinueToChat = useCallback(() => {
    router.push("/")
  }, [router])

  const onAfterSignOut = useCallback(() => {
    setPhase({ kind: "unpaired" })
    setSelection(unpairedSelection)
    setStep(unpairedStep)
  }, [unpairedStep, unpairedSelection])

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
      className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col gap-4 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] safe-area-pt sm:max-w-lg sm:px-6 md:max-w-xl"
      data-testid="pair-onboarding"
      data-step={step}
    >
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
              key={`${selection.baseUrl}|${selection.pairJwt}|${selection.fingerprint}`}
              prefilledBaseUrl={selection.baseUrl}
              prefilledPairJwt={selection.pairJwt}
              prefilledFingerprint={selection.fingerprint}
              lockBaseUrl={selection.locked}
              autoScan={selection.autoScan}
              webMode={isWebHost}
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
    </main>
  )
}
