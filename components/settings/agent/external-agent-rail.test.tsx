/**
 * ExternalAgentRail — props-driven rail: overview entry, agent rows grouped
 * by readiness with mini dots + quick connect, search, and the configure
 * destinations, runtime grouping and instance trait chips. The stacked pane
 * tier pushes list → detail with a back bar instead of squeezing both.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  ExternalAgentRail,
  type AgentRailGroupBy,
  type AgentRailStackedView,
  type AgentSettingsView,
} from "./external-agent-rail"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { InstanceTrait } from "@/components/agent/external-agent/instance-traits"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

// The rail reads the list density off `SettingsListDetail`; standalone tests
// get the "split" tier by default, and the push tests flip it to stacked.
const mockDensity = jest.fn<"split" | "stacked", []>(() => "split")
jest.mock("@/components/settings/common/settings-master-detail", () => {
  const actual = jest.requireActual("@/components/settings/common/settings-master-detail")
  return {
    ...(actual as Record<string, unknown>),
    useSettingsListDensity: () => mockDensity(),
  }
})

const agent = (id: string, name: string, command = "npx", args = ["agent"]) =>
  ({
    id,
    name,
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command, args },
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
    traitsById?: Map<string, InstanceTrait[]>
  } = defaultFixture(),
  options: {
    groupBy?: AgentRailGroupBy
    stackedView?: AgentRailStackedView
    enabled?: boolean
  } = {}
) {
  const onViewChange = jest.fn()
  const onNewAgent = jest.fn()
  const onConnect = jest.fn()
  const onDisconnect = jest.fn()
  const onGroupByChange = jest.fn()
  const onStackedViewChange = jest.fn()
  render(
    <ExternalAgentRail
      agents={fixture.agents}
      readinessById={fixture.readinessById}
      traitsById={fixture.traitsById ?? new Map()}
      view={view}
      enabled={options.enabled ?? true}
      groupBy={options.groupBy ?? "readiness"}
      onGroupByChange={onGroupByChange}
      stackedView={options.stackedView ?? "list"}
      onStackedViewChange={onStackedViewChange}
      onViewChange={onViewChange}
      onNewAgent={onNewAgent}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      isConnecting={() => false}
    />
  )
  return {
    onViewChange,
    onNewAgent,
    onConnect,
    onDisconnect,
    onGroupByChange,
    onStackedViewChange,
  }
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

  it("marks the selected agent row as the current page, and only it", () => {
    renderRail({ kind: "agent", id: "a1" })
    expect(screen.getByTestId("agent-row-a1")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("agent-row-a2")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("nav-all-agents")).not.toHaveAttribute("aria-current")
  })

  it("leaves the power button off for a disabled master switch but keeps rows selectable", async () => {
    const user = userEvent.setup()
    const { onViewChange } = renderRail(undefined, defaultFixture(), { enabled: false })
    expect(screen.getByTestId("agent-power-a1")).toBeDisabled()
    expect(screen.getByTestId("nav-new-agent")).toBeDisabled()
    await user.click(screen.getByTestId("agent-row-a2"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "agent", id: "a2" })
  })

  it("gives keyboard and screen-reader users the block reason, not just a hover title", () => {
    renderRail(undefined, {
      agents: [agent("a3", "Gamma")],
      readinessById: new Map([["a3", blocked]]),
    })
    const row = screen.getByTestId("agent-row-a3")
    const describedBy = row.getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent("command not found")
    // A blocked agent cannot take a connection, so its power button is off.
    expect(screen.getByTestId("agent-power-a3")).toBeDisabled()
  })

  it("shows what sets each instance apart under its name", () => {
    renderRail(undefined, {
      ...defaultFixture(),
      traitsById: new Map<string, InstanceTrait[]>([
        [
          "a1",
          [
            { key: "stateIsolation", value: "isolated" },
            { key: "permissionMode", value: "plan" },
          ],
        ],
      ]),
    })
    const row = screen.getByTestId("agent-row-a1")
    expect(row).toHaveTextContent("Own state")
    expect(row).toHaveTextContent("Plan")
    expect(screen.getByTestId("agent-row-a2")).not.toHaveTextContent("Own state")
  })

  it("groups configurations of one runtime together when asked", async () => {
    const user = userEvent.setup()
    const fixture = {
      agents: [
        agent("c1", "Codex work", "codex", ["app-server"]),
        agent("q1", "Qwen", "qwen", []),
        agent("c2", "Codex personal", "codex", ["app-server"]),
      ],
      readinessById: new Map<string, AgentReadiness>([
        ["c1", ready],
        ["q1", ready],
        ["c2", off],
      ]),
    }
    const { onGroupByChange } = renderRail(undefined, fixture, { groupBy: "runtime" })
    const groups = screen.getAllByRole("group")
    // Both Codex configurations land in one family, whatever their readiness.
    const codex = groups.find((group) => group.contains(screen.getByTestId("agent-row-c1")))!
    expect(codex).toContainElement(screen.getByTestId("agent-row-c2"))
    expect(codex).not.toContainElement(screen.getByTestId("agent-row-q1"))
    await user.click(screen.getByRole("radio", { name: "By status" }))
    expect(onGroupByChange).toHaveBeenCalledWith("readiness")
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

  it("pushes from the list to the detail at the stacked tier", async () => {
    mockDensity.mockReturnValue("stacked")
    const user = userEvent.setup()
    const { onViewChange, onStackedViewChange } = renderRail(
      { kind: "overview" },
      defaultFixture(),
      { stackedView: "list" }
    )
    // The whole list is on screen, with the same rows as the split tier.
    expect(screen.getByTestId("external-agent-rail")).toHaveAttribute("data-stacked-view", "list")
    await user.click(screen.getByTestId("agent-row-a2"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "agent", id: "a2" })
    expect(onStackedViewChange).toHaveBeenCalledWith("detail")
    await user.click(screen.getByTestId("nav-delegation"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "delegation" })
  })

  it("shows a back bar naming the open destination while the detail is up", async () => {
    mockDensity.mockReturnValue("stacked")
    const user = userEvent.setup()
    const { onStackedViewChange } = renderRail({ kind: "agent", id: "a1" }, defaultFixture(), {
      stackedView: "detail",
    })
    expect(screen.queryByTestId("agent-row-a1")).not.toBeInTheDocument()
    expect(screen.getByTestId("external-agent-rail-bar")).toHaveTextContent("Alpha")
    await user.click(screen.getByTestId("external-agent-rail-back"))
    expect(onStackedViewChange).toHaveBeenCalledWith("list")
  })

  it("names a configure destination in the back bar", () => {
    mockDensity.mockReturnValue("stacked")
    renderRail({ kind: "delegation" }, defaultFixture(), { stackedView: "detail" })
    expect(screen.getByTestId("external-agent-rail-bar")).toHaveTextContent("Delegation Rules")
  })

  it("never pushes at the split tier", async () => {
    const user = userEvent.setup()
    const { onStackedViewChange } = renderRail()
    await user.click(screen.getByTestId("agent-row-a1"))
    expect(onStackedViewChange).not.toHaveBeenCalled()
    expect(screen.getByTestId("external-agent-rail")).not.toHaveAttribute("data-stacked-view")
  })
})
