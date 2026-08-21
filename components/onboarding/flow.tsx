"use client"

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import type { Character, OnboardingPath, OnboardingStepId } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { FirstRunStep } from "./steps/first-run-step"
import { ProviderStep, type ProviderView } from "./steps/provider-step"
import { ScanStep } from "./steps/scan-step"
import { StepShell } from "./step-shell"
import { WelcomeStep } from "./steps/welcome-step"
import { applyMigration, buildMigrationPreview } from "@/lib/agent-migration/run"
import { countSessions, createSession } from "@/lib/db/sessions"
import { detectPlatform } from "@/lib/platform/detect"
import { useModelAccess } from "@/hooks/onboarding/use-model-access"
import { listCharacters } from "@/lib/db/characters"
import { loggers } from "@cognia/logging"
import { nextStep, previousStep, resolveStepSequence, resumeStep } from "@/lib/onboarding/steps"
import { queuePendingChatPrompt } from "@/lib/chat/pending-prompt"
import { resolveOnboardingShell } from "@/lib/onboarding/shell"
import { setMobileRuntimeMode, type MobileRuntimeMode } from "@/lib/runtime/standalone-mode"
import { useClientLiveQuery } from "@/hooks/data"
import { useHistoryImport } from "@/hooks/onboarding/use-history-import"
import { useMachineScan } from "@/hooks/onboarding/use-machine-scan"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { MIGRATION_ARTIFACTS, type MigrationVendor } from "@/lib/agent-migration/types"
import type { StarterCard } from "@/lib/onboarding/starter-cards"

const log = loggers.ui.child("onboarding-flow")

/** Everything the vendor migration brings over EXCEPT the conversations. */
const MIGRATION_CONFIG_ARTIFACTS = MIGRATION_ARTIFACTS.filter((a) => a !== "sessions")

/** Where a completed or abandoned flow lands. */
const APP_ROUTE = "/"
const PAIR_ROUTE = "/pair"

/**
 * The first-run flow (ADR-0122).
 *
 * Owns step order, exit paths, and the terminal action. Every step body is a
 * child component; this file decides *which* one and *what happens next*, so
 * the sequencing rules live in one place instead of being spread across the
 * steps the way the old dialog spread them across three inline sub-components.
 *
 * All four exit paths persist a record before navigating, because "how did
 * this end" is what the residual finish-setup bar reads to say something
 * specific. That is the whole reason the old single `onboardingDismissedAt`
 * timestamp was not enough.
 */
