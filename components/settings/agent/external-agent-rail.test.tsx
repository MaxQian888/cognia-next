/**
 * ExternalAgentRail — props-driven rail: overview entry, agent rows grouped
 * by readiness with mini dots + quick connect, search, and the configure
 * destinations. The stacked pane tier collapses it into a Select picker.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalAgentRail, type AgentSettingsView } from "./external-agent-rail"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

// The rail reads the list density off `SettingsListDetail`; standalone tests
// get the "split" tier by default, and the picker tests flip it to stacked.
const mockDensity = jest.fn<"split" | "stacked", []>(() => "split")
jest.mock("@/components/settings/common/settings-master-detail", () => {
  const actual = jest.requireActual("@/components/settings/common/settings-master-detail")
  return {
    ...(actual as Record<string, unknown>),
    useSettingsListDensity: () => mockDensity(),
  }
})

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "npx", args: ["agent"] },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as LifecycleExternalAgentConfig

const ready: AgentReadiness = {
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
}
const off: AgentReadiness = { ...ready, state: "off", nextAction: "connect" }
const blocked: AgentReadiness = {
  ...ready,
  state: "blocked",
  blockReason: "command not found",
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "failed" },
    { id: "connected", state: "todo" },
    { id: "routed", state: "todo" },
  ],
  nextAction: "inspect",
}

const defaultFixture = () => ({
  agents: [agent("a1", "Alpha"), agent("a2", "Beta")],
  readinessById: new Map<string, AgentReadiness>([
    ["a1", ready],
    ["a2", off],
  ]),
})

function renderRail(
  view: AgentSettingsView = { kind: "overview" },
  fixture: {
    agents: LifecycleExternalAgentConfig[]
    readinessById: Map<string, AgentReadiness>
  } = defaultFixture()
) {
  const onViewChange = jest.fn()
  const onNewAgent = jest.fn()
  const onConnect = jest.fn()
  const onDisconnect = jest.fn()
  render(
    <ExternalAgentRail
      agents={fixture.agents}
      readinessById={fixture.readinessById}
      view={view}
      enabled
      onViewChange={onViewChange}
      onNewAgent={onNewAgent}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      isConnecting={() => false}
    />
  )
  return { onViewChange, onNewAgent, onConnect, onDisconnect }
}

describe("ExternalAgentRail", () => {
  beforeEach(() => {
    mockDensity.mockReturnValue("split")
  })

  it("renders the pinned overview, agent rows, and every configure destination", () => {
    renderRail()
    expect(screen.getByTestId("nav-all-agents")).toBeInTheDocument()
    expect(screen.getByTestId("agent-row-a1")).toBeInTheDocument()
    expect(screen.getByTestId("agent-row-a2")).toBeInTheDocument()
    expect(screen.getByTestId("nav-new-agent")).toBeInTheDocument()
    for (const id of [
      "nav-global-settings",
      "nav-delegation",
      "nav-quick-start",
      "nav-runtimes",
      "nav-host-configs",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it("selects an agent and switches destinations through onViewChange", async () => {
    const user = userEvent.setup()
    const { onViewChange } = renderRail()
    await user.click(screen.getByTestId("agent-row-a1"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "agent", id: "a1" })
    await user.click(screen.getByTestId("nav-delegation"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "delegation" })
  })

  it("marks the selected agent row and pressed overview", () => {
    renderRail({ kind: "agent", id: "a1" })
    expect(screen.getByTestId("agent-row-a1")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("nav-all-agents")).toHaveAttribute("aria-pressed", "false")
  })

  it("quick-connects a disconnected row and disconnects a connected one", async () => {
    const user = userEvent.setup()
    const { onConnect, onDisconnect } = renderRail()
    await user.click(screen.getByTestId("agent-power-a2"))
    expect(onConnect).toHaveBeenCalledWith("a2")
    await user.click(screen.getByTestId("agent-power-a1"))
    expect(onDisconnect).toHaveBeenCalledWith("a1")
  })

  it("opens the editor through the New agent row", async () => {
    const user = userEvent.setup()
    const { onNewAgent } = renderRail()
    await user.click(screen.getByTestId("nav-new-agent"))
    expect(onNewAgent).toHaveBeenCalled()
  })

  it("groups the fleet by readiness with problems on top", () => {
    renderRail(undefined, {
      agents: [agent("a1", "Alpha"), agent("a2", "Beta"), agent("a3", "Gamma")],
      readinessById: new Map([
        ["a1", ready],
        ["a2", off],
        ["a3", blocked],
      ]),
    })
    const rail = screen.getByTestId("external-agent-rail")
    const text = rail.textContent ?? ""
    // Attention precedes Connected precedes Inactive, so a broken agent is
    // never buried mid-list.
    const attentionAt = text.indexOf("Needs attention")
    const connectedAt = text.indexOf("Connected")
    const inactiveAt = text.indexOf("Inactive")
    expect(attentionAt).toBeGreaterThanOrEqual(0)
    expect(connectedAt).toBeGreaterThan(attentionAt)
    expect(inactiveAt).toBeGreaterThan(connectedAt)
    expect(screen.getByTestId("agent-row-a3")).toBeInTheDocument()
  })

  it("filters the fleet rows by the search box", async () => {
    const user = userEvent.setup()
    renderRail()
    await user.type(screen.getByTestId("agent-search"), "alph")
    expect(screen.getByTestId("agent-row-a1")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-row-a2")).not.toBeInTheDocument()
    await user.clear(screen.getByTestId("agent-search"))
    expect(screen.getByTestId("agent-row-a2")).toBeInTheDocument()
    await user.type(screen.getByTestId("agent-search"), "zzz")
    expect(screen.queryByTestId("agent-row-a1")).not.toBeInTheDocument()
    expect(screen.getByText("No agents match your search")).toBeInTheDocument()
    // The destinations are not part of the fleet filter — they stay put.
    expect(screen.getByTestId("nav-global-settings")).toBeInTheDocument()
    expect(screen.getByTestId("nav-new-agent")).toBeInTheDocument()
  })

  it("collapses to a picker at the stacked tier and routes selections", async () => {
    mockDensity.mockReturnValue("stacked")
    const user = userEvent.setup()
    const { onViewChange } = renderRail({ kind: "agent", id: "a1" })
    // The scrolling list is gone; every destination lives in the Select.
    expect(screen.queryByTestId("agent-row-a1")).not.toBeInTheDocument()
    const picker = screen.getByTestId("nav-picker")
    expect(picker).toHaveTextContent("Alpha")
    await user.click(picker)
    await user.click(await screen.findByRole("option", { name: "Beta" }))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "agent", id: "a2" })
    await user.click(picker)
    await user.click(await screen.findByRole("option", { name: "Delegation Rules" }))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "delegation" })
  })
})
