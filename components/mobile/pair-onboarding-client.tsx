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

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Spinner } from "@/components/ui/spinner"
import { hydrateCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

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
}

const EMPTY_SELECTION: Selection = {
  baseUrl: "",
  pairJwt: "",
  fingerprint: "",
  locked: false,
}

export function PairOnboardingClient() {
  const router = useRouter()
  const t = useTranslations("mobile.pair")

  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [step, setStep] = useState<PairStepName>("discover")
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)

  // Hydrate cache from storage on mount; if a config exists, jump to the
  // paired step and let the user verify before continuing to chat.
  useEffect(() => {
    let cancelled = false
    void hydrateCompanionConfig()
      .then((cfg) => {
        if (cancelled) return
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
          setStep("discover")
        }
      })
      .catch(() => {
        if (cancelled) return
        setPhase({ kind: "unpaired" })
        setStep("discover")
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSelectServer = useCallback((server: DiscoveredServer) => {
    setSelection({
      baseUrl: server.baseUrl,
      pairJwt: "",
      fingerprint: server.fingerprint ?? "",
      locked: true,
    })
    setStep("pair")
  }, [])

  const onSkipDiscover = useCallback(() => {
    setSelection(EMPTY_SELECTION)
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
    setSelection(EMPTY_SELECTION)
    setStep("discover")
  }, [])

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

  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col gap-4 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] safe-area-pt sm:max-w-lg sm:px-6 md:max-w-xl"
      data-testid="pair-onboarding"
      data-step={step}
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        <PairStepper current={step} />
      </header>

      {step === "discover" ? (
        <DiscoverStep onSelect={onSelectServer} onSkip={onSkipDiscover} />
      ) : null}

      {step === "pair" ? (
        <PairStep
          key={`${selection.baseUrl}|${selection.pairJwt}|${selection.fingerprint}`}
          prefilledBaseUrl={selection.baseUrl}
          prefilledPairJwt={selection.pairJwt}
          prefilledFingerprint={selection.fingerprint}
          lockBaseUrl={selection.locked}
          onPaired={onPaired}
          onBack={onBackToDiscover}
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
    </main>
  )
}
