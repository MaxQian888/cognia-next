/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanDocument } from "./plan-document"
import type { AgentPlan, PlanEditPatch } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  // Render real h* tags so the component's heading-query (TOC anchors +
  // scroll-spy) has DOM nodes to map onto.
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="md">
      {content.split("\n").map((line, i) => {
        const h = line.match(/^(#{1,3})\s+(.*)/)
        if (h) {
          const Tag = `h${h[1].length}` as "h1" | "h2" | "h3"
          return <Tag key={i}>{h[2]}</Tag>
        }
        return <div key={i}>{line}</div>
      })}
    </div>
  ),
}))

// jsdom does not implement Element.scrollTo — the TOC jump calls it.
beforeAll(() => {
  ;(HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = jest.fn()
})

const PLAN_TEXT = [
  "# Ship OAuth2",
  "",
  "## Context",
  "",
  "Tokens are plaintext.",
  "",
  "## Steps",
  "",
  "1. Audit call sites",
  "2. Add PKCE flow",
  "3. Swap the reducer",
  "",
  "## Risks",
  "",
  "> Rotation can strand sessions.",
].join("\n")

function makePlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    sessionId: "ses",
    projectId: "proj",
    title: "Migrate auth",
    source: "exit_plan_mode",
    status: "awaiting_approval",
    executionMode: "in_session",
    refinementCount: 0,
    config: { errorPolicy: "stop", maxConcurrency: 1 },
    steps: [
      {
        id: "s1",
        planId: "plan-1",
        order: 0,
        title: "Audit call sites",
        kind: "agent_turn",
        status: "pending",
        dependencies: [],
        attempts: 0,
      },
      {
        id: "s2",
        planId: "plan-1",
        order: 1,
        title: "Add PKCE flow",
        kind: "tool_call",
        status: "pending",
        dependencies: ["s1"],
        attempts: 0,
      },
      {
        id: "s3",
        planId: "plan-1",
        order: 2,
        title: "Swap the reducer",
        kind: "agent_turn",
        status: "pending",
        dependencies: ["s2"],
        attempts: 0,
      },
    ],
    metadata: { planText: PLAN_TEXT },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as AgentPlan
}

