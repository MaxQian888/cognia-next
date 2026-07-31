/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanApprovalCard } from "./plan-approval-card"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The card delegates markdown-body rendering to the shared MarkdownRenderer;
// stub it (identity) so these tests stay focused on the card's own branching.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

// The interactive HTML body has its own suite (plan-html-view.test.tsx); stub
// it here so these tests only assert the card's view branching + edit channel.
jest.mock("./plan-html-view", () => ({
  PlanHtmlView: ({
    onSave,
    styleVariant,
    disabled,
  }: {
    onSave: (patch: { title: string; stepTitles: string[] }) => void
    styleVariant?: string
    disabled?: boolean
  }) => (
    <div
      data-testid="plan-html-view-stub"
      data-style={styleVariant ?? ""}
      data-disabled={disabled ? "true" : "false"}
    >
      <button
        data-testid="plan-html-stub-save"
        onClick={() => onSave({ title: "From HTML", stepTitles: ["html step"] })}
      />
    </div>
  ),
}))

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: over.title ?? id,
    kind: over.kind ?? "agent_turn",
    status: over.status ?? "pending",
    order: over.order ?? 0,
    dependencies: [],
  }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? [step("a", { title: "First step", order: 0 })]
  return {
    id: "p1",
    sessionId: "ses",
    title: over.title ?? "Ship the widget",
    source: over.source ?? "exit_plan_mode",
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
    metadata: over.metadata,
  }
}

const noop = {
  onApprove: jest.fn(),
  onKeepPlanning: jest.fn(),
  onDiscard: jest.fn(),
}

