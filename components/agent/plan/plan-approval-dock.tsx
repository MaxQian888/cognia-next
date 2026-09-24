"use client"

/**
 * Pinned plan-approval gate for direct chat — the desktop analogue of the CLI's
 * `PlanApprovalOverlay`. When a plan-mode turn ends, `captureExitPlanMode`
 * writes a draft `AgentPlan` (status `awaiting_approval`) to Dexie; this dock
 * reads it live via {@link useSessionPlan} and renders {@link PlanApprovalCard}
 * above the composer with Claude-Code-style options:
 *
 *   - Yes, auto-accept edits   → approve, resume in `acceptEdits`
 *   - Yes, review each edit    → approve, resume in `default` (each edit prompts)
 *   - Approve & fully automated → approve, resume in `auto` (overflow menu)
 *   - No, keep planning        → plan back to `draft`, stay in plan mode;
 *                                feedback (if any) is sent as a normal user turn
 *   - Reject (+ optional reason) → terminal `rejected` (confirmed in the card)
 *   - Edit                     → the "Write a plan" editor, pre-filled, amends
 *                                the plan in place after re-validating it
 *   - Refine / inline edit     → re-plan in place / updatePlanDraft
 *
 * In-session first step: when the chat refuses the step's turn, the step is
 * failed (`dispatch_failed`) and the plan halts on it, so the tracker card
 * shows the error with retry / skip / mark done / cancel — rather than an
 * `executing` plan with a step `in_progress` that no turn is running.
 *
 * Direct chat drives approval directly on the Dexie row (unlike the *team* flow,
 * there is no blocked runtime waiter — the plan-mode turn already ended), then
 * asks the host to resume the chat turn via `onResume`.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlanApprovalCard, type PlanEditPatch, type PlanResumeMode } from "./plan-approval-card"
import { PlanComposerDialog } from "./plan-composer-dialog"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import {
  getPlanRuntime,
  readPlanChatResumeFailure,
  type PlanChatResumeFailure,
} from "@/lib/agent/plan/runtime"
import { Button } from "@/components/ui/button"
import { applyPlanEditPatch } from "@/lib/agent/plan/draft-edit"
import { resolvePlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { resolvePlanStrategy } from "@/lib/agent/plan/strategy"
import { chatPlanStepHooks } from "@/lib/agent/plan/turn-driver"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentPlan, PlanRefinementType } from "@/types/agent/plan"

/** The synthetic turn injected after a plan is approved. */
export const PLAN_APPROVED_PROMPT =
  "The plan above is approved. Implement it now, step by step, following the plan."

/**
 * The synthetic turn injected after approval. When the user ADJUSTED the plan
 * during review (inline / interactive edits — `metadata.userEdited`, stamped by
 * {@link PlanApprovalDock}'s edit handler), the model's own transcript still
 * contains its ORIGINAL proposal, so the base "the plan above" prompt would
 * implement the wrong version. Embed the adjusted plan instead — the same
 * embed-the-plan pattern as the CLI's `PLAN_EXECUTE_PROMPT`.
 */
export function buildPlanApprovedPrompt(plan: AgentPlan): string {
  if (!plan.metadata?.userEdited) return PLAN_APPROVED_PROMPT
  const meta = plan.metadata as { planText?: unknown }
  const planText = typeof meta.planText === "string" ? meta.planText.trim() : ""
  const body =
    planText ||
    [...plan.steps]
      .sort((a, b) => a.order - b.order)
      .map((s, i) => `${i + 1}. ${s.title}`)
      .join("\n")
  return [
    "The plan is approved, but the user ADJUSTED it during review — the approved version below supersedes the plan you proposed earlier. Where they differ, follow the version below.",
    "",
    `# ${plan.title}`,
    "",
    body,
    "",
    "Implement it now, step by step, following the approved plan above.",
  ].join("\n")
}

export interface PlanApprovalDockProps {
  sessionId: string
  /** The bound session (for refine model resolution); may be null in split panes. */
  session?: ChatSession | null
  /**
   * Resume the chat turn after approval. The host switches the session's
   * permission mode to `mode` and sends `prompt` as a fresh turn without an
   * optimistic user bubble.
   */
  onResume: (prompt: string, mode: PlanResumeMode) => void | Promise<void>
  /**
   * "Keep planning" feedback channel: the host sends `feedback` as a NORMAL
   * user turn (user bubble, session stays in plan mode). Optional — without
   * it, keep-planning still defers the plan; the feedback is only logged.
   */
  onSendPlanFeedback?: (feedback: string) => void | Promise<void>
}

