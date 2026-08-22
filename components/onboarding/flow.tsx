"use client"

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import type {
  Character,
  OnboardingMode,
  OnboardingPath,
  OnboardingStepId,
} from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { ExpressScene, type ExpressSceneItemState } from "./scenes/express-scene"
import { ExpressSignIn } from "./express-sign-in"
import { ExpressStep, type ExpressItemStatus, type ExpressPhase } from "./steps/express-step"
import { FirstRunScene } from "./scenes/first-run-scene"
import { FirstRunStep } from "./steps/first-run-step"
import { ProviderScene } from "./scenes/provider-scene"
import { ProviderStep, type ProviderView } from "./steps/provider-step"
import { ScanScene } from "./scenes/scan-scene"
import { ScanStep } from "./steps/scan-step"
import { StepShell } from "./step-shell"
import { WelcomeScene } from "./scenes/welcome-scene"
import { WelcomeStep } from "./steps/welcome-step"
import { applyMigration, buildMigrationPreview } from "@/lib/agent-migration/run"
import { buildExpressPlan, selectedActions, withSelection } from "@/lib/onboarding/express-plan"
import { countSessions, createSession } from "@/lib/db/sessions"
import { detectPlatform } from "@/lib/platform/detect"
import { resolveOnboardingMode } from "@cognia/agent-config-types"
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
import type { ExpressPlanItem } from "@/lib/onboarding/express-plan"
import type { StarterCard } from "@/lib/onboarding/starter-cards"

const log = loggers.ui.child("onboarding-flow")

/** Everything the vendor migration brings over EXCEPT the conversations. */
const MIGRATION_CONFIG_ARTIFACTS = MIGRATION_ARTIFACTS.filter((a) => a !== "sessions")

/** Where a completed or abandoned flow lands. */
const APP_ROUTE = "/"
const PAIR_ROUTE = "/pair"

