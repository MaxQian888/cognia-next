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
 *   - Discard plan             → cancel (destructive, overflow menu)
 *   - Refine / inline edit     → re-plan in place / updatePlanDraft
 *
 * Direct chat drives approval directly on the Dexie row (unlike the *team* flow,
 * there is no blocked runtime waiter — the plan-mode turn already ended), then
 * asks the host to resume the chat turn via `onResume`.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlanApprovalCard, type PlanResumeMode } from "./plan-approval-card"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { materializeSteps } from "@/lib/agent/plan/steps"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@/lib/claude/types"
import type { CreatePlanStepInput, PlanRefinementType } from "@/types/agent/plan"

/** The synthetic turn injected after a plan is approved. */
export const PLAN_APPROVED_PROMPT =
  "The plan above is approved. Implement it now, step by step, following the plan."

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
  const [busy, setBusy] = useState(false)
  // One auto-resume attempt per mounted dock (belt-and-braces on top of the
  // metadata stamp, which is the cross-remount guard).
  const autoResumedRef = useRef(false)

  // requireApproval=false: an exit-plan capture lands `approved` (never
  // `awaiting_approval`), so no card renders — auto-resume the implementing
  // turn instead of dead-ending. The metadata stamp makes this idempotent
  // across remounts. Registered BEFORE the early-return gate (hook order);
  // all gating (incl. the ref read) happens inside the effect.
  useEffect(() => {
    if (autoResumedRef.current) return
    if (!plan || plan.status !== "approved" || plan.source !== "exit_plan_mode") return
    if (plan.config.requireApproval !== false || plan.metadata?.autoResumedAt) return
    autoResumedRef.current = true
    const planId = plan.id
    void (async () => {
      try {
        await getPlanRuntime().updatePlanDraft(planId, {
          metadata: { autoResumedAt: Date.now() },
        })
        await onResume(PLAN_APPROVED_PROMPT, "acceptEdits")
      } catch {
        // Best-effort: the user can still drive the plan manually.
      }
    })()
  }, [plan, onResume])

  // Only gate on a plan that is actually awaiting a decision — after approval the
  // row becomes `approved` (still "open"), so gating here also prevents the dock
  // from lingering or firing a second resume turn. Keep-planning flips the row
  // back to `draft`, which this gate also hides.
  if (!plan || plan.status !== "awaiting_approval") return null

  const handleApprove = async (mode: PlanResumeMode) => {
    if (busy) return
    setBusy(true)
    try {
      await getPlanRuntime().approvePlan(plan.id)
      await onResume(PLAN_APPROVED_PROMPT, mode)
      // Leave `busy` true — approvePlan flips the status so this dock unmounts.
    } catch {
      setBusy(false)
    }
  }

  const handleKeepPlanning = async (feedback?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await getPlanRuntime().keepPlanning(plan.id, feedback)
      if (feedback && onSendPlanFeedback) await onSendPlanFeedback(feedback)
      // keepPlanning flips the row to `draft`, unmounting the dock.
    } catch {
      setBusy(false)
    }
  }

  const handleDiscard = async (feedback?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await getPlanRuntime().rejectPlan(plan.id, feedback)
    } finally {
      setBusy(false)
    }
  }

  const handleEdit = async (patch: { title: string; stepTitles: string[] }) => {
    if (busy || patch.stepTitles.length === 0) return
    setBusy(true)
    try {
      // Same linear agent_turn shape `exit-plan-capture` / `refinePlan` produce.
      const inputs: CreatePlanStepInput[] = patch.stepTitles.map((title, i) => ({
        title: title.slice(0, 200),
        kind: "agent_turn",
        ...(i > 0 ? { dependsOn: [i - 1] } : {}),
      }))
      await getPlanRuntime().updatePlanDraft(plan.id, {
        title: patch.title.slice(0, 120),
        steps: materializeSteps(inputs),
      })
    } finally {
      setBusy(false)
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
    setBusy(true)
    try {
      await getPlanRuntime().refinePlan(
        { planId: plan.id, refinementType: type, trigger: "manual", customInstructions: feedback },
        client
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3 pb-2" data-testid="plan-approval-dock">
      <PlanApprovalCard
        plan={plan}
        disabled={busy}
        onApprove={handleApprove}
        onKeepPlanning={handleKeepPlanning}
        onDiscard={handleDiscard}
        onRefine={handleRefine}
        onEdit={handleEdit}
      />
    </div>
  )
}
