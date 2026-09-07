/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

let panelProps: Record<string, unknown> | undefined
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: (props: Record<string, unknown>) => {
    panelProps = props
    return <div data-testid="agent-runs-panel-stub" />
  },
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

  it("points an orphan at the full cockpit instead of an empty pane", () => {
    // The runs still exist and are still readable there. What is gone is the
    // definition that would say what any of them were.
    render(<BotRunsSection row={row({ orphaned: true })} />)
    expect(screen.queryByTestId("agent-runs-panel-stub")).not.toBeInTheDocument()
    expect(screen.getByText("Runs are still on /agent-runs")).toBeInTheDocument()
  })
})