/**
 * The first-run flow.
 *
 * Owns step order, the path fork, exit paths, and the terminal action. Every
 * step body is a child component; this file decides *which* one, *what happens
 * next*, and — for the recommended path — *what actually runs*, so the
 * sequencing rules live in one place instead of being spread across the steps
 * the way the old dialog spread them across three inline sub-components.
 *
 * ## Two paths, one sequence resolver
 *
 * The welcome screen forks. `resolveStepSequence` takes the answer and returns
 * either `welcome → express` or the four-step `welcome → scan? → provider? →
 * first-run`; nothing downstream needs to know which path it is on, because
 * the sequence already encodes it. Before the fork is answered the sequence is
 * the intro alone, which is what keeps Back and Continue honest on that screen.
 *
 * ## Why execution lives here rather than in the express step
 *
 * `applyMigration` and the history import both write to the user's machine and
 * both already had a caller here, from the step-by-step path. Giving the
 * recommended screen its own copies would mean two call sites that must agree
 * about artifact selection (conversations are excluded from the config
 * migration on purpose — the history pass covers every ADR-0062 source, not
 * just the four vendors with config rows, and running both would import the
 * same transcripts twice).
 *
 * ## Exit paths
 *
 * All four persist a record before navigating, because "how did this end" is
 * what the residual finish-setup bar reads to say something specific. That is
 * the whole reason the old single `onboardingDismissedAt` timestamp was not
 * enough.
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
  // settled probe. See `useModelAccess` for why it is latched rather than
  // live, and `hasModelAccess` for the sources it folds together.
  const modelAccess = useModelAccess(scan.result)

  // Which path. Persisted, so a resumed setup does not re-ask — and derived
  // from `lastStep` for records written before the fork existed.
  const [mode, setMode] = useState<OnboardingMode | undefined>(() =>
    resolveOnboardingMode(settings?.onboardingProgress)
  )

  const sequence = useMemo(
    () => resolveStepSequence({ shell, mode, hasModelAccess: modelAccess.resolved }),
    [shell, mode, modelAccess.resolved]
  )

  const [step, setStep] = useState<OnboardingStepId>(
    () => resumeStep(sequence, settings?.onboardingProgress?.lastStep) ?? "welcome"
  )
  // A paired phone that has not paired yet cannot be on the terminal step: its
  // compute is on the other side of a handshake that has not happened.
  const currentStep = step === "first-run" && pairingGateClosed ? "scan" : step
  const [busy, setBusy] = useState(false)
  // Which half of the sign-in step is showing. Owned here because the action
  // row is: while the key panel is up it carries the step's primary button,
  // and a second Continue beside it would be two ways to leave one screen with
  // different meanings.
  const [providerView, setProviderView] = useState<ProviderView>("chooser")

  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  // Someone with chats on this device (a Settings re-run, or a long-time user
  // who reached the flow some other way) gets "I've done this before" on the
  // welcome step.
  const sessionCount = useClientLiveQuery<number>(() => countSessions(), [], 0)
  const [characterId, setCharacterId] = useState<string | null>(
    settings?.onboardingProfile?.characterId ?? null
  )
  // The builtin set is seeded by a plugin, so on a genuine first run this is
  // briefly empty. Falling back to the first available one (rather than
  // rendering an empty picker) keeps the step usable the moment seeding lands.
  const character = characters?.find((c) => c.id === characterId) ?? characters?.[0] ?? null

  // ---------------------------------------------------------------------
  // The recommended path's plan
  // ---------------------------------------------------------------------

  const [expressPhase, setExpressPhase] = useState<ExpressPhase>("plan")
  const [expressStatus, setExpressStatus] = useState<Record<string, ExpressItemStatus>>({})
  // Lines the user unchecked. Held here rather than in the step because the
  // narrative panel's scene draws the same selection — a copy in each would
  // let the picture and the list disagree about what is going to run.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set())

  const toggleExpressItem = useCallback((id: string) => {
    setDropped((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Rebuilt whenever a probe settles, so the checkbox state is folded back in
  // from `dropped` rather than living on the item objects. `withSelection`
  // keeps required lines selected regardless — they are statements of fact.
  const plan = useMemo(() => {
    const built = buildExpressPlan({
      shell,
      scan: scan.result,
      historyTotal: history.total,
      modelAccess: modelAccess.value,
      paired: companionLoading ? null : companionPaired,
    })
    return withSelection(
      built,
      built.filter((item) => !dropped.has(item.id)).map((item) => item.id)
    )
  }, [
    shell,
    scan.result,
    history.total,
    modelAccess.value,
    companionLoading,
    companionPaired,
    dropped,
  ])

  const goTo = useCallback(
    (next: OnboardingStepId, nextMode?: OnboardingMode) => {
      setStep(next)
      // The sign-in step's view is local state, so leaving it remounts at the
      // chooser. Without resetting the flow's copy, a return visit would keep
      // hiding the Continue that the chooser is the one view to need.
      setProviderView("chooser")
      void advanceOnboarding(next, nextMode ?? mode)
    },
    [advanceOnboarding, mode]
  )

  /** Answers the welcome fork and moves to whichever step that path starts on. */
  const pickMode = useCallback(
    (next: OnboardingMode) => {
      setMode(next)
      // Recompute rather than reusing the stale `sequence` closure: the mode
      // is precisely what decides which steps exist.
      const nextSequence = resolveStepSequence({
        shell,
        mode: next,
        hasModelAccess: modelAccess.resolved,
      })
      const target = nextStep(nextSequence, "welcome")
      if (target) goTo(target, next)
    },
    [goTo, shell, modelAccess.resolved]
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
      log.info("onboarding exit", { path, step: currentStep, shell, mode })
      await skipOnboarding(path, currentStep)
      router.replace(APP_ROUTE)
    },
    [currentStep, mode, router, skipOnboarding, shell]
  )

  /** Skip reasons differ by step, so the finish bar can name what is missing. */
  const skipPathForStep = (id: OnboardingStepId): OnboardingPath => {
    if (id === "provider") return "provider_skipped"
    // The recommended screen carries the sign-in line, so bailing out of it is
    // the same omission the step-by-step path records as `provider_skipped` —
    // reporting it as a missing runtime would make the finish bar name the
    // wrong thing.
    if (id === "express")
      return plan.some((item) => item.kind === "sign-in") ? "provider_skipped" : "runtime_skipped"
    return "runtime_skipped"
  }

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

  const handlePickRuntimeMode = useCallback(async (runtimeMode: MobileRuntimeMode) => {
    // Commits the choice without advancing: the welcome screen asks two
    // questions now — how this phone runs, and how much it wants to be asked —
    // and the path fork below is what moves on.
    await setMobileRuntimeMode(runtimeMode)
  }, [])

  const handleImport = useCallback(async (vendor: MigrationVendor) => {
    log.info("onboarding migration start", { vendor })
    // Conversations are NOT part of this pass: the history import owns them,
    // and it covers every ADR-0062 source rather than only the four vendors
    // the config migration has rows for. Leaving `sessions` in here too would
    // import the same transcripts twice over.
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

  /**
   * Run the plan the user confirmed.
   *
   * Sequential rather than concurrent, and in the plan's own order: the config
   * migration writes the skills and subagents a transcript may reference, so a
   * history import racing ahead of it can land conversations pointing at
   * things that do not exist yet.
   *
   * A failed line is recorded and the run continues. The point of the flow is
   * to reach a first output, and a vendor whose config could not be read is
   * not a reason to deny the user that — the step-by-step path makes the same
   * call, and Settings → Data can retry.
   */
  const runPlan = useCallback(async () => {
    const chosen = selectedActions(plan)
    log.info("onboarding express apply", { items: chosen.map((item) => item.id) })
    setExpressPhase("applying")
    setBusy(true)
    try {
      for (const item of chosen) {
        setExpressStatus((prev) => ({ ...prev, [item.id]: "running" }))
        try {
          if (item.kind === "migrate-config" && item.vendor) await handleImport(item.vendor)
          else if (item.kind === "import-history") await handleImportHistory()
          setExpressStatus((prev) => ({ ...prev, [item.id]: "done" }))
        } catch (err) {
          log.error("onboarding express item failed", err)
          setExpressStatus((prev) => ({ ...prev, [item.id]: "failed" }))
        }
      }
    } finally {
      setBusy(false)
      setExpressPhase("ready")
    }
  }, [plan, handleImport, handleImportHistory])

  const handlePickCard = useCallback(
    async (card: StarterCard) => {
      if (pairingGateClosed) return
      if (!character) throw new Error("No character available to run the first task")
      log.info("onboarding first-run pick", { card: card.id, characterId: character.id, mode })
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
    [character, completeOnboarding, mode, pairingGateClosed, router, setOnboardingProfile, t]
  )

  const changeCharacter = useCallback(() => {
    const list = characters ?? []
    if (list.length < 2) return
    const idx = list.findIndex((c) => c.id === character?.id)
    setCharacterId(list[(idx + 1) % list.length]!.id)
  }, [characters, character])

  const showBack = previousStep(sequence, currentStep) !== null
  const runtimeLabel = scan.result.runtimes[0]?.label
  const showSkip = !(currentStep === "scan" && pairingGateClosed) && expressPhase !== "applying"
  // The terminal step's cards *are* its forward action, the key panel's Save is
  // its own, and the recommended screen's button is its own — all three would
  // be shadowed by a generic Continue.
  const showContinue =
    currentStep !== "first-run" &&
    currentStep !== "express" &&
    !(currentStep === "provider" && providerView === "apiKey")

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

  const firstRun = (
    <FirstRunStep
      shell={shell}
      capabilities={scan.result.capabilities}
      modelAccess={modelAccess.value}
      onConnectModel={
        sequence.some((entry) => entry.id === "provider") ? () => goTo("provider") : undefined
      }
      character={character}
      onChangeCharacter={changeCharacter}
      onPick={handlePickCard}
      runtimeLabel={runtimeLabel}
    />
  )

  return (
    <StepShell
      sequence={sequence}
      current={currentStep}
      onStepChange={goTo}
      onBack={showBack ? back : undefined}
      busy={busy}
      // "1 of 1" is not progress information, and the recommended screen shows
      // its own per-line progress while it runs.
      showStepper={mode !== "express"}
      // The recommended screen has two things to say: one before the button is
      // pressed and one after.
      narrativeKey={
        currentStep === "express" && expressPhase !== "plan" ? "express-applying" : undefined
      }
      scene={renderScene({
        step: currentStep,
        scan,
        historyTotal: history.total,
        plan,
        expressPhase,
        expressStatus,
        providerView,
      })}
      footer={footer}
    >
      {currentStep === "welcome" && (
        <WelcomeStep
          shell={shell}
          onStart={() => pickMode("express")}
          onCustomise={() => pickMode("custom")}
          onSkipExisting={(sessionCount ?? 0) > 0 ? skipExisting : undefined}
          onPickMode={
            shell === "mobile-standalone" || shell === "mobile-paired"
              ? handlePickRuntimeMode
              : undefined
          }
          mode={settings?.mobileRuntimeMode}
        />
      )}

      {currentStep === "express" && (
        <ExpressStep
          items={plan}
          phase={expressPhase}
          status={expressStatus}
          modelAccess={modelAccess.value}
          paired={companionLoading ? null : companionPaired}
          dropped={dropped}
          onToggle={toggleExpressItem}
          onApply={runPlan}
          signIn={
            plan.some((item) => item.kind === "pair") ? (
              <Button
                size="sm"
                className="self-start"
                onClick={() => router.push(PAIR_ROUTE)}
                data-testid="onboarding-open-pairing"
              >
                {t("scan.pairedCta")}
              </Button>
            ) : (
              <ExpressSignIn />
            )
          }
        >
          {firstRun}
        </ExpressStep>
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

      {currentStep === "first-run" && firstRun}
    </StepShell>
  )
}

/** Maps the express plan's lifecycle onto the tones the scene draws. */
function sceneItemState(
  item: ExpressPlanItem,
  phase: ExpressPhase,
  status: Record<string, ExpressItemStatus>
): ExpressSceneItemState {
  const state = status[item.id]
  if (state === "done") return "done"
  if (state === "running") return "running"
  // A failed line is drawn as skipped rather than done: the picture must not
  // claim something landed that did not.
  if (state === "failed") return "skipped"
  return phase === "applying" ? "queued" : item.selected ? "queued" : "skipped"
}

function renderScene(input: {
  step: OnboardingStepId
  scan: ReturnType<typeof useMachineScan>
  historyTotal: number
  plan: readonly ExpressPlanItem[]
  expressPhase: ExpressPhase
  expressStatus: Record<string, ExpressItemStatus>
  providerView: ProviderView
}) {
  switch (input.step) {
    case "welcome":
      return <WelcomeScene />
    case "scan":
      return (
        <ScanScene
          phase={input.scan.phase}
          runtimes={input.scan.result.runtimes}
          historyCount={input.historyTotal}
        />
      )
    case "provider":
      return <ProviderScene connected={input.providerView === "connected"} />
    case "express":
      return (
        <ExpressScene
          items={input.plan.map((item) => ({
            id: item.id,
            state: sceneItemState(item, input.expressPhase, input.expressStatus),
          }))}
        />
      )
    case "first-run":
      return <FirstRunScene />
  }
}
