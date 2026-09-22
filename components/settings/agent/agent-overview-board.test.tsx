/**
 * AgentOverviewBoard — the fleet landing view: collapsible connected/total
 * banner, one readiness row per agent, and the model's next action per row.
 */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentOverviewBoard } from "./agent-overview-board"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as LifecycleExternalAgentConfig

const readiness = (over: Partial<AgentReadiness>): AgentReadiness => ({
  state: "connected",
  blockReason: null,
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "done" },
    { id: "connected", state: "done" },
    { id: "routed", state: "done" },
  ],
  nextAction: null,
  ...over,
})

const entries = [
  { agent: agent("a1", "Alpha"), readiness: readiness({}) },
  {
    agent: agent("a2", "Beta"),
    readiness: readiness({ state: "off", nextAction: "connect" }),
  },
  {
    agent: agent("a3", "Gamma"),
    readiness: readiness({
      state: "blocked",
      blockReason: "runtime not installed",
      nextAction: "inspect",
    }),
  },
]

function renderBoard(over: Partial<Parameters<typeof AgentOverviewBoard>[0]> = {}) {
  const props = {
    entries,
    enabled: true,
    bannerCollapsed: false,
    onBannerCollapsedChange: jest.fn(),
    onOpenAgent: jest.fn(),
    onAction: jest.fn(),
    onNewAgent: jest.fn(),
    ...over,
  }
  render(<AgentOverviewBoard {...props} />)
  return props
}

describe("AgentOverviewBoard", () => {
  it("summarizes the fleet in the expanded banner", () => {
    renderBoard()
    expect(screen.getByTestId("fleet-banner-expanded")).toHaveTextContent("1 of 3 agents connected")
  })

  it("collapses to a one-line summary and reports the store flag", async () => {
    const user = userEvent.setup()
    const { onBannerCollapsedChange } = renderBoard()
    await user.click(screen.getByTestId("fleet-banner-collapse"))
    expect(onBannerCollapsedChange).toHaveBeenCalledWith(true)
  })

  it("renders the compact banner when collapsed and expands on click", async () => {
    const user = userEvent.setup()
    const { onBannerCollapsedChange } = renderBoard({ bannerCollapsed: true })
    expect(screen.getByTestId("fleet-banner-collapsed")).toHaveTextContent("1/3 connected")
    await user.click(screen.getByTestId("fleet-banner-expand"))
    expect(onBannerCollapsedChange).toHaveBeenCalledWith(false)
  })

  it("opens the inspector from a row and runs the row's next action", async () => {
    const user = userEvent.setup()
    const { onOpenAgent, onAction } = renderBoard()
    await user.click(screen.getByTestId("overview-open-a1"))
    expect(onOpenAgent).toHaveBeenCalledWith("a1")
    await user.click(screen.getByTestId("overview-action-a2"))
    expect(onAction).toHaveBeenCalledWith("a2", "connect")
    await user.click(screen.getByTestId("overview-action-a3"))
    expect(onAction).toHaveBeenCalledWith("a3", "inspect")
  })

  it("shows the block reason on a blocked row", () => {
    renderBoard()
    expect(
      within(screen.getByTestId("overview-row-a3")).getByText("runtime not installed")
    ).toBeInTheDocument()
  })

  it("spins a connecting row and softens a transient block reason", () => {
    renderBoard({
      entries: [
        {
          agent: agent("a4", "Delta"),
          readiness: readiness({ state: "connecting" }),
        },
        {
          agent: agent("a5", "Epsilon"),
          readiness: readiness({
            state: "blocked",
            blockReason: "runtime update in progress",
            blockTransient: true,
          }),
        },
      ],
    })
    const connectingRow = screen.getByTestId("overview-row-a4")
    expect(connectingRow.querySelector(".animate-spin")).toBeInTheDocument()
    // A transient reason is informational, not alarming — muted, not amber.
    const reason = within(screen.getByTestId("overview-row-a5")).getByText(
      "runtime update in progress"
    )
    expect(reason).toHaveClass("text-muted-foreground")
  })

  it("renders the empty state with an add action when no agents exist", async () => {
    const user = userEvent.setup()
    const { onNewAgent } = renderBoard({ entries: [] })
    expect(screen.getByTestId("overview-empty")).toBeInTheDocument()
    await user.click(screen.getByTestId("overview-add-agent"))
    expect(onNewAgent).toHaveBeenCalled()
  })
})
