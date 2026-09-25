/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  PlanApprovalDock,
  PLAN_APPROVED_PROMPT,
  buildPlanApprovedPrompt,
} from "./plan-approval-dock"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The card (rendered for real here) delegates markdown rendering to the shared
// MarkdownRenderer; stub it so a planText plan doesn't pull in the heavy pipeline.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

const approvePlan = jest.fn().mockResolvedValue(null)
const rejectPlan = jest.fn().mockResolvedValue(null)
const refinePlan = jest.fn().mockResolvedValue(null)
const keepPlanning = jest.fn().mockResolvedValue(null)
const updatePlanDraft = jest.fn().mockResolvedValue(null)
const startPlan = jest.fn().mockResolvedValue(null)
const setChatResumeFailure = jest.fn().mockResolvedValue(null)
const failInSessionStep = jest.fn().mockResolvedValue(null)
// Decisions and edits re-read the row; by default it is whatever the live
// query currently returns (see beforeEach).
const getPlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({
  readPlanChatResumeFailure: (plan: AgentPlan) => plan.metadata?.chatResumeFailure ?? null,
  getPlanRuntime: () => ({
    getPlan,
    approvePlan,
    rejectPlan,
    refinePlan,
    keepPlanning,
    updatePlanDraft,
    startPlan,
    setChatResumeFailure,
    failInSessionStep,
  }),
}))

// The driver module drags in Dexie and the hook bridge; only its hook-identity
// helper is used here.
jest.mock("@/lib/agent/plan/turn-driver", () => ({
  chatPlanStepHooks: (planId: string, sessionId: string) => ({
    hookContext: { agentKind: "plan-step", agentRef: planId, sessionId },
  }),
}))

// The editor dialog has its own suite; the stub pins the props the dock hands it.
jest.mock("./plan-composer-dialog", () => ({
  PlanComposerDialog: ({
    editPlan,
    onOpenChange,
  }: {
    editPlan?: { id: string }
    onOpenChange: (open: boolean) => void
  }) => (
    <div data-testid="plan-editor-stub" data-edit={editPlan?.id}>
      <button type="button" onClick={() => onOpenChange(false)}>
        close-editor
      </button>
    </div>
  ),
}))

const mockPlan = jest.fn()
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockPlan(),
}))

const buildClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => buildClient(...a),
}))

jest.mock("@/stores/settings", () => {
  const state: { settings: Record<string, unknown> } = { settings: { foo: 1 } }
  return {
    useSettingsStore: (sel: (s: typeof state) => unknown) => sel(state),
    __setMockSettings: (s: Record<string, unknown>) => {
      state.settings = s
    },
  }
})
const { __setMockSettings } = jest.requireMock("@/stores/settings") as {
  __setMockSettings: (s: Record<string, unknown>) => void
}