export function OnboardingFlow() {
  const t = useTranslations("onboarding")
  const router = useRouter()

  const settings = useSettingsStore((s) => s.settings)
  const advanceOnboarding = useSettingsStore((s) => s.advanceOnboarding)
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding)
  const skipOnboarding = useSettingsStore((s) => s.skipOnboarding)
  const setOnboardingProfile = useSettingsStore((s) => s.setOnboardingProfile)

  const shell = useMemo(
    () => resolveOnboardingShell(detectPlatform(), settings?.mobileRuntimeMode),
    [settings?.mobileRuntimeMode]
  )
  const scan = useMachineScan(shell)
  const history = useHistoryImport({ shell })
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const { paired: companionPaired, loading: companionLoading } = useCompanionConfig()
  const pairingGateClosed = shell === "mobile-paired" && (companionLoading || !companionPaired)

  // Whether this device arrived with model access, latched at the first
  // settled probe. It used to be derived inline from `settings.apiKey` and
  // `Boolean(settings.defaultProvider)` — the second of which is the active
  // *provider id*, not evidence of a credential, and is written by nothing in
  // the sign-in path. See `useModelAccess` for why it is latched rather than
  // live, and `hasModelAccess` for the three sources it folds together.
  const modelAccess = useModelAccess(scan.result)

  const sequence = useMemo(
    () => resolveStepSequence({ shell, hasModelAccess: modelAccess.resolved }),
    [shell, modelAccess.resolved]
  )

  const [step, setStep] = useState<OnboardingStepId>(() =>
    pairingGateClosed
      ? "scan"
      : (resumeStep(sequence, settings?.onboardingProgress?.lastStep) ?? "welcome")
  )
  const currentStep = step === "first-run" && pairingGateClosed ? "scan" : step
  const [busy, setBusy] = useState(false)
  // Which half of the provider step is showing. Owned here because the
  // action row is: while the key panel is up it carries the step's primary
  // button, and a second Continue beside it would be two ways to leave one
  // screen with different meanings.
  const [providerView, setProviderView] = useState<ProviderView>("chooser")

  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  // Someone with chats on this device (a Settings re-run, or a long-time user
  // who reached the flow some other way) gets "I've done this before" on the
  // welcome step. It is the *only* exit that step has — its footer carries no
  // Skip — so without it an experienced user can only move forward.
  const sessionCount = useClientLiveQuery<number>(() => countSessions(), [], 0)
  const [characterId, setCharacterId] = useState<string | null>(
    settings?.onboardingProfile?.characterId ?? null
  )
  // The builtin set is seeded by a plugin, so on a genuine first run this is
  // briefly empty. Falling back to the first available one (rather than
  // rendering an empty picker) keeps the step usable the moment seeding lands.
  const character = characters?.find((c) => c.id === characterId) ?? characters?.[0] ?? null

  const goTo = useCallback(
    (next: OnboardingStepId) => {
      setStep(next)
      // The provider step's view is local state, so leaving it remounts at the
      // chooser. Without resetting the flow's copy, a return visit would keep
      // hiding the Continue that the chooser is the one view to need.
      setProviderView("chooser")
      void advanceOnboarding(next)
    },
    [advanceOnboarding]
  )

  const advance = useCallback(() => {
    if (currentStep === "scan" && pairingGateClosed) return
    const next = nextStep(sequence, currentStep)
    if (next) goTo(next)
  }, [currentStep, pairingGateClosed, sequence, goTo])

  const back = useCallback(() => {
    const prev = previousStep(sequence, currentStep)
    if (prev) goTo(prev)
  }, [sequence, currentStep, goTo])

  const leave = useCallback(
    async (path: OnboardingPath) => {
      log.info("onboarding exit", { path, step: currentStep, shell })
      await skipOnboarding(path, currentStep)
      router.replace(APP_ROUTE)
    },
    [currentStep, router, skipOnboarding, shell]
  )

  /** Skip reasons differ by step, so the finish bar can name what is missing. */
  const skipPathForStep = (id: OnboardingStepId): OnboardingPath =>
    id === "provider" ? "provider_skipped" : "runtime_skipped"

  /**
   * "I've done this before" is not a skip: the user is telling us they are
   * already set up, so it records `completed` — nothing is missing, and the
   * finish bar must not nag them about a runtime they already have.
   */
  const skipExisting = useCallback(async () => {
    log.info("onboarding exit", {
      path: "completed",
      step: currentStep,
      shell,
      reason: "existing-user",
    })
    await completeOnboarding()
    router.replace(APP_ROUTE)
  }, [completeOnboarding, currentStep, router, shell])

  const handlePickMode = useCallback(
    async (mode: MobileRuntimeMode) => {
      await setMobileRuntimeMode(mode)
      // The shell (and therefore the sequence) is derived from this choice, so
      // recompute rather than reusing the stale `sequence` closure.
      const nextShell = resolveOnboardingShell(detectPlatform(), mode)
      const nextSequence = resolveStepSequence({
        shell: nextShell,
        hasModelAccess: modelAccess.resolved,
      })
      const next = nextStep(nextSequence, "welcome")
      if (next) goTo(next)
    },
    [goTo, modelAccess.resolved]
  )

  const handleImport = useCallback(async (vendor: MigrationVendor) => {
    log.info("onboarding migration start", { vendor })
    // Conversations are NOT part of this pass: the step's history block owns
    // them, and it covers every ADR-0062 source rather than only the four
    // vendors the config migration has rows for. Leaving `sessions` in here
    // too would import the same transcripts twice over — idempotent, but it
    // would also double the wait behind a button that says "settings".
    const wanted = MIGRATION_CONFIG_ARTIFACTS
    const preview = await buildMigrationPreview(vendor, wanted)
    const artifacts = wanted.filter((a) => preview.artifacts[a]?.status === "ready")
    if (artifacts.length === 0) return
    await applyMigration({ vendor, artifacts, strategy: "skip", preview })
    log.info("onboarding migration done", { vendor, artifacts })
  }, [])

  const handleImportHistory = useCallback(async () => {
    log.info("onboarding history import start", { total: history.total })
    await history.importAll(activeProjectId ?? undefined)
    log.info("onboarding history import done")
  }, [history, activeProjectId])

  const handlePickCard = useCallback(
    async (card: StarterCard) => {
      if (pairingGateClosed) return
      if (!character) throw new Error("No character available to run the first task")
      log.info("onboarding first-run pick", { card: card.id, characterId: character.id })
      const session = await createSession({
        title: t(`cards.${card.key}.title`),
        kind: "direct",
        characterId: character.id,
      })
      // The chat pane consumes this on mount and sends it as a normal turn, so
      // the first output goes through exactly the production send path.
      queuePendingChatPrompt(session.id, t(`cards.${card.key}.prompt`))
      await setOnboardingProfile({ intent: card.id, characterId: character.id })
      await completeOnboarding()
      router.replace(APP_ROUTE)
    },
    [character, completeOnboarding, pairingGateClosed, router, setOnboardingProfile, t]
  )

  const showBack = previousStep(sequence, currentStep) !== null
  const runtimeLabel = scan.result.runtimes[0]?.label
  const showSkip = !(currentStep === "scan" && pairingGateClosed)
  // The first-run step's cards *are* its forward action, and the API-key
  // panel's Save is its own — both would be shadowed by a generic Continue.
  const showContinue =
    currentStep !== "first-run" && !(currentStep === "provider" && providerView === "apiKey")

  const footer =
    currentStep === "welcome" ? undefined : (
      <>
        {showSkip && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void leave(skipPathForStep(currentStep))}
            data-testid="onboarding-skip"
          >
            {t("skip")}
          </Button>
        )}
        {showContinue && (
          <Button
            size="sm"
            onClick={advance}
            disabled={currentStep === "scan" && pairingGateClosed}
            data-testid="onboarding-continue"
          >
            {t("continue")}
          </Button>
        )}
      </>
    )

  return (
    <StepShell
      sequence={sequence}
      current={currentStep}
      onStepChange={goTo}
      onBack={showBack ? back : undefined}
      busy={busy}
      footer={footer}
    >
      {currentStep === "welcome" && (
        <WelcomeStep
          shell={shell}
          onNext={advance}
          onSkipExisting={(sessionCount ?? 0) > 0 ? skipExisting : undefined}
          onPickMode={
            shell === "mobile-standalone" || shell === "mobile-paired" ? handlePickMode : undefined
          }
        />
      )}

      {currentStep === "scan" && (
        <ScanStep
          shell={shell}
          scan={scan}
          history={history}
          onImportHistory={handleImportHistory}
          onImport={async (vendor) => {
            setBusy(true)
            try {
              await handleImport(vendor)
            } finally {
              setBusy(false)
            }
          }}
          onOpenPairing={() => router.push(PAIR_ROUTE)}
        />
      )}

      {currentStep === "provider" && <ProviderStep onViewChange={setProviderView} />}

      {currentStep === "first-run" && (
        <FirstRunStep
          shell={shell}
          capabilities={scan.result.capabilities}
          modelAccess={modelAccess.value}
          onConnectModel={
            sequence.some((step) => step.id === "provider") ? () => goTo("provider") : undefined
          }
          character={character}
          onChangeCharacter={() => {
            const list = characters ?? []
            if (list.length < 2) return
            const idx = list.findIndex((c) => c.id === character?.id)
            setCharacterId(list[(idx + 1) % list.length]!.id)
          }}
          onPick={handlePickCard}
          runtimeLabel={runtimeLabel}
        />
      )}
    </StepShell>
  )
}
