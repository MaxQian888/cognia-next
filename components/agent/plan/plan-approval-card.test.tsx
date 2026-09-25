/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanApprovalCard } from "./plan-approval-card"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
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
  onReject: jest.fn(),
}

describe("PlanApprovalCard", () => {
  it("renders the title, status, source and steps", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} />)
    expect(screen.getByTestId("plan-approval-card")).toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-title")).toHaveTextContent("Ship the widget")
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("status.awaiting_approval")).toBeInTheDocument()
    // Provenance is a sentence, never the raw enum value.
    expect(screen.getByTestId("plan-approval-source")).toHaveTextContent(
      "approval.source.exit_plan_mode"
    )
  })

  it("counts the steps a reader sees — the document's steps section, not every bullet", () => {
    const planText = "# Ship\n\n## Steps\n\n1. one\n2. two\n\n## Files\n\n- a.ts\n- b.ts"
    const steps = ["one", "two", "a.ts", "b.ts"].map((title, i) =>
      step(`s${i}`, { title, order: i })
    )
    render(<PlanApprovalCard plan={plan({ steps, metadata: { planText } })} {...noop} />)
    expect(screen.getByTestId("plan-approval-step-count")).toHaveTextContent(
      'composer.stepCount:{"count":2}'
    )
  })

  it("renders the full markdown body with the step list embedded when metadata.planText is present", () => {
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "## Plan\n\n- step one\n- step two" } })}
        {...noop}
      />
    )
    // The document surface renders the faithful markdown…
    expect(screen.getByTestId("plan-document")).toBeInTheDocument()
    expect(screen.getByTestId("md")).toHaveTextContent("step one")
    // …with the executable step projection embedded inside it (read-only here:
    // no onEdit channel was provided).
    expect(screen.getByTestId("plan-doc-steps")).toBeInTheDocument()
    expect(screen.getByText("First step")).toBeInTheDocument()
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

  it("caps the document body, not the card, and scrolls it natively (selection-safe)", () => {
    const { container } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    // The cap sits on the body so the header and decisions can never squeeze
    // the document to nothing; the card itself grows with its content.
    expect(screen.getByTestId("plan-approval-card").className).not.toMatch(/max-h-/)
    expect(screen.getByTestId("plan-document").className).toContain("max-h-[34dvh]")
    // Native overflow scroller inside the document body (no hover-only Radix thumb).
    expect(screen.getByTestId("plan-doc-scroll").className).toContain("overflow-y-auto")
    expect(container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull()
  })

  it("collapses the body and takes it out of the tab order", async () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={jest.fn()} />)
    const toggle = screen.getByTestId("plan-approval-collapse")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    const body = screen.getByTestId("plan-approval-body")
    expect(body).toHaveAttribute("data-collapsed", "true")
    expect(body).toHaveAttribute("inert")
    expect(toggle).toHaveAttribute("aria-controls", body.id)
    // Decisions stay available while collapsed.
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeEnabled()
    await userEvent.click(toggle)
    expect(body).not.toHaveAttribute("inert")
  })

  it("offers the side panel only when the host can open it", async () => {
    const onOpenPanel = jest.fn()
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    expect(screen.queryByTestId("plan-approval-open-panel")).not.toBeInTheDocument()
    unmount()
    render(<PlanApprovalCard plan={plan()} {...noop} onOpenPanel={onOpenPanel} />)
    await userEvent.click(screen.getByTestId("plan-approval-open-panel"))
    expect(onOpenPanel).toHaveBeenCalledTimes(1)
    // One reading surface: the card folds its copy of the document.
    expect(screen.getByTestId("plan-approval-body")).toHaveAttribute("data-collapsed", "true")
  })

  it("says a refinement is running and dims the body", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} refining disabled />)
    expect(screen.getByTestId("plan-approval-refining")).toHaveTextContent("approval.refining")
    expect(screen.getByTestId("plan-approval-card")).toHaveAttribute("aria-busy", "true")
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

  it("offers Reject as a visible action, confirmed with an optional reason", async () => {
    const onReject = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onReject={onReject} />)
    // No longer buried in the overflow menu.
    expect(screen.getByTestId("plan-approval-reject")).toHaveTextContent("approval.reject")
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "wrong direction")
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    // The confirm step replaces the action row and is seeded with the feedback.
    expect(screen.getByTestId("plan-approval-reject-confirm")).toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-reject-reason")).toHaveValue("wrong direction")
    expect(onReject).not.toHaveBeenCalled()
    await userEvent.clear(screen.getByTestId("plan-approval-reject-reason"))
    await userEvent.type(screen.getByTestId("plan-approval-reject-reason"), "  out of scope ")
    await userEvent.click(screen.getByTestId("plan-approval-reject-confirm-button"))
    expect(onReject).toHaveBeenCalledWith("out of scope")
  })

  it("rejects without a reason, and Back cancels the confirm step", async () => {
    const onReject = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onReject={onReject} />)
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    await userEvent.click(screen.getByTestId("plan-approval-reject-back"))
    expect(screen.queryByTestId("plan-approval-reject-confirm")).not.toBeInTheDocument()
    expect(onReject).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    await userEvent.click(screen.getByTestId("plan-approval-reject-confirm-button"))
    expect(onReject).toHaveBeenCalledWith(undefined)
  })

  it("no longer hides a discard in the overflow menu", async () => {
    render(<PlanApprovalCard plan={plan()} {...noop} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(screen.queryByTestId("plan-approval-discard")).not.toBeInTheDocument()
  })

  it("offers the plan editor in the overflow menu only when the host can open it", async () => {
    const onOpenEditor = jest.fn()
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(screen.queryByTestId("plan-approval-open-editor")).not.toBeInTheDocument()
    unmount()
    render(<PlanApprovalCard plan={plan()} {...noop} onOpenEditor={onOpenEditor} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    await userEvent.click(await screen.findByTestId("plan-approval-open-editor"))
    expect(onOpenEditor).toHaveBeenCalledTimes(1)
  })

  it("shows refine actions in the overflow menu only when onRefine is provided", async () => {
    const onRefine = jest.fn()
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(screen.queryByTestId("plan-refine-optimize")).not.toBeInTheDocument()
    unmount()

    render(<PlanApprovalCard plan={plan()} {...noop} onRefine={onRefine} />)
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(await screen.findByText("approval.refineHeading")).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId("plan-refine-expand"))
    expect(onRefine).toHaveBeenCalledWith("expand", undefined)
  })

  it("refines with the typed note and says so in the menu", async () => {
    const onRefine = jest.fn()
    render(<PlanApprovalCard plan={plan()} {...noop} onRefine={onRefine} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), " fewer steps ")
    await userEvent.click(screen.getByTestId("plan-approval-more"))
    expect(await screen.findByText("approval.refineWithNote")).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId("plan-refine-simplify"))
    expect(onRefine).toHaveBeenCalledWith("simplify", "fewer steps")
  })

  it("disables all actions when disabled", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onRefine={jest.fn()} disabled />)
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-approve-review")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-keep-planning")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-more")).toBeDisabled()
  })

  it("offers the markdown source only for an editable markdown plan", async () => {
    const md = { planText: "- one" }
    const { unmount, rerender } = render(
      <PlanApprovalCard plan={plan({ metadata: md })} {...noop} />
    )
    // No onEdit channel.
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    rerender(
      <PlanApprovalCard
        plan={plan({ status: "draft", metadata: md })}
        {...noop}
        onEdit={jest.fn()}
      />
    )
    // Not awaiting approval.
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    unmount()

    // A plan without a markdown body has no source to edit — its rows edit
    // inline in the document instead.
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={jest.fn()} />)
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("First step")
  })

  it("edits the title alongside the source and swaps the decisions for save / cancel", async () => {
    const onEdit = jest.fn()
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- one" } })}
        {...noop}
        onEdit={onEdit}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    expect(screen.getByTestId("plan-approval-edit")).toHaveAttribute("aria-pressed", "true")
    // Decisions are out of reach while the source is open.
    expect(screen.queryByTestId("plan-approval-approve-auto")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-edit-title")).toHaveValue("Ship the widget")
    await userEvent.clear(screen.getByTestId("plan-edit-title"))
    await userEvent.type(screen.getByTestId("plan-edit-title"), "Better title")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    expect(onEdit).toHaveBeenCalledWith({ title: "Better title", planText: "- one" })
    expect(screen.queryByTestId("plan-approval-editor")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeInTheDocument()
  })

  it("keeps the source editor open with the text when the save is rejected", async () => {
    const onEdit = jest.fn(() => Promise.reject(new Error("no longer awaiting approval")))
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- one" } })}
        {...noop}
        onEdit={onEdit}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.type(screen.getByTestId("plan-edit-plan"), "{enter}- two")
    await userEvent.click(screen.getByTestId("plan-edit-save"))
    expect(await screen.findByTestId("plan-edit-failed")).toHaveTextContent("composer.saveFailed")
    expect(screen.getByTestId("plan-edit-plan")).toHaveValue("- one\n- two")
  })

  it("cancels the source editor without calling onEdit", async () => {
    const onEdit = jest.fn()
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- one" } })}
        {...noop}
        onEdit={onEdit}
      />
    )
    await userEvent.click(screen.getByTestId("plan-approval-edit"))
    await userEvent.click(screen.getByTestId("plan-edit-cancel"))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByTestId("plan-approval-editor")).not.toBeInTheDocument()
  })

  it("renders the empty state when there are no steps", () => {
    render(<PlanApprovalCard plan={plan({ steps: [] })} {...noop} />)
    expect(screen.getByText("document.empty")).toBeInTheDocument()
    // No steps → no count in the header.
    expect(screen.queryByTestId("plan-approval-step-count")).not.toBeInTheDocument()
  })

  it("renders the interactive HTML body when interactiveView is on and the plan is editable", () => {
    render(<PlanApprovalCard plan={plan()} {...noop} onEdit={jest.fn()} interactiveView />)
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()
    // Static bodies are replaced…
    expect(screen.queryByTestId("plan-doc-steps")).not.toBeInTheDocument()
    // …and the pencil is redundant (inline editing lives in the HTML view).
    expect(screen.queryByTestId("plan-approval-edit")).not.toBeInTheDocument()
    // Approval actions stay native (trusted DOM).
    expect(screen.getByTestId("plan-approval-approve-auto")).toBeInTheDocument()
  })

  it("falls back to the classic body when the plan is not editable", () => {
    // No onEdit → the interactive editor has no save channel.
    const { unmount } = render(<PlanApprovalCard plan={plan()} {...noop} interactiveView />)
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-doc-steps")).toBeInTheDocument()
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
    render(
      <PlanApprovalCard
        plan={plan({ metadata: { planText: "- First step" } })}
        {...noop}
        onEdit={jest.fn()}
        interactiveView
      />
    )
    expect(screen.getByTestId("plan-html-view-stub")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("plan-approval-view-toggle"))
    expect(screen.queryByTestId("plan-html-view-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-doc-steps")).toBeInTheDocument()
    // The document view restores the markdown source toggle.
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

  it("never shows a progress bar before approval (nothing has run yet)", () => {
    const steps = [step("a", { title: "one", order: 0 }), step("b", { title: "two", order: 1 })]
    render(<PlanApprovalCard plan={plan({ steps })} {...noop} />)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})
