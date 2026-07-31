/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { PlanHtmlView } from "./plan-html-view"
import { PLAN_HTML_MSG } from "@/lib/agent/plan/plan-html"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockResolvedTheme = jest.fn<string, []>(() => "light")
jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme() }),
}))

function step(id: string, title: string, order: number): PlanStep {
  return { id, title, kind: "agent_turn", status: "pending", order, dependencies: [] }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? [step("s1", "Research", 0), step("s2", "Implement", 1)]
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps,
    status: "awaiting_approval",
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

function frame(): HTMLIFrameElement {
  return screen.getByTestId("plan-html-frame") as HTMLIFrameElement
}

function postFromFrame(data: unknown, source?: Window | null) {
  const src = source === undefined ? frame().contentWindow : source
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source: src as Window }))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolvedTheme.mockReturnValue("light")
})

describe("PlanHtmlView", () => {
  it("renders a sandboxed iframe whose document carries the plan data", () => {
    render(<PlanHtmlView plan={plan()} onSave={jest.fn()} />)
    const el = frame()
    expect(el.getAttribute("sandbox")).toBe("allow-scripts")
    expect(el.srcdoc).toContain('"title":"Ship it"')
    expect(el.srcdoc).toContain('"Research"')
    expect(el.srcdoc).toContain('"Implement"')
    expect(el.srcdoc).toContain('<body class="theme-light style-default">')
    // Steps are serialized in display order.
    expect(el.srcdoc.indexOf('"Research"')).toBeLessThan(el.srcdoc.indexOf('"Implement"'))
  })

  it("orders steps by their order field, not array position", () => {
    render(
      <PlanHtmlView
        plan={plan({ steps: [step("s2", "Second", 1), step("s1", "First", 0)] })}
        onSave={jest.fn()}
      />
    )
    const doc = frame().srcdoc
    expect(doc.indexOf('"First"')).toBeLessThan(doc.indexOf('"Second"'))
  })

  it("uses the dark theme when resolved", () => {
    mockResolvedTheme.mockReturnValue("dark")
    render(<PlanHtmlView plan={plan()} onSave={jest.fn()} />)
    expect(frame().srcdoc).toContain('<body class="theme-dark style-default">')
  })

  it("applies the styleVariant preset, coercing unknown values to default", () => {
    const { unmount } = render(
      <PlanHtmlView plan={plan()} onSave={jest.fn()} styleVariant="timeline" />
    )
    expect(frame().srcdoc).toContain('<body class="theme-light style-timeline">')
    unmount()

    render(<PlanHtmlView plan={plan()} onSave={jest.fn()} styleVariant={"neon" as never} />)
    expect(frame().srcdoc).toContain('<body class="theme-light style-default">')
  })

  it("hides the loading shimmer on the ready message and resizes within bounds", () => {
    render(<PlanHtmlView plan={plan()} onSave={jest.fn()} />)
    expect(screen.getByTestId("plan-html-loading")).toBeInTheDocument()

    postFromFrame({ type: PLAN_HTML_MSG.ready })
    expect(screen.queryByTestId("plan-html-loading")).not.toBeInTheDocument()

    postFromFrame({ type: PLAN_HTML_MSG.resize, height: 300 })
    expect(frame().style.height).toBe("300px")
    postFromFrame({ type: PLAN_HTML_MSG.resize, height: 9999 })
    expect(frame().style.height).toBe("560px")
    postFromFrame({ type: PLAN_HTML_MSG.resize, height: 1 })
    expect(frame().style.height).toBe("140px")
    // Garbage heights are ignored.
    postFromFrame({ type: PLAN_HTML_MSG.resize, height: Number.NaN })
    expect(frame().style.height).toBe("140px")
  })

  it("ignores messages from foreign sources", () => {
    const onSave = jest.fn()
    render(<PlanHtmlView plan={plan()} onSave={onSave} />)
    postFromFrame(
      { type: PLAN_HTML_MSG.save, title: "Evil", stepTitles: ["x"], stepsChanged: true },
      window
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("translates a save into a stepTitles patch for a plain plan", () => {
    const onSave = jest.fn()
    render(<PlanHtmlView plan={plan()} onSave={onSave} />)
    postFromFrame({
      type: PLAN_HTML_MSG.save,
      title: "  New title  ",
      stepTitles: ["  Step A ", "", "Step B"],
      stepsChanged: true,
    })
    expect(onSave).toHaveBeenCalledWith({ title: "New title", stepTitles: ["Step A", "Step B"] })
  })

  it("keeps the original markdown body when only the title changed", () => {
    const onSave = jest.fn()
    render(
      <PlanHtmlView
        plan={plan({ metadata: { planText: "# Rich\n\n- Research\n- Implement" } })}
        onSave={onSave}
      />
    )
    postFromFrame({
      type: PLAN_HTML_MSG.save,
      title: "Renamed",
      stepTitles: ["Research", "Implement"],
      stepsChanged: false,
    })
    expect(onSave).toHaveBeenCalledWith({
      title: "Renamed",
      planText: "# Rich\n\n- Research\n- Implement",
    })
  })

  it("regenerates the markdown body when steps were adjusted", () => {
    const onSave = jest.fn()
    render(<PlanHtmlView plan={plan({ metadata: { planText: "# Rich body" } })} onSave={onSave} />)
    postFromFrame({
      type: PLAN_HTML_MSG.save,
      title: "Ship it",
      stepTitles: ["Research", "Ship"],
      stepsChanged: true,
    })
    expect(onSave).toHaveBeenCalledWith({ title: "Ship it", planText: "- Research\n- Ship" })
  })

  it("drops malformed or empty saves", () => {
    const onSave = jest.fn()
    render(<PlanHtmlView plan={plan()} onSave={onSave} />)
    postFromFrame({ type: PLAN_HTML_MSG.save, title: 42, stepTitles: ["x"], stepsChanged: true })
    postFromFrame({ type: PLAN_HTML_MSG.save, title: "t", stepTitles: "nope", stepsChanged: true })
    postFromFrame({
      type: PLAN_HTML_MSG.save,
      title: "t",
      stepTitles: ["  ", ""],
      stepsChanged: true,
    })
    postFromFrame(null)
    postFromFrame("string")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("blocks interaction and saves while disabled", () => {
    const onSave = jest.fn()
    render(<PlanHtmlView plan={plan()} onSave={onSave} disabled />)
    expect(screen.getByTestId("plan-html-disabled-overlay")).toBeInTheDocument()
    postFromFrame({
      type: PLAN_HTML_MSG.save,
      title: "T",
      stepTitles: ["x"],
      stepsChanged: true,
    })
    expect(onSave).not.toHaveBeenCalled()
  })
})