describe("PlanDocument", () => {
  it("renders the markdown body around the embedded step list", () => {
    render(<PlanDocument plan={makePlan()} editable onEdit={jest.fn()} />)
    const md = screen.getAllByTestId("md")
    expect(md[0].textContent).toContain("Context")
    expect(md[0].querySelector("h1")?.textContent).toBe("Ship OAuth2")
    expect(md[1].textContent).toContain("Risks")
    // Steps render between the prose segments, editable as inputs.
    expect(screen.getByTestId("plan-doc-step-1")).toHaveValue("Add PKCE flow")
    // The raw list lines stay inside the rewritten document, not duplicated.
    expect(md[0].textContent).not.toContain("Audit call sites")
  })

  it("autosaves step edits as a planText patch that rewrites the list in place", async () => {
    const onEdit = jest.fn()
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    const input = screen.getByTestId("plan-doc-step-0")
    await userEvent.clear(input)
    await userEvent.type(input, "Audit harder")
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1), { timeout: 2000 })
    const patch = onEdit.mock.calls[0][0] as PlanEditPatch
    expect("planText" in patch).toBe(true)
    if ("planText" in patch) {
      expect(patch.planText).toContain("1. Audit harder")
      expect(patch.planText).toContain("## Risks")
      expect(patch.planText).not.toContain("Audit call sites")
    }
  })

  it("adds, moves and removes steps", async () => {
    const onEdit = jest.fn()
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    await userEvent.click(screen.getByTestId("plan-doc-add"))
    expect(screen.getByTestId("plan-doc-step-3")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("plan-doc-up-1"))
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const last = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect("planText" in last && last.planText).toContain("1. Add PKCE flow\n2. Audit call sites")

    // After the move, index 0 is "Add PKCE flow" — deleting it drops that line.
    await userEvent.click(screen.getByTestId("plan-doc-del-0"))
    await waitFor(
      () => {
        const removed = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch | undefined
        expect(removed && "planText" in removed && removed.planText).not.toContain("Add PKCE flow")
      },
      { timeout: 2000 }
    )
  })

  it("renders read-only with status icons and kind chips for terminal plans", () => {
    const done = makePlan({
      status: "completed",
      steps: makePlan().steps.map((s, i) => ({
        ...s,
        status: i === 0 ? "completed" : i === 1 ? "skipped" : "pending",
      })) as AgentPlan["steps"],
    })
    render(<PlanDocument plan={done} />)
    expect(screen.queryByTestId("plan-doc-step-0")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plan-doc-add")).not.toBeInTheDocument()
    expect(screen.getByText("Audit call sites")).toBeInTheDocument()
    // Non-agent_turn kinds surface as chips.
    expect(screen.getByText("composer.kind.tool_call")).toBeInTheDocument()
  })

  it("falls back to the raw kind label for kinds the table does not know", () => {
    const plan = makePlan({
      steps: [
        {
          ...makePlan().steps[0],
          kind: "future_kind" as AgentPlan["steps"][number]["kind"],
        },
      ],
    })
    render(<PlanDocument plan={plan} />)
    expect(screen.getByText("future_kind")).toBeInTheDocument()
  })

  it("edits stepTitles for plans without a markdown body", async () => {
    const onEdit = jest.fn()
    const plan = makePlan({ metadata: {} })
    render(<PlanDocument plan={plan} editable onEdit={onEdit} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "!")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const patch = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect("stepTitles" in patch).toBe(true)
    if ("stepTitles" in patch) expect(patch.stepTitles[0]).toBe("Audit call sites!")
  })

  it("renders the TOC strip for multi-section documents and jumps on click", async () => {
    render(<PlanDocument plan={makePlan()} />)
    const toc = screen.getByTestId("plan-doc-toc")
    expect(toc.textContent).toContain("Context")
    expect(toc.textContent).toContain("Risks")
    await userEvent.click(screen.getByTestId("plan-doc-toc-3"))
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled()
  })

  it("edits only the steps-section items when the doc has other lists", async () => {
    // `parsePlanText` projects EVERY list item — the `## Files` bullets are
    // steps too — but the embedded rows own only the steps section's window.
    // Editing must rewrite just that section, not duplicate the file list
    // into it.
    const doc = [
      "# Plan",
      "",
      "## Steps",
      "",
      "1. First",
      "2. Second",
      "",
      "## Files",
      "",
      "- lib/a.ts",
      "- lib/b.ts",
    ].join("\n")
    const steps = ["First", "Second", "lib/a.ts", "lib/b.ts"].map((title, i) => ({
      id: `w${i}`,
      planId: "plan-1",
      order: i,
      title,
      kind: "agent_turn" as const,
      status: "pending" as const,
      dependencies: [],
      attempts: 0,
    }))
    const onEdit = jest.fn()
    render(
      <PlanDocument
        plan={makePlan({ metadata: { planText: doc }, steps })}
        editable
        onEdit={onEdit}
      />
    )
    // Only the two steps-section rows render — file items are prose.
    expect(screen.getByTestId("plan-doc-step-1")).toHaveValue("Second")
    expect(screen.queryByTestId("plan-doc-step-2")).not.toBeInTheDocument()

    await userEvent.clear(screen.getByTestId("plan-doc-step-0"))
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "First!")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const patch = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect("planText" in patch).toBe(true)
    if ("planText" in patch) {
      expect(patch.planText).toContain("1. First!")
      expect(patch.planText).toContain("2. Second")
      // The Files list survives untouched and was not pulled into Steps.
      expect(patch.planText).toContain("- lib/a.ts")
      expect(patch.planText).not.toContain("3. lib/a.ts")
    }
  })

  it("surfaces a save failure instead of a false saved badge", async () => {
    const onEdit = jest.fn(() => Promise.reject(new Error("db gone")))
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "x")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    await waitFor(() =>
      expect(screen.getByTestId("plan-doc-save-state").textContent).toContain("document.save.error")
    )
  })

  it("shows the autosave state while a write is pending", async () => {
    let resolve: (() => void) | undefined
    const onEdit = jest.fn(() => new Promise<void>((r) => (resolve = r)))
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "x")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    act(() => resolve?.())
    await waitFor(() =>
      expect(screen.getByTestId("plan-doc-save-state").textContent).toContain("document.save.saved")
    )
  })

  it("renders the event trail when provided", () => {
    const plan = makePlan({ status: "completed" })
    render(
      <PlanDocument
        plan={plan}
        events={[
          {
            id: "e1",
            planId: "plan-1",
            kind: "plan_created",
            ts: 1,
            payload: {
              kind: "plan_created",
              source: "exit_plan_mode",
              totalSteps: 3,
              executionMode: "in_session",
            },
          },
          { id: "e2", planId: "plan-1", kind: "approved", ts: 2, payload: { kind: "approved" } },
        ]}
      />
    )
    const trail = screen.getByTestId("plan-doc-events")
    expect(trail.textContent).toContain("document.eventKind.plan_created")
    expect(trail.textContent).toContain("document.eventKind.approved")
  })

  it("surfaces event payload details — title, feedback, reason", () => {
    const plan = makePlan({ status: "failed" })
    render(
      <PlanDocument
        plan={plan}
        events={[
          {
            id: "e1",
            planId: "plan-1",
            kind: "step_failed",
            ts: 1,
            payload: {
              kind: "step_failed",
              stepId: "s2",
              title: "Add PKCE flow",
              error: "x",
              attempt: 1,
            },
          },
          {
            id: "e2",
            planId: "plan-1",
            kind: "rejected",
            ts: 2,
            payload: { kind: "rejected", feedback: "scope is too broad" },
          },
          {
            id: "e3",
            planId: "plan-1",
            kind: "exit",
            ts: 3,
            payload: { kind: "exit", status: "failed", reason: "user bailed" },
          },
        ]}
      />
    )
    const trail = screen.getByTestId("plan-doc-events")
    expect(trail.textContent).toContain("Add PKCE flow")
    expect(trail.textContent).toContain("scope is too broad")
    expect(trail.textContent).toContain("user bailed")
  })

  it("edits the plan title when showTitle is on", async () => {
    const onEdit = jest.fn()
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} showTitle />)
    await userEvent.type(screen.getByTestId("plan-doc-title"), " v2")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const patch = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect(patch.title).toBe("Migrate auth v2")
  })

  it("appends a trailing Steps section when the markdown has no steps heading", () => {
    const noSteps = makePlan({
      metadata: { planText: "# Plan\n\n## Context\n\nOnly prose here." },
    })
    render(<PlanDocument plan={noSteps} />)
    // The executable projection still renders, under a synthesized heading
    // that joins the TOC outline.
    expect(screen.getByTestId("plan-doc-steps")).toBeInTheDocument()
    const toc = screen.getByTestId("plan-doc-toc")
    expect(toc.textContent).toContain("document.stepsHeading")
  })

  it("scroll-spy marks the deepest visible heading active on scroll", async () => {
    render(<PlanDocument plan={makePlan()} />)
    const scroller = screen.getByTestId("plan-doc-scroll")
    // jsdom reports all-zero rects, so every heading sits above the threshold
    // line — the spy lands on the last one.
    act(() => {
      scroller.dispatchEvent(new Event("scroll"))
    })
    const chips = screen.getByTestId("plan-doc-toc")
    const last = chips.lastElementChild as HTMLElement
    expect(last.className).toContain("bg-muted")
  })

  it("scrolls the active chip into view when it overflows the TOC strip", () => {
    render(<PlanDocument plan={makePlan()} />)
    const scroller = screen.getByTestId("plan-doc-scroll")
    const toc = screen.getByTestId("plan-doc-toc")
    const last = toc.lastElementChild as HTMLElement
    // Simulate a narrow strip: the last chip sits right of the viewport, so
    // the spy must translate the strip's scrollLeft to reveal it.
    Object.defineProperty(toc, "clientWidth", { configurable: true, value: 40 })
    Object.defineProperty(last, "offsetLeft", { configurable: true, value: 200 })
    Object.defineProperty(last, "offsetWidth", { configurable: true, value: 60 })
    act(() => {
      scroller.dispatchEvent(new Event("scroll"))
    })
    expect(toc.scrollLeft).toBe(192)
  })

  it("resyncs title and steps when a clean plan prop updates", async () => {
    const onEdit = jest.fn()
    const { rerender } = render(
      <PlanDocument plan={makePlan()} editable onEdit={onEdit} showTitle />
    )
    const updated = makePlan({ title: "Migrate auth v3", updatedAt: 2 })
    updated.steps = updated.steps.map((s, i) =>
      i === 0 ? { ...s, title: "Revised first step" } : s
    )
    rerender(<PlanDocument plan={updated} editable onEdit={onEdit} showTitle />)
    expect(screen.getByTestId("plan-doc-title")).toHaveValue("Migrate auth v3")
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("Revised first step")
  })
})