export function PlanApprovalDock({
  sessionId,
  session,
  onResume,
  onSendPlanFeedback,
}: PlanApprovalDockProps) {
  const t = useTranslations("plan")
  const plan = useSessionPlan(sessionId)
  const appSettings = useSettingsStore((s) => s.settings)
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null)
  const busy = !!plan && busyPlanId === plan.id
  // One number per editor session: the dialog is keyed on it, so each Edit
  // opens the "Write a plan" form fresh from the plan as it is now.
  const [editorSession, setEditorSession] = useState<number | null>(null)
  const [localFailure, setLocalFailure] = useState<
    (PlanChatResumeFailure & { planId: string }) | null
  >(null)
  const resumeFailure = plan
    ? localFailure?.planId === plan.id
      ? localFailure
      : readPlanChatResumeFailure(plan)
    : null

  const rememberResumeFailure = async (planId: string, failure: PlanChatResumeFailure) => {
    setLocalFailure({ ...failure, planId })
    await getPlanRuntime()
      .setChatResumeFailure(planId, failure)
      .catch(() => undefined)
  }
  // One auto-resume attempt per mounted dock (belt-and-braces on top of the
  // metadata stamp, which is the cross-remount guard).
  const autoResumedRef = useRef<string | null>(null)

  // requireApproval=false: an exit-plan capture lands `approved` (never
  // `awaiting_approval`), so no card renders — auto-resume the implementing
  // turn instead of dead-ending. The metadata stamp makes this idempotent
  // across remounts. Registered BEFORE the early-return gate (hook order);
  // all gating (incl. the ref read) happens inside the effect.
  useEffect(() => {
    if (!plan || plan.status !== "approved" || plan.source !== "exit_plan_mode") return
    if (autoResumedRef.current === plan.id) return
    if (
      plan.config.requireApproval !== false ||
      plan.metadata?.autoResumedAt ||
      readPlanChatResumeFailure(plan)
    )
      return
    autoResumedRef.current = plan.id
    const planId = plan.id
    void (async () => {
      try {
        await getPlanRuntime().updatePlanDraft(planId, {
          metadata: { ...plan.metadata, autoResumedAt: Date.now() },
        })
        await onResume(PLAN_APPROVED_PROMPT, "acceptEdits")
      } catch {
        setLocalFailure({ planId, prompt: PLAN_APPROVED_PROMPT, mode: "acceptEdits" })
        await getPlanRuntime()
          .setChatResumeFailure(planId, {
            prompt: PLAN_APPROVED_PROMPT,
            mode: "acceptEdits",
          })
          .catch(() => undefined)
      }
    })()
  }, [plan, onResume])

  // Only gate on a plan that is actually awaiting a decision — after approval the
  // row becomes `approved` (still "open"), so gating here also prevents the dock
  // from lingering or firing a second resume turn. Keep-planning flips the row
  // back to `draft`, which this gate also hides.
  if (!plan || (plan.status !== "awaiting_approval" && !resumeFailure)) return null

  const handleRetryResume = async () => {
    if (busy || !resumeFailure) return
    setBusyPlanId(plan.id)
    try {
      // Clear before sending; a failed metadata write cannot leave a stale
      // retry record behind after the model already accepted the continuation.
      await getPlanRuntime().setChatResumeFailure(plan.id, null)
      await onResume(resumeFailure.prompt, resumeFailure.mode)
      setLocalFailure(null)
    } catch {
      await rememberResumeFailure(plan.id, resumeFailure)
      setBusyPlanId(null)
    }
  }

  const handleApprove = async (mode: PlanResumeMode) => {
    if (busy) return
    setBusyPlanId(plan.id)
    let continuation: PlanChatResumeFailure | null = null
    let inSessionStep: { stepId: string; generationId: string } | null = null
    try {
      // Which executor owns this plan is decided BEFORE approving, from the
      // pure resolver — calling `startPlan` blind would hand an `orchestrated`
      // plan to the workflow runtime while we also send an implementing turn,
      // i.e. execute it twice.
      const strategy = resolvePlanStrategy(plan)
      await getPlanRuntime().approvePlan(plan.id)
      if (strategy === "in_session") {
        // Conversational path (ADR-0045 §2): the runtime marks the plan
        // executing + its first step in progress and hands back that step's
        // turn text; `handlePlanTurnComplete` in the chat hook advances from
        // there, one visible turn per step.
        const started = await getPlanRuntime().startPlan(
          plan.id,
          chatPlanStepHooks(plan.id, sessionId)
        )
        if (started?.strategy === "in_session" && started.userMessage) {
          if (started.stepId && started.generationId) {
            inSessionStep = { stepId: started.stepId, generationId: started.generationId }
          }
          continuation = { prompt: started.userMessage, mode }
          await onResume(continuation.prompt, mode)
          return
        }
      }
      // Orchestrated / exit-plan-mode parity: one implementing turn that asks
      // the model to work the approved plan through itself.
      continuation = { prompt: buildPlanApprovedPrompt(plan), mode }
      await onResume(continuation.prompt, mode)
      // Leave `busy` true — approvePlan flips the status so this dock unmounts.
    } catch (error) {
      if (inSessionStep) {
        // The step is already `in_progress`: record why its turn never went
        // out, which halts the plan on it with the tracker's failure card.
        await getPlanRuntime()
          .failInSessionStep(plan.id, {
            stepId: inSessionStep.stepId,
            cause: "dispatch_failed",
            detail: error instanceof Error ? error.message : String(error),
            capturedGenerationId: inSessionStep.generationId,
          })
          .catch(() => undefined)
      } else if (continuation) {
        await rememberResumeFailure(plan.id, continuation)
      }
      setBusyPlanId(null)
    }
  }

  const handleKeepPlanning = async (feedback?: string) => {
    if (busy) return
    setBusyPlanId(plan.id)
    try {
      await getPlanRuntime().keepPlanning(plan.id, feedback)
      if (feedback && onSendPlanFeedback) await onSendPlanFeedback(feedback)
      // keepPlanning flips the row to `draft`, unmounting the dock.
    } catch {
      setBusyPlanId(null)
    }
  }

  const handleReject = async (reason?: string) => {
    if (busy) return
    setBusyPlanId(plan.id)
    try {
      // Terminal `rejected`: the row leaves the open-plan slot and this dock
      // unmounts on the live query.
      await getPlanRuntime().rejectPlan(plan.id, reason)
    } catch {
      toast.error(t("approval.rejectFailed"))
    } finally {
      setBusyPlanId(null)
    }
  }

  const handleEdit = async (patch: PlanEditPatch) => {
    if (busy) return
    setBusyPlanId(plan.id)
    try {
      // Shared with the dock's plan panel: a markdown edit carries the raw
      // body; a step edit carries one title per line. Either way the same
      // linear agent_turn chain is re-derived so execution stays in sync with
      // what the user sees, and `userEdited` marks the draft as adjusted.
      await applyPlanEditPatch(plan, patch)
    } finally {
      setBusyPlanId(null)
    }
  }

  const handleRefine = async (type: PlanRefinementType, feedback?: string) => {
    if (busy) return
    const client = buildUtilityLlmClient({
      session: session ?? null,
      appSettings,
      featureId: "plan-refine",
    })
    if (!client) {
      toast.error(t("approval.refineUnavailable"))
      return
    }
    setBusyPlanId(plan.id)
    try {
      await getPlanRuntime().refinePlan(
        { planId: plan.id, refinementType: type, trigger: "manual", customInstructions: feedback },
        client
      )
    } finally {
      setBusyPlanId(null)
    }
  }

  if (resumeFailure) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 pb-2">
        <p className="text-sm text-muted-foreground">{t("approval.resumeFailed")}</p>
        <Button size="sm" disabled={busy} onClick={() => void handleRetryResume()}>
          {t("tracker.resume")}
        </Button>
      </div>
    )
  }

  return (
    <div className="pb-2" data-testid="plan-approval-dock">
      <PlanApprovalCard
        plan={plan}
        disabled={busy}
        onApprove={handleApprove}
        onKeepPlanning={handleKeepPlanning}
        onReject={handleReject}
        onOpenEditor={() => setEditorSession(Date.now())}
        onRefine={handleRefine}
        onEdit={handleEdit}
        interactiveView={appSettings?.planSettings?.interactiveHtmlView === true}
        interactiveStyle={resolvePlanHtmlStyle(appSettings?.planSettings?.interactiveHtmlStyle)}
      />
      {editorSession !== null && (
        <PlanComposerDialog
          key={editorSession}
          sessionId={sessionId}
          {...(plan.characterId ? { characterId: plan.characterId } : {})}
          open
          onOpenChange={(open) => {
            if (!open) setEditorSession(null)
          }}
          editPlan={plan}
        />
      )}
    </div>
  )
}