describe("PlanApprovalCard", () => {
  it("renders the title, status, source and steps", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} />)
    expect(screen.getByTestId("plan-approval-card")).toBeInTheDocument()
    expect(screen.getByText("Ship the widget")).toBeInTheDocument()
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("status.awaiting_approval")).toBeInTheDocument()
  })

  it("renders the full markdown body (not the step list) when metadata.planText is present", () => {
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "## Plan\n\n- step one\n- step two" } })}
        {...noop}
      />
    )
    expect(screen.getByTestId("plan-approval-body")).toBeInTheDocument()
    expect(screen.getByTestId("md")).toHaveTextContent("step one")
    // The lossy step-title projection is replaced by the faithful markdown.
    expect(screen.queryByTestId("plan-approval-steps")).not.toBeInTheDocument()
  })

  it("edits the raw markdown (not step titles) and saves planText via onEdit", async () => {
    const onEdit = jest.fn()
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- one" } })}
        {...noop}
        onEdit={onEdit}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    // The markdown editor, not the one-step-per-line textarea.
    expect(screen.queryByTestId("plan-edit-steps")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-edit-plan")).toHaveValue("- one")
    await userEvent.clear(screen.getByTestId("plan-edit-plan"))
    await userEvent.type(screen.getByTestId("plan-edit-plan"), "## New{enter}- alpha")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    expect(onEdit).toHaveBeenCalledWith({ title: "Ship the widget", planText: "## New\n- alpha" })
  })

  it("does not save an emptied markdown body (guards against wiping the plan)", async () => {
    const onEdit = jest.fn()
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- one" } })}
        {...noop}
        onEdit={onEdit}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.clear(screen.getByTestId("plan-edit-plan"))
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByTestId("plan-approval-editor")).not.toBeInTheDocument()
  })

  it("caps the card height and scrolls the step list natively (selection-safe)", () => {
    const { container } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    // Card max-h (not h): compact when short, capped when long.
    expect(screen.getByTestId("plan-approval-card").className).toContain("max-h-[45vh]")
    // Native overflow scroller wraps the step list (no hover-only Radix thumb).
    const steps = screen.getByTestId("plan-approval-steps")
    expect(steps.parentElement?.className).toContain("overflow-y-auto")
    expect(container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull()
  })

  it("maps the two primary approve buttons onto acceptEdits / default", async () => {
    const onApprove = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onApprove={onApprove} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve-auto"))
    expect(onApprove).toHaveBeenLastCalledWith("acceptEdits")
    await userEvent.click(screen.getByTestId("plan-approval-approve-review"))
    expect(onApprove).toHaveBeenLastCalledWith("default")
  })

  it("offers the fully-automated approve (auto mode) in the overflow menu", async () => {
    const onApprove = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onApprove={onApprove} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-approve-full-auto"))
    expect(onApprove).toHaveBeenCalledWith("auto")
  })

  it("fires onKeepPlanning with trimmed feedback (undefined when blank)", async () => {
    const onKeepPlanning = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onKeepPlanning={onKeepPlanning} />)
    await userEvent.click(screen.getByTestId("plan-approval-keep-planning"))
    expect(onKeepPlanning).toHaveBeenLastCalledWith(undefined)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "  focus on tests  ")
    await userEvent.click(screen.getByTestId("plan-approval-keep-planning"))
    expect(onKeepPlanning).toHaveBeenLastCalledWith("focus on tests")
  })

  it("fires onDiscard from the overflow menu with feedback", async () => {
    const onDiscard = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onDiscard={onDiscard} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "wrong direction")
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-discard"))
    expect(onDiscard).toHaveBeenCalledWith("wrong direction")
  })

  it("shows refine actions in the overflow menu only when onRefine is provided", async () => {
    const onRefine = jest.fn()
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(screen.queryByTestId("plan-refine-optimize")).not.toBeInTheDocument()
    unmount()

    render(<PlanApprovalCard plan={plan()} {...noop} onRefine={onRefine} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-refine-expand"))
    expect(onRefine).toHaveBeenCalledWith("expand", undefined)
  })

  it("disables all actions when disabled", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onRefine={jest.fn()} disabled />)
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-approve-review")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-keep-planning")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-more")).toBeDisabled()
  })

  it("opens the inline editor only when onEdit is provided and the plan awaits approval", async () => {
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    unmount()

    render(<PlanApprovalCard plan={plan({ status: "draft" })} {...noop} onEdit={jest.fn()} />)
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
  })

  it("edits title + steps inline and saves via onEdit (one step per line)", async () => {
    const onEdit = jest.fn()
    const steps = [step("a", { title: "one", order: 0 }), step("b", { title: "two", order: 1 })]
    render(<PlanApprovalCard plan={plan({ steps })} {...noop} onEdit={onEdit} />)
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    // Prefilled from the current plan.
    expect(screen.getByTestId("plan-edit-title")).toHaveValue("Ship the widget")
    expect(screen.getByTestId("plan-edit-steps")).toHaveValue("one\ntwo")

    await userEvent.clear(screen.getByTestId("plan-edit-title"))
    await userEvent.type(screen.getByTestId("plan-edit-title"), "Better title")
    await userEvent.clear(screen.getByTestId("plan-edit-steps"))
    await userEvent.type(screen.getByTestId("plan-edit-steps"), "alpha{enter}{enter}  beta  ")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    // Blank lines dropped, titles trimmed; editor closes back to the actions.
    expect(onEdit).toHaveBeenCalledWith({ title: "Better title", stepTitles: ["alpha", "beta"] })
    expect(screen.queryByTestId("plan-approval-editor")).not.toBeInTheDocument()
  })

  it("cancels the inline editor without calling onEdit", async () => {
    const onEdit = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={onEdit} />)
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.click(screen.getByTestId("plan-edit-cancel"))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByTestId("plan-approval-editor")).not.toBeInTheDocument()
  })

  it("renders the empty state when there are no steps", () => {
    render(<PlanApprovalCard plan={plan({ steps: [] })} {...noop} />)
    expect(screen.getByText("approval.noSteps")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-approval-steps")).not.toBeInTheDocument()
    // No steps → no progress bar.
    expect(screen.queryByTestId("plan-approval-progress")).not.toBeInTheDocument()
  })

  it("renders the interactive HTML body when interactiveView is on and the plan is editable", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={jest.fn()} interactiveView />)
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()
    // Static bodies are replaced…
    expect(screen.queryByTestId("plan-approval-steps")).not.toBeInTheDocument()
    // …and the pencil is redundant (inline editing lives in the HTML view).
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    // Approval actions stay native (trusted DOM).
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeInTheDocument()
  })

  it("falls back to the classic body when the plan is not editable", () => {
    // No onEdit → the interactive editor has no save channel.
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} interactiveView />)
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-steps")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-approval-view-toggle")).not.toBeInTheDocument()
    unmount()

    // Draft plan (not awaiting approval) → classic body too.
    render(
      <PlanApprovalCard
        plan={plan({ status: "draft" })}
        {...noop}
        onEdit={jest.fn()}
        interactiveView
      />
    )
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
  })

  it("toggles between the interactive and classic bodies via the header button", async () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={jest.fn()} interactiveView />)
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("plan-approval-view-toggle"))
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-steps")).toBeInTheDocument()
    // Classic mode restores the pencil editor.
    expect(screen.getByTestId("plan-approval-edit")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("plan-approval-view-toggle"))
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()
  })

  it("routes interactive saves through onEdit and mirrors the disabled state", async () => {
    const onEdit = jest.fn()
    const { unmount } = render(
      <PlanApprovalCard plan={plan()} {...noop} onEdit={onEdit} interactiveView />
    )
    await userEvent.click(screen.getByTestId("plan-html-stub-save"))
    expect(onEdit).toHaveBeenCalledWith({ title: "From HTML", stepTitles: ["html step"] })
    unmount()

    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={onEdit} interactiveView disabled />)
    expect(screen.getByTestId("plan-html-view-stub")).toHaveAttribute("data-disabled", "true")
  })

  it("forwards the interactive style preset to the HTML view", () => {
    render(
      <PlanApprovalCard
        plan={plan()}
        {...noop}
        onEdit={jest.fn()}
        interactiveView
        interactiveStyle="cards"
      />
    )
    expect(screen.getByTestId("plan-html-view-stub")).toHaveAttribute("data-style", "cards")
  })

  it("shows step progress as a count and a progressbar", () => {
    const steps = [
      step("a", { title: "one", order: 0, status: "completed" }),
      step("b", { title: "two", order: 1, status: "completed" }),
      step("c", { title: "three", order: 2, status: "in_progress" }),
      step("d", { title: "four", order: 3, status: "pending" }),
    ]
    render(<PlanApprovalCard plan={plan({ steps })} {...noop} />)
    expect(screen.getByTestId("plan-approval-progress")).toHaveTextContent("2/4")
    // 2 of 4 completed → 50%.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50")
  })
})
