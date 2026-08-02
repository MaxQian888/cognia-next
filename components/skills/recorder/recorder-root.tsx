"use client"

/**
 * The recorder's single mount point.
 *
 * Mounted at the app root rather than inside the Skills panel, because three of
 * the four entry points — the command palette, the `skills.record` shortcut, and
 * the plugin's `/record-skill` — fire on *any* route. A panel-scoped mount would
 * leave them dead everywhere except `/skills`.
 *
 * It renders `null` until the store says otherwise, so the cost on every other
 * route is one selector per render.
 *
 * It also owns the two things that must happen once per app lifetime: startup
 * recovery (reconciling with a native session that outlived a reload) and the
 * `skills.record` shortcut registration.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { isTauri } from "@/lib/tauri"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildManualSkillDraft } from "@/lib/skills/recording/manual-template"
import {
  buildEnvelope,
  confirmTrialAndEnable,
  generate,
  pauseRecording,
  recoverOnStartup,
  resumeRecording,
  runPreflight,
  saveSkill,
  startControlledTrial,
  startRecording,
  stopRecording,
  undoLastStep,
  adoptManualDraft,
} from "@/lib/skills/recording/controller"
import { collectRegisteredToolNames } from "@/lib/skills/recording/tool-catalog"
import { hasLiveCapture, stageForPhase, STAGES } from "@/lib/skills/recording/state-machine"
import {
  scopeForSelection,
  scopeSummary,
  type CaptureScope,
  type CaptureTarget,
} from "@/lib/skills/recording/types"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useSkillsStore } from "@/stores/skills"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import {
  useRecorderAvailable,
  useRecorderInterrupt,
  useRecorderPhase,
  useRecorderSheetOpen,
  useRecorderStage,
  useRecorderUnconfirmedVariables,
} from "@/hooks/skills/use-skill-recorder"

import { RecorderInterruptBanner } from "./recorder-interrupt-banner"
import { RecorderStageHeader } from "./recorder-stage-header"
import { StageGenerate } from "./stage-generate"
import { StageRecording } from "./stage-recording"
import { StageReview } from "./stage-review"
import { StageSave } from "./stage-save"
import { StageSetup } from "./stage-setup"

export function SkillRecorderRoot() {
  const t = useTranslations("skills.recorder")
  const locale = useLocale()
  const available = useRecorderAvailable()
  const open = useRecorderSheetOpen()
  const phase = useRecorderPhase()
  const stage = useRecorderStage()
  const interrupt = useRecorderInterrupt()
  const dispatch = useRecorderStore((state) => state.dispatch)
  const setUi = useRecorderStore((state) => state.setUi)
  const steps = useRecorderStore((state) => state.steps)
  const variables = useRecorderStore((state) => state.inputVariables)
  const options = useRecorderStore((state) => state.options)
  const savedSkillId = useRecorderStore((state) => state.savedSkillId)
  const settings = useSettingsStore((state) => state.settings)

  const unconfirmedVariables = useRecorderUnconfirmedVariables()

  const [scopeKind, setScopeKind] = useState<CaptureScope["kind"]>("desktop")
  const [scopeTarget, setScopeTarget] = useState<CaptureTarget | null>(null)
  const [toolCatalog, setToolCatalog] = useState<string[]>([])
  const [containerWidth, setContainerWidth] = useState(0)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  /** Focus goes back where it came from when the Sheet closes. */
  const openerRef = useRef<Element | null>(null)

  // Reconcile with the native side once. A recording can outlive a renderer
  // reload — the hook and the journal are both native — so the first thing the
  // app does is ask whether one is still running.
  useEffect(() => {
    if (!isTauri()) return
    void recoverOnStartup()
  }, [])

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    void collectRegisteredToolNames().then(setToolCatalog)
  }, [open])

  /**
   * Measure the scroll container, via a ref callback rather than an effect.
   *
   * An effect keyed on `open` runs on the pass that flips it, but Radix mounts
   * the Sheet's content a tick later — so the ref is still null, the observer is
   * never installed, and `containerWidth` stays 0 until the Sheet is closed and
   * reopened. A ref callback fires exactly when the node arrives.
   */
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width)
    })
    observer.observe(element)
    observerRef.current = observer
  }, [])

  // Registered here rather than in `use-skill-shortcuts`: that hook is called
  // from the Skills panel and is therefore mount-scoped to /skills, while this
  // chord has to work on any route. `enabled` is what stops a disabled recorder
  // from swallowing the key.
  useAppShortcut(
    "skills.record",
    (event) => {
      event.preventDefault()
      useRecorderStore.getState().dispatch({ type: "OPEN", source: "shortcut" })
    },
    { enabled: available }
  )

  const utilityClient = useMemo(
    () =>
      buildUtilityLlmClient({ session: null, appSettings: settings, featureId: "skills.recorder" }),
    [settings]
  )

  const reached = useMemo(() => STAGES.slice(0, STAGES.indexOf(stageForPhase(phase)) + 1), [phase])

  /** `null` until the chosen kind actually has everything the scope needs. */
  const resolvedScope = useMemo(
    () => scopeForSelection(scopeKind, scopeTarget),
    [scopeKind, scopeTarget]
  )

  const handleClose = useCallback(
    (next: boolean) => {
      if (next) return
      // Dismissing mid-capture hides the panel; it never stops the recording.
      // The floating controller is the surface while it runs.
      if (hasLiveCapture(phase)) {
        setUi({ sheetOpen: false })
      } else {
        dispatch({ type: "CLOSE" })
      }
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus()
    },
    [dispatch, phase, setUi]
  )

  const manualTemplate = useCallback(() => {
    const draft = buildManualSkillDraft({
      views: steps,
      variables,
      category: "custom",
      tags: [],
      strings: {
        whenToUseHeading: t("template.whenToUse"),
        inputsHeading: t("template.inputs"),
        stepsHeading: t("template.steps"),
        verifyHeading: t("template.verify"),
        whenToUseBody: t("template.whenToUseBody", {
          scope: useRecorderStore.getState().scope
            ? scopeSummary(useRecorderStore.getState().scope!)
            : "",
        }),
        noInputs: t("template.noInputs"),
        noVerify: t("template.noVerify"),
        secretSuffix: t("template.secretSuffix"),
        defaultName: t("template.defaultName"),
        defaultDescription: t("template.defaultDescription"),
        unnamedStep: t("template.unnamedStep"),
        clickStep: (target) => t("template.click", { target }),
        typeStep: (target, value) => t("template.type", { target, value }),
        secretStep: (target) => t("template.secret", { target }),
        keysStep: (chord) => t("template.keys", { chord }),
        scrollStep: (direction) =>
          direction === "down" ? t("template.scrollDown") : t("template.scrollUp"),
      },
    })
    adoptManualDraft(draft, options.localeOverride ?? locale)
  }, [locale, options.localeOverride, steps, t, variables])

  const runGenerate = useCallback(
    (asCandidate: boolean) => {
      void generate({
        locale,
        client: utilityClient as never,
        provider: settings?.defaultProvider ?? "anthropic",
        model: settings?.defaultModel ?? "",
        fallbackName: t("template.defaultName"),
        asCandidate,
      })
    },
    [locale, settings?.defaultModel, settings?.defaultProvider, t, utilityClient]
  )

  if (!available && !open) return null

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-none"
        style={{ width: "clamp(420px, 64vw, 960px)" }}
        aria-label={t("openAria")}
      >
        <SheetHeader className="border-b px-4 pb-2 pt-4">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
          <RecorderStageHeader
            current={stage}
            reached={reached}
            onSelect={(next) => setUi({ stageOverride: next })}
          />
        </SheetHeader>

        <div ref={measureRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {interrupt ? (
            <div className="mb-4">
              <RecorderInterruptBanner
                interrupt={interrupt}
                onRetry={() => dispatch({ type: "RETRY" })}
                onDiscard={() => dispatch({ type: "CLOSE" })}
              />
            </div>
          ) : null}

          {stage === "setup" ? (
            <StageSetup
              scopeKind={scopeKind}
              onScopeKindChange={(kind) => {
                setScopeKind(kind)
                // A kind change invalidates the target: a window handle is not
                // an application, and carrying one across would start a
                // recording aimed at something the user never picked.
                setScopeTarget(null)
              }}
              target={scopeTarget}
              onTargetChange={setScopeTarget}
              // Re-checks permissions only. It must never start a recording —
              // the previous "retry" started one at desktop scope regardless of
              // what the user had selected, widening capture on a button whose
              // label promised a permission re-check.
              onRetryPreflight={() => void runPreflight()}
            />
          ) : null}

          {stage === "recording" ? (
            <StageRecording
              onPause={() => void pauseRecording()}
              onResume={() => void resumeRecording()}
              onUndo={() => void undoLastStep()}
              onFinish={() => void stopRecording()}
              onHide={() => setUi({ sheetOpen: false })}
            />
          ) : null}

          {stage === "review" ? <StageReview containerWidth={containerWidth} /> : null}

          {stage === "generate" ? (
            <StageGenerate
              buildEnvelope={() => buildEnvelope(locale)}
              onGenerate={() => runGenerate(false)}
              onRegenerate={() => runGenerate(true)}
              onManualTemplate={manualTemplate}
              hasModel={Boolean(utilityClient)}
              unconfirmedVariables={unconfirmedVariables}
              toolCatalog={toolCatalog}
            />
          ) : null}

          {stage === "save" ? (
            <StageSave
              onSave={() =>
                void saveSkill((index) => t("stepKind.click") + ` ${index + 1}`).then((id) => {
                  if (id) toast.success(t("save.saved", { name: "" }))
                })
              }
              onStartTrial={() => {
                if (savedSkillId) void startControlledTrial(savedSkillId)
              }}
              onConfirmTrial={() => {
                if (savedSkillId) void confirmTrialAndEnable(savedSkillId)
              }}
              onOpenEditor={() => {
                const draft = useRecorderStore.getState().draft
                if (savedSkillId && draft) {
                  useSkillsStore.getState().openSkillInEditor(savedSkillId, draft.content)
                  dispatch({ type: "CLOSE" })
                }
              }}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => handleClose(false)}>
            {t("close")}
          </Button>
          {stage === "setup" ? (
            <div className="flex items-center gap-2">
              {scopeKind !== "desktop" && !resolvedScope ? (
                <span className="text-xs text-muted-foreground">{t("setup.targetRequired")}</span>
              ) : null}
              <Button
                size="sm"
                // No fallback: a scoped choice with no target is not a scope,
                // and starting at desktop scope instead would record more than
                // the user asked for.
                disabled={!resolvedScope}
                onClick={() => {
                  if (resolvedScope) void startRecording(resolvedScope)
                }}
              >
                {t("setup.start")}
              </Button>
            </div>
          ) : null}
          {stage === "review" ? (
            <div className="flex items-center gap-2">
              {unconfirmedVariables > 0 ? (
                <span className="text-xs text-amber-600 dark:text-amber-500">
                  {t("review.blockedByVariables", { count: unconfirmedVariables })}
                </span>
              ) : null}
              <Button
                size="sm"
                // The same gate the reducer enforces. Surfacing it here means
                // the user sees why rather than pressing a button that silently
                // does nothing.
                disabled={unconfirmedVariables > 0}
                onClick={() => setUi({ stageOverride: "generate" })}
              >
                {t("review.continue")}
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
