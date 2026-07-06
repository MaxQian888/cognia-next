/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanApprovalDock, PLAN_APPROVED_PROMPT } from "./plan-approval-dock"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const approvePlan = jest.fn().mockResolvedValue(null)
const rejectPlan = jest.fn().mockResolvedValue(null)
const refinePlan = jest.fn().mockResolvedValue(null)
const keepPlanning = jest.fn().mockResolvedValue(null)
const updatePlanDraft = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ approvePlan, rejectPlan, refinePlan, keepPlanning, updatePlanDraft }),
}))

const mockPlan = jest.fn()
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockPlan(),
}))

const buildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => buildClient(...a),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: { foo: 1 } }),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

function step(id: string, title: string, order: number): PlanStep {
  return { id, title, kind: "agent_turn", status: "pending", order, dependencies: [] }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? []
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps,
    status: over.status ?? "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  buildClient.mockReturnValue({})
})

describe("PlanApprovalDock", () => {
  it("renders nothing without an awaiting-approval plan (approved / draft hidden)", () => {
    mockPlan.mockReturnValue(undefined)
    const { rerender, container } = render(
      <PlanApprovalDock sessionId="ses" onResume={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()

    mockPlan.mockReturnValue(plan({ status: "approved" }))
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.queryByTestId("plan-approval-dock")).not.toBeInTheDocument()

    // Keep-planning flips the row to draft — also hidden.
    mockPlan.mockReturnValue(plan({ status: "draft" }))
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.queryByTestId("plan-approval-dock")).not.toBeInTheDocument()
  })

  it("auto-accept approve → approvePlan then resume(acceptEdits)", async () => {
    mockPlan.mockReturnValue(plan())
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
    await waitFor(() => expect(approvePlan).toHaveBeenCalledWith("p1"))
    expect(onResume).toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, "acceptEdits")
  })

  it("review-each approve → resume(default)", async () => {
    mockPlan.mockReturnValue(plan())
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve-review"))
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, "default"))
  })

  it("fully-automated approve (overflow) → resume(auto)", async () => {
    mockPlan.mockReturnValue(plan())
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-approve-full-auto"))
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, "auto"))
  })

  it("keep planning without feedback → keepPlanning only, no send", async () => {
    mockPlan.mockReturnValue(plan())
    const onSendPlanFeedback = jest.fn()
    render(
      <PlanApprovalDock
        sessionId="ses"
        onResume={jest.fn()}
        onSendPlanFeedback={onSendPlanFeedback}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-keep-planning"))
    await waitFor(() => expect(keepPlanning).toHaveBeenCalledWith("p1", undefined))
    expect(onSendPlanFeedback).not.toHaveBeenCalled()
    expect(rejectPlan).not.toHaveBeenCalled()
  })

  it("keep planning with feedback → keepPlanning + feedback sent as a user turn", async () => {
    mockPlan.mockReturnValue(plan())
    const onSendPlanFeedback = jest.fn()
    render(
      <PlanApprovalDock
        sessionId="ses"
        onResume={jest.fn()}
        onSendPlanFeedback={onSendPlanFeedback}
      />
    )
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "cover mobile too")
    await userEvent.click(screen.getByTestId("plan-approval-keep-planning"))
    await waitFor(() => expect(keepPlanning).toHaveBeenCalledWith("p1", "cover mobile too"))
    expect(onSendPlanFeedback).toHaveBeenCalledWith("cover mobile too")
  })

  it("discards (overflow) with feedback via rejectPlan", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "no")
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-discard"))
    await waitFor(() => expect(rejectPlan).toHaveBeenCalledWith("p1", "no"))
  })

  it("saves an inline edit via updatePlanDraft with materialized linear steps", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.clear(screen.getByTestId("plan-edit-steps"))
    await userEvent.type(screen.getByTestId("plan-edit-steps"), "alpha{enter}beta")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalled())
    const [planId, patch] = updatePlanDraft.mock.calls[0] as [
      string,
      { title: string; steps: PlanStep[] },
    ]
    expect(planId).toBe("p1")
    expect(patch.title).toBe("Ship it")
    expect(patch.steps.map((s) => s.title)).toEqual(["alpha", "beta"])
    // Linear dependency chain, same shape as exit-plan-capture.
    expect(patch.steps[1].dependencies).toEqual([patch.steps[0].id])
  })

  it("refines via the utility client (overflow menu)", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-refine-optimize"))
    await waitFor(() =>
      expect(refinePlan).toHaveBeenCalledWith(
        expect.objectContaining({ planId: "p1", refinementType: "optimize", trigger: "manual" }),
        expect.anything()
      )
    )
  })

  it("toasts and skips refine when no model is configured", async () => {
    mockPlan.mockReturnValue(plan())
    buildClient.mockReturnValue(null)
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-refine-optimize"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(refinePlan).not.toHaveBeenCalled()
  })

  it("re-enables actions when approvePlan throws (busy resets)", async () => {
    mockPlan.mockReturnValue(plan())
    approvePlan.mockRejectedValueOnce(new Error("boom"))
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    const btn = screen.getByTestId("plan-approval-approve-auto")
    await userEvent.click(btn)
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(onResume).not.toHaveBeenCalled()
  })

  it("keep planning with feedback works without an onSendPlanFeedback channel", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "note")
    await userEvent.click(screen.getByTestId("plan-approval-keep-planning"))
    await waitFor(() => expect(keepPlanning).toHaveBeenCalledWith("p1", "note"))
  })

  it("keepPlanning failure resets busy instead of wedging the card", async () => {
    mockPlan.mockReturnValue(plan())
    keepPlanning.mockRejectedValueOnce(new Error("boom"))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    const btn = screen.getByTestId("plan-approval-keep-planning")
    await userEvent.click(btn)
    await waitFor(() => expect(btn).not.toBeDisabled())
  })

  it("auto-resume swallows a failing stamp write (best-effort)", async () => {
    mockPlan.mockReturnValue(
      plan({
        status: "approved",
        config: { ...DEFAULT_PLAN_CONFIG, requireApproval: false },
      })
    )
    updatePlanDraft.mockRejectedValueOnce(new Error("dexie down"))
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalled())
    // Stamp failed → no resume, no crash; the user can drive the plan manually.
    expect(onResume).not.toHaveBeenCalled()
  })

  it("disables actions after the first approve click (no double resume)", async () => {
    mockPlan.mockReturnValue(plan())
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    const btn = screen.getByTestId("plan-approval-approve-auto")
    await userEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    await userEvent.click(btn)
    expect(approvePlan).toHaveBeenCalledTimes(1)
  })

  it("auto-resumes once when requireApproval=false lands an approved exit-plan capture", async () => {
    mockPlan.mockReturnValue(
      plan({
        status: "approved",
        config: { ...DEFAULT_PLAN_CONFIG, requireApproval: false },
      })
    )
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    // Stamps the idempotency marker, then resumes in acceptEdits.
    await waitFor(() =>
      expect(updatePlanDraft).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          metadata: expect.objectContaining({ autoResumedAt: expect.any(Number) }),
        })
      )
    )
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, "acceptEdits"))
    expect(onResume).toHaveBeenCalledTimes(1)
    // Nothing rendered — the dock stays invisible for approved plans.
    expect(screen.queryByTestId("plan-approval-dock")).not.toBeInTheDocument()
  })

  it("auto-resumes only once even when the live query re-emits the plan", async () => {
    const approvedPlan = plan({
      status: "approved",
      config: { ...DEFAULT_PLAN_CONFIG, requireApproval: false },
    })
    mockPlan.mockReturnValue(approvedPlan)
    const onResume = jest.fn()
    const { rerender } = render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1))
    // A fresh object identity (as useLiveQuery emits) must not re-fire — the
    // in-instance ref guards the window before the metadata stamp lands.
    mockPlan.mockReturnValue({ ...approvedPlan })
    rerender(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalledTimes(1))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it("does NOT auto-resume when the plan was already stamped", () => {
    mockPlan.mockReturnValue(
      plan({
        status: "approved",
        config: { ...DEFAULT_PLAN_CONFIG, requireApproval: false },
        metadata: { autoResumedAt: 123 },
      })
    )
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    expect(onResume).not.toHaveBeenCalled()
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })

  it("does NOT auto-resume when approval is required (default config)", () => {
    mockPlan.mockReturnValue(plan({ status: "approved" }))
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    expect(onResume).not.toHaveBeenCalled()
  })
})