// The interactive HTML body has its own suite; stub it so the settings-gate
// test doesn't pull in next-themes / the iframe document.
jest.mock("./plan-html-view", () => ({
  PlanHtmlView: ({ styleVariant }: { styleVariant?: string }) => (
    <div data-testid="plan-html-view-stub" data-style={styleVariant ?? ""} />
  ),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const revealSessionPanel = jest.fn()
jest.mock("@/lib/artifacts/reveal", () => ({
  revealSessionPanel: (...a: unknown[]) => revealSessionPanel(...a),
}))

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
  __setMockSettings({ foo: 1 })
  getPlan.mockImplementation(async () => mockPlan())
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

  it("keeps a failed continuation retryable after approval without approving or starting again", async () => {
    let livePlan = plan()
    mockPlan.mockImplementation(() => livePlan)
    approvePlan.mockImplementationOnce(async () => {
      livePlan = { ...livePlan, status: "approved" }
      return livePlan
    })
    const onResume = jest
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValue(undefined)
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
    const retry = await screen.findByRole("button", { name: "tracker.resume" })
    expect(setChatResumeFailure).toHaveBeenCalledWith("p1", {
      prompt: PLAN_APPROVED_PROMPT,
      mode: "acceptEdits",
    })
    await userEvent.click(retry)
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(2))
    expect(approvePlan).toHaveBeenCalledTimes(1)
    expect(startPlan).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "tracker.resume" })).toBeNull()
  })

  it("restores a persisted failed continuation after gate remount", async () => {
    mockPlan.mockReturnValue(
      plan({
        status: "executing",
        metadata: {
          chatResumeFailure: { prompt: "Step 1", mode: "default" },
        },
      })
    )
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByRole("button", { name: "tracker.resume" }))
    expect(onResume).toHaveBeenCalledWith("Step 1", "default")
    expect(approvePlan).not.toHaveBeenCalled()
    expect(startPlan).not.toHaveBeenCalled()
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

  // Strategy routing (ADR-0045 §2). The fixture above is `exit_plan_mode`, which
  // the resolver keeps on the orchestrated/parity path — those are the three
  // tests above. A hand-authored linear plan takes the in-session path instead.
  describe("in-session strategy", () => {
    const linear = () =>
      plan({
        source: "manual",
        steps: [step("s0", "first", 0), step("s1", "second", 1)],
      })

    it("starts the plan and resumes with the FIRST STEP's turn text", async () => {
      mockPlan.mockReturnValue(linear())
      startPlan.mockResolvedValue({
        strategy: "in_session",
        status: "executing",
        stepId: "s0",
        userMessage: "Step 1 of 2 …",
      })
      const onResume = jest.fn()
      render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
      await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
      await waitFor(() =>
        expect(startPlan).toHaveBeenCalledWith("p1", {
          hookContext: { agentKind: "plan-step", agentRef: "p1", sessionId: "ses" },
        })
      )
      expect(approvePlan).toHaveBeenCalledWith("p1")
      expect(onResume).toHaveBeenCalledWith("Step 1 of 2 …", "acceptEdits")
      expect(onResume).not.toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, expect.anything())
    })

    it("halts the plan on the step when the chat refuses its turn", async () => {
      mockPlan.mockReturnValue(linear())
      startPlan.mockResolvedValue({
        strategy: "in_session",
        status: "executing",
        stepId: "s0",
        userMessage: "Step 1 of 2 …",
        generationId: "gen-start",
      })
      const onResume = jest
        .fn()
        .mockRejectedValue(new Error("Pi process exited before the Cognia extension was ready"))
      render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
      await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
      await waitFor(() =>
        expect(failInSessionStep).toHaveBeenCalledWith("p1", {
          stepId: "s0",
          cause: "dispatch_failed",
          detail: "Pi process exited before the Cognia extension was ready",
          capturedGenerationId: "gen-start",
        })
      )
      // The step failure owns the recovery UI now, not the resume-failure alert.
      expect(setChatResumeFailure).not.toHaveBeenCalled()
    })

    it("falls back to the implementing turn when there is no runnable step", async () => {
      mockPlan.mockReturnValue(linear())
      startPlan.mockResolvedValue({ strategy: "in_session", status: "completed" })
      const onResume = jest.fn()
      render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
      await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
      await waitFor(() =>
        expect(onResume).toHaveBeenCalledWith(PLAN_APPROVED_PROMPT, "acceptEdits")
      )
    })

    it("never calls startPlan for an orchestrated plan (no double execution)", async () => {
      mockPlan.mockReturnValue(plan({ steps: [step("s0", "first", 0)] }))
      render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
      await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
      await waitFor(() => expect(approvePlan).toHaveBeenCalled())
      expect(startPlan).not.toHaveBeenCalled()
    })
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

  it("rejects with the confirmed reason via rejectPlan", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "no")
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    await userEvent.click(screen.getByTestId("plan-approval-reject-confirm-button"))
    await waitFor(() => expect(rejectPlan).toHaveBeenCalledWith("p1", "no"))
  })

  it("toasts when the rejection cannot be written", async () => {
    rejectPlan.mockRejectedValueOnce(new Error("db down"))
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    await userEvent.click(screen.getByTestId("plan-approval-reject-confirm-button"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("approval.rejectFailed"))
  })

  it("Edit opens the plan editor on this plan, and closing it unmounts it", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.queryByTestId("plan-editor-stub")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-open-editor"))
    expect(screen.getByTestId("plan-editor-stub")).toHaveAttribute("data-edit", "p1")
    await userEvent.click(screen.getByText("close-editor"))
    expect(screen.queryByTestId("plan-editor-stub")).not.toBeInTheDocument()
  })

  it("saves an inline edit via updatePlanDraft with materialized linear steps", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    // The document's rows edit in place: rename the row, Enter adds one below.
    const row = screen.getByTestId("plan-doc-step-0")
    await userEvent.clear(row)
    await userEvent.type(row, "alpha{enter}beta")
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalled(), { timeout: 3000 })
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

  it("skips the edit (no updatePlanDraft) when every step title is cleared", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.clear(screen.getByTestId("plan-doc-step-0"))
    // The autosave reached the dock (it re-reads the row before applying)…
    await waitFor(() => expect(getPlan).toHaveBeenCalled(), { timeout: 3000 })
    // …but empty titles → the guard returns early; the plan is not wiped.
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })

  it("does not apply an edit once the plan stopped awaiting approval", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    getPlan.mockResolvedValue(plan({ status: "approved", steps: [step("a", "one", 0)] }))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "!")
    // The rejected write surfaces as a failed save, never a false "Saved".
    await waitFor(
      () =>
        expect(screen.getByTestId("plan-doc-save-state")).toHaveTextContent("document.save.error"),
      { timeout: 3000 }
    )
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })

  it("approves the edited plan when Approve is clicked before the autosave fired", async () => {
    const edited = plan({
      steps: [step("a", "one!", 0)],
      metadata: { userEdited: true },
    })
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    // The row as it is once the flushed edit landed.
    updatePlanDraft.mockImplementation(async () => {
      getPlan.mockResolvedValue(edited)
      return edited
    })
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "!")
    // Clicking away from the document flushes the pending edit immediately;
    // approval waits for it and embeds the edited plan.
    await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
    await waitFor(() => expect(onResume).toHaveBeenCalled())
    expect(updatePlanDraft.mock.invocationCallOrder[0]).toBeLessThan(
      approvePlan.mock.invocationCallOrder[0]
    )
    const [prompt] = onResume.mock.calls[0] as [string]
    expect(prompt).toContain("ADJUSTED")
    expect(prompt).toContain("1. one!")
  })

  it("serializes autosaves instead of dropping one that lands mid-write", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    let release: (() => void) | undefined
    updatePlanDraft.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(null)))
    )
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    const row = screen.getByTestId("plan-doc-step-0")
    await userEvent.type(row, "1")
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalledTimes(1), { timeout: 3000 })
    // A second edit while the first write is still in flight…
    await userEvent.type(row, "2")
    release?.()
    // …is written after it, not discarded.
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalledTimes(2), { timeout: 3000 })
    const [, patch] = updatePlanDraft.mock.calls[1] as [string, { steps: PlanStep[] }]
    expect(patch.steps.map((s) => s.title)).toEqual(["one12"])
  })

  it("opens the plan in the dock's Plan panel", async () => {
    mockPlan.mockReturnValue(plan())
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-open-panel"))
    expect(revealSessionPanel).toHaveBeenCalledWith("ses", "plan")
  })

  it("marks the card as refining while a refinement is generated", async () => {
    mockPlan.mockReturnValue(plan())
    let finish: (() => void) | undefined
    refinePlan.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(null)))
    )
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-refine-simplify"))
    expect(await screen.findByTestId("plan-approval-refining")).toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeDisabled()
    finish?.()
    await waitFor(() =>
      expect(screen.queryByTestId("plan-approval-refining")).not.toBeInTheDocument()
    )
    expect(screen.getByTestId("plan-approval-approve-auto")).not.toBeDisabled()
  })

  it("saves a markdown edit → persists planText metadata + re-derived linear steps", async () => {
    mockPlan.mockReturnValue(
      plan({ steps: [step("a", "one", 0)], metadata: { planText: "- one" } })
    )
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.clear(screen.getByTestId("plan-edit-plan"))
    await userEvent.type(screen.getByTestId("plan-edit-plan"), "- alpha{enter}- beta")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalled())
    const [planId, patch] = updatePlanDraft.mock.calls[0] as [
      string,
      { title: string; steps: PlanStep[]; metadata: { planText: string } },
    ]
    expect(planId).toBe("p1")
    expect(patch.title).toBe("Ship it")
    // Full body kept for display; steps re-derived from it (linear chain).
    expect(patch.metadata.planText).toBe("- alpha\n- beta")
    expect(patch.steps.map((s) => s.title)).toEqual(["alpha", "beta"])
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

  it("approving a user-edited plan embeds the adjusted plan in the resume prompt", async () => {
    mockPlan.mockReturnValue(
      plan({
        steps: [step("a", "one", 0)],
        metadata: { userEdited: true, planText: "- alpha\n- beta" },
      })
    )
    const onResume = jest.fn()
    render(<PlanApprovalDock sessionId="ses" onResume={onResume} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
    await waitFor(() => expect(onResume).toHaveBeenCalled())
    const [prompt, mode] = onResume.mock.calls[0] as [string, string]
    expect(mode).toBe("acceptEdits")
    expect(prompt).not.toBe(PLAN_APPROVED_PROMPT)
    expect(prompt).toContain("ADJUSTED")
    expect(prompt).toContain("- alpha\n- beta")
    expect(prompt).toContain("# Ship it")
  })

  it("saving an edit stamps metadata.userEdited for the approval prompt", async () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    await userEvent.clear(screen.getByTestId("plan-doc-step-0"))
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "alpha")
    await waitFor(() => expect(updatePlanDraft).toHaveBeenCalled(), { timeout: 3000 })
    const [, patch] = updatePlanDraft.mock.calls[0] as [
      string,
      { metadata: { userEdited?: boolean } },
    ]
    expect(patch.metadata.userEdited).toBe(true)
  })

  it("renders the interactive HTML body only when planSettings.interactiveHtmlView is on", () => {
    mockPlan.mockReturnValue(plan({ steps: [step("a", "one", 0)] }))
    const { rerender } = render(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    // Default (setting absent) → classic body.
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()

    __setMockSettings({ planSettings: { interactiveHtmlView: true } })
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()
    // No persisted style → coerced to the default preset.
    expect(screen.getByTestId("plan-html-view-stub")).toHaveAttribute("data-style", "default")

    // Persisted style preset flows through; junk values coerce to default.
    __setMockSettings({
      planSettings: { interactiveHtmlView: true, interactiveHtmlStyle: "timeline" },
    })
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.getByTestId("plan-html-view-stub")).toHaveAttribute("data-style", "timeline")

    __setMockSettings({
      planSettings: { interactiveHtmlView: true, interactiveHtmlStyle: "neon" },
    })
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.getByTestId("plan-html-view-stub")).toHaveAttribute("data-style", "default")

    // Explicit off behaves like absent.
    __setMockSettings({ planSettings: { interactiveHtmlView: false } })
    rerender(<PlanApprovalDock sessionId="ses" onResume={jest.fn()} />)
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
  })
})

describe("buildPlanApprovedPrompt", () => {
  it("returns the base prompt for an unedited plan", () => {
    expect(buildPlanApprovedPrompt(plan())).toBe(PLAN_APPROVED_PROMPT)
    expect(buildPlanApprovedPrompt(plan({ metadata: { planText: "- x" } }))).toBe(
      PLAN_APPROVED_PROMPT
    )
  })

  it("embeds the edited markdown body when present", () => {
    const p = plan({ metadata: { userEdited: true, planText: "## Plan\n- do it" } })
    const prompt = buildPlanApprovedPrompt(p)
    expect(prompt).toContain("supersedes")
    expect(prompt).toContain("## Plan\n- do it")
  })

  it("falls back to a numbered step list when there is no markdown body", () => {
    const p = plan({
      steps: [step("b", "second", 1), step("a", "first", 0)],
      metadata: { userEdited: true },
    })
    const prompt = buildPlanApprovedPrompt(p)
    // Ordered by `order`, not array position.
    expect(prompt).toContain("1. first\n2. second")
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
