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
import { PlanApprovalCard, type PlanEditPatch, type PlanResumeMode } from "./plan-approval-card"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { parsePlanText } from "@/lib/agent/plan/exit-plan-capture"
import { resolvePlanHtmlStyle } from "@/lib/agent/plan/plan-html"
import { materializeSteps } from "@/lib/agent/plan/steps"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@/lib/claude/types"
import type { AgentPlan, CreatePlanStepInput, PlanRefinementType } from "@/types/agent/plan"

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

/** Build the linear `agent_turn` step chain `exit-plan-capture` / edits share. */
function linearSteps(titles: string[]) {
  const inputs: CreatePlanStepInput[] = titles.map((title, i) => ({
    title: title.slice(0, 200),
    kind: "agent_turn",
    ...(i > 0 ? { dependsOn: [i - 1] } : {}),
  }))
  return materializeSteps(inputs)
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
      await onResume(buildPlanApprovedPrompt(plan), mode)
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

  const handleEdit = async (patch: PlanEditPatch) => {
    if (busy) return
    const title = patch.title.slice(0, 120)
    // A markdown edit carries the raw body; a step edit carries one title per
    // line. Either way we re-derive the same linear agent_turn chain so
    // execution stays in sync with what the user sees.
    const titles = "planText" in patch ? parsePlanText(patch.planText) : patch.stepTitles
    if (titles.length === 0) return
    setBusy(true)
    try {
      await getPlanRuntime().updatePlanDraft(plan.id, {
        title,
        steps: linearSteps(titles),
        // Keep the full body in metadata so the card can render it back, and
        // stamp `userEdited` so approval embeds the adjusted plan (the model's
        // transcript still holds its original proposal).
        metadata: {
          ...plan.metadata,
          userEdited: true,
          ...("planText" in patch ? { planText: patch.planText } : {}),
        },
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
        interactiveView={appSettings?.planSettings?.interactiveHtmlView === true}
        interactiveStyle={resolvePlanHtmlStyle(appSettings?.planSettings?.interactiveHtmlStyle)}
      />
    </div>
  )
}
