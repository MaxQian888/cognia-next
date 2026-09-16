/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

let panelProps: Record<string, unknown> | undefined
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: (props: Record<string, unknown>) => {
    panelProps = props
    return <div data-testid="agent-runs-panel-stub" />
  },
}))

// jsdom never lays out, so the measured box is 0px; the tests drive the
// measurement directly to pin the width contract instead.
let elementWidth = 0
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => elementWidth,
}))

import { BotRunsSection } from "./runs-section"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

beforeEach(() => {
  panelProps = undefined
  elementWidth = 0
})

describe("BotRunsSection", () => {
  it("reuses the run cockpit rather than listing runs a second time", () => {
    // A Bot run is an `ExecutionRun` like any other. A second list here would
    // drift from the canonical one the first time a control verb moved.
    render(<BotRunsSection row={row()} />)
    expect(screen.getByTestId("agent-runs-panel-stub")).toBeInTheDocument()
    expect(panelProps).toMatchObject({
      embedded: true,
      filterKind: "bot",
      botInstallationId: "boti_1",
    })
  })

  it("opens with nothing selected rather than an undefined id", () => {
    render(<BotRunsSection row={row()} />)
    expect(panelProps).not.toHaveProperty("selectedId")
  })

  it("threads a picked run back in as selectedId, and clears it on null", () => {
    render(<BotRunsSection row={row()} />)
    act(() => (panelProps?.onSelect as (id: string | null) => void)("run-9"))
    expect(panelProps?.selectedId).toBe("run-9")
    act(() => (panelProps?.onSelect as (id: string | null) => void)(null))
    expect(panelProps).not.toHaveProperty("selectedId")
  })

  it("sizes the cockpit's split off the CARD's width, not the window's", () => {
    // A card in a draggable pane can be ~600px on a 1400px monitor. The
    // viewport answer would seat a 384px run list beside a detail it starves,
    // so the section hands the panel its own measurement.
    elementWidth = 900
    render(<BotRunsSection row={row()} />)
    expect(panelProps).toMatchObject({ compact: false })

    elementWidth = 500
    render(<BotRunsSection row={row()} />)
    expect(panelProps).toMatchObject({ compact: true })
  })

  it("defers to the panel's own answer until the first layout pass", () => {
    // Width 0 is "not yet measured", not "narrow" — collapsing to compact for
    // one commit would flash the wrong layout before snapping back.
    elementWidth = 0
    render(<BotRunsSection row={row()} />)
    expect(panelProps?.compact).toBeUndefined()
  })

  it("points an orphan at the full cockpit instead of an empty pane", () => {
    // The runs still exist and are still readable there. What is gone is the
    // definition that would say what any of them were.
    render(<BotRunsSection row={row({ orphaned: true })} />)
    expect(screen.queryByTestId("agent-runs-panel-stub")).not.toBeInTheDocument()
    expect(screen.getByText("Runs are still on /agent-runs")).toBeInTheDocument()
  })
})
