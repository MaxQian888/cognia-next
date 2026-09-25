/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"
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

  it("keeps the step move / delete controls reachable without a hover", () => {
    render(<PlanDocument plan={makePlan()} editable onEdit={jest.fn()} />)
    const up = screen.getByTestId("plan-doc-up-1")
    const actions = up.parentElement
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.group) {
      expect(actions).toHaveClass(variant)
    }
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(actions).not.toHaveClass(forbidden)
    }
    expect(actions).toContainElement(screen.getByTestId("plan-doc-del-1"))
    up.focus()
    expect(up).toHaveFocus()
    // fireEvent, not userEvent: no pointer hover precedes the click.
    fireEvent.click(up)
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("Add PKCE flow")
    expect(screen.getByTestId("plan-doc-step-1")).toHaveValue("Audit call sites")
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

  it("does not print a leading H1 that restates the title, nor list it in the outline", () => {
    render(<PlanDocument plan={makePlan({ title: "Ship OAuth2" })} />)
    const md = screen.getAllByTestId("md")
    expect(md[0].querySelector("h1")).toBeNull()
    expect(md[0].textContent).toContain("Context")
    const toc = screen.getByTestId("plan-doc-toc")
    expect(toc.textContent).not.toContain("Ship OAuth2")
    expect(toc.firstElementChild?.textContent).toBe("Context")
  })

  it("renaming the plan rewrites the document's own H1", async () => {
    const onEdit = jest.fn()
    render(
      <PlanDocument plan={makePlan({ title: "Ship OAuth2" })} editable onEdit={onEdit} showTitle />
    )
    await userEvent.type(screen.getByTestId("plan-doc-title"), " now")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const patch = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect(patch.title).toBe("Ship OAuth2 now")
    expect("planText" in patch && patch.planText.startsWith("# Ship OAuth2 now\n")).toBe(true)
  })

  it("Enter adds a step below and focuses it; Backspace on an empty row removes it", async () => {
    const onEdit = jest.fn()
    render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    await userEvent.click(screen.getByTestId("plan-doc-step-0"))
    await userEvent.keyboard("{End}{Enter}")
    const inserted = screen.getByTestId("plan-doc-step-1")
    expect(inserted).toHaveValue("")
    expect(inserted).toHaveFocus()
    expect(screen.getByTestId("plan-doc-step-2")).toHaveValue("Add PKCE flow")
    await userEvent.keyboard("New step")
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const added = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect("planText" in added && added.planText).toContain(
      "1. Audit call sites\n2. New step\n3. Add PKCE flow"
    )

    await userEvent.clear(screen.getByTestId("plan-doc-step-1"))
    await userEvent.keyboard("{Backspace}")
    expect(screen.getByTestId("plan-doc-step-1")).toHaveValue("Add PKCE flow")
    expect(screen.getByTestId("plan-doc-step-0")).toHaveFocus()
  })

  it("Alt+Arrow moves the focused step and keeps focus on it", async () => {
    render(<PlanDocument plan={makePlan()} editable onEdit={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-doc-step-1"))
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}")
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("Add PKCE flow")
    expect(screen.getByTestId("plan-doc-step-0")).toHaveFocus()
    // The top row cannot move further up.
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}")
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("Add PKCE flow")
  })

  it("writes a pending edit as soon as focus leaves the document", async () => {
    const onEdit = jest.fn()
    render(
      <>
        <PlanDocument plan={makePlan()} editable onEdit={onEdit} />
        <button type="button">approve</button>
      </>
    )
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "!")
    // Moving between rows keeps the debounce…
    await userEvent.click(screen.getByTestId("plan-doc-step-1"))
    expect(onEdit).not.toHaveBeenCalled()
    // …leaving the document flushes it without waiting for the timer.
    await userEvent.click(screen.getByText("approve"))
    expect(onEdit).toHaveBeenCalledTimes(1)
    const patch = onEdit.mock.calls[0][0] as PlanEditPatch
    expect("planText" in patch && patch.planText).toContain("1. Audit call sites!")
  })

  it("writes a pending edit on unmount instead of dropping it", async () => {
    const onEdit = jest.fn()
    const { unmount } = render(<PlanDocument plan={makePlan()} editable onEdit={onEdit} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-2"), "?")
    expect(onEdit).not.toHaveBeenCalled()
    unmount()
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("writes a pending edit to the plan being left when the host switches plans", async () => {
    const onEditA = jest.fn()
    const onEditB = jest.fn()
    const { rerender } = render(<PlanDocument plan={makePlan()} editable onEdit={onEditA} />)
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "!")
    const other = makePlan({ id: "plan-2", title: "Other plan", updatedAt: 5 })
    rerender(<PlanDocument plan={other} editable onEdit={onEditB} />)
    // The edit belongs to the first plan and lands there — never on the next.
    expect(onEditA).toHaveBeenCalledTimes(1)
    const patch = onEditA.mock.calls[0][0] as PlanEditPatch
    expect("planText" in patch && patch.planText).toContain("1. Audit call sites!")
    await new Promise((r) => setTimeout(r, 900))
    expect(onEditB).not.toHaveBeenCalled()
    expect(screen.getByTestId("plan-doc-step-0")).toHaveValue("Audit call sites")
  })

  it("deletes a row without pulling another list's item into the steps section", async () => {
    const doc = "## Steps\n\n1. First\n2. Second\n\n## Files\n\n- lib/a.ts"
    const steps = ["First", "Second", "lib/a.ts"].map((title, i) => ({
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
    fireEvent.click(screen.getByTestId("plan-doc-del-0"))
    await waitFor(() => expect(onEdit).toHaveBeenCalled(), { timeout: 2000 })
    const patch = onEdit.mock.calls.at(-1)?.[0] as PlanEditPatch
    expect("planText" in patch && patch.planText).toContain("## Steps\n\n1. Second\n\n## Files")
    expect("planText" in patch && patch.planText).not.toContain("2. lib/a.ts")
  })

  it("numbers the rows of a plan that has not started, and shows status once it has", () => {
    const { rerender, container } = render(<PlanDocument plan={makePlan()} />)
    const steps = screen.getByTestId("plan-doc-steps")
    expect(steps.textContent).toContain("1.")
    expect(container.querySelector('[data-status="pending"] svg')).toBeNull()

    const running = makePlan()
    running.steps = running.steps.map((s, i) => ({
      ...s,
      status: i === 0 ? "in_progress" : "pending",
    })) as AgentPlan["steps"]
    rerender(<PlanDocument plan={running} />)
    expect(container.querySelector('[data-status="in_progress"] svg')).not.toBeNull()
  })

  it("keeps the save state inside the outline strip so it never covers content", async () => {
    render(<PlanDocument plan={makePlan()} editable onEdit={jest.fn()} />)
    const state = screen.getByTestId("plan-doc-save-state")
    expect(state.parentElement).toContainElement(screen.getByTestId("plan-doc-toc"))
    expect(state).not.toHaveClass("absolute")
    await userEvent.type(screen.getByTestId("plan-doc-step-0"), "x")
    expect(state.textContent).toContain("document.save.edited")
  })

  it("keeps the activity trail's heading out of the scroll-spy outline", () => {
    render(
      <PlanDocument
        plan={makePlan({ status: "completed" })}
        events={[
          { id: "e2", planId: "plan-1", kind: "approved", ts: 2, payload: { kind: "approved" } },
        ]}
      />
    )
    act(() => {
      screen.getByTestId("plan-doc-scroll").dispatchEvent(new Event("scroll"))
    })
    // All rects are zero in jsdom, so the spy lands on the LAST outline heading
    // — which must be a chip, not the trail's "Activity" heading.
    const last = screen.getByTestId("plan-doc-toc").lastElementChild as HTMLElement
    expect(last).toHaveAttribute("aria-current", "location")
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
