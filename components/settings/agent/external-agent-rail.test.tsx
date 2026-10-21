/**
 * ExternalAgentRail — props-driven rail: overview entry, agent rows grouped
 * by readiness with mini dots + quick connect, search, and the configure
 * destinations, runtime grouping and instance trait chips. The stacked pane
 * tier pushes list → detail with a back bar instead of squeezing both.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  ExternalAgentRail,
  type AgentRailGroupBy,
  type AgentStateFilter,
  type AgentRailStackedView,
  type AgentSettingsView,
} from "./external-agent-rail"
import { TooltipProvider } from "@/components/ui/tooltip"
import externalAgentMessages from "@/i18n/messages/en/externalAgent.json"
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
  ready: true,
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
const off: AgentReadiness = { ...ready, state: "off", ready: false, nextAction: "connect" }
const blocked: AgentReadiness = {
  ...ready,
  state: "blocked",
  ready: false,
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

test.each(["Codex (app-server)", "Work assistant"])(
  "shows the Codex icon for %s without preset metadata",
  (name) => {
    renderRail(
      { kind: "overview" },
      {
        agents: [
          { ...agent("codex", name, "codex", ["app-server"]), protocol: "codex-app-server" },
        ],
        readinessById: new Map([["codex", off]]),
      }
    )
    expect(screen.getByTestId("agent-row-codex").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/codex-color.svg"
    )
  }
)

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
    stateFilter?: AgentStateFilter
  } = {}
) {
  const onViewChange = jest.fn()
  const onNewAgent = jest.fn()
  const onConnect = jest.fn()
  const onDisconnect = jest.fn()
  const onGroupByChange = jest.fn()
  const onStateFilterChange = jest.fn()
  const onStackedViewChange = jest.fn()
  const rail = (nextView = view, nextStackedView = options.stackedView ?? "list") => (
    <TooltipProvider>
      <ExternalAgentRail
        agents={fixture.agents}
        readinessById={fixture.readinessById}
        traitsById={fixture.traitsById ?? new Map()}
        view={nextView}
        groupBy={options.groupBy ?? "readiness"}
        onGroupByChange={onGroupByChange}
        stateFilter={options.stateFilter ?? "all"}
        onStateFilterChange={onStateFilterChange}
        stackedView={nextStackedView}
        onStackedViewChange={onStackedViewChange}
        onViewChange={onViewChange}
        onNewAgent={onNewAgent}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        isConnecting={() => false}
      />
    </TooltipProvider>
  )
  const rendered = render(rail())
  return {
    rerenderView: (nextView: AgentSettingsView, nextStackedView: AgentRailStackedView) =>
      rendered.rerender(rail(nextView, nextStackedView)),
    onViewChange,
    onNewAgent,
    onConnect,
    onDisconnect,
    onGroupByChange,
    onStateFilterChange,
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
    expect(screen.queryByTestId("nav-quick-start")).not.toBeInTheDocument()
    for (const id of [
      "nav-global-settings",
      "nav-delegation",
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

  it("keeps management and connection actions available independently", async () => {
    const user = userEvent.setup()
    const { onViewChange } = renderRail()
    expect(screen.getByTestId("agent-power-a1")).toBeEnabled()
    expect(screen.getByTestId("nav-new-agent")).toBeEnabled()
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
    await user.click(screen.getByTestId("agent-rail-group-by"))
    expect(screen.getByRole("menuitemradio", { name: "By runtime" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    await user.click(screen.getByRole("menuitemradio", { name: "By status" }))
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

  it("delegates stacked navigation to the guarded view handler", async () => {
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
    expect(onStackedViewChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("nav-delegation"))
    expect(onViewChange).toHaveBeenCalledWith({ kind: "delegation" })
  })

  it("shows only a back bar while the detail is up; the detail carries its own heading", async () => {
    mockDensity.mockReturnValue("stacked")
    const user = userEvent.setup()
    const { onStackedViewChange } = renderRail({ kind: "agent", id: "a1" }, defaultFixture(), {
      stackedView: "detail",
    })
    expect(screen.queryByTestId("agent-row-a1")).not.toBeInTheDocument()
    expect(screen.getByTestId("external-agent-rail-bar")).not.toHaveTextContent("Alpha")
    await user.click(screen.getByTestId("external-agent-rail-back"))
    expect(onStackedViewChange).toHaveBeenCalledWith("list")
  })

  it("does not repeat a configure destination's title in the back bar", () => {
    mockDensity.mockReturnValue("stacked")
    const { rerenderView } = renderRail()
    const destinationLabel = screen.getByTestId("nav-delegation").textContent!
    expect(destinationLabel).not.toBe("")
    rerenderView({ kind: "delegation" }, "detail")
    expect(screen.getByTestId("external-agent-rail-bar")).not.toHaveTextContent(destinationLabel)
    expect(screen.getByTestId("external-agent-rail-back")).toBeInTheDocument()
  })

  it("never pushes at the split tier", async () => {
    const user = userEvent.setup()
    const { onStackedViewChange } = renderRail()
    await user.click(screen.getByTestId("agent-row-a1"))
    expect(onStackedViewChange).not.toHaveBeenCalled()
    expect(screen.getByTestId("external-agent-rail")).not.toHaveAttribute("data-stacked-view")
  })
  it.each([
    ["attention", "a3"],
    ["connected", "a1"],
    ["off", "a2"],
  ] as const)("filters rows by %s and clears the chip", async (stateFilter, visibleId) => {
    const user = userEvent.setup()
    const { onStateFilterChange } = renderRail(
      undefined,
      {
        agents: [agent("a1", "Alpha"), agent("a2", "Beta"), agent("a3", "Gamma")],
        readinessById: new Map([
          ["a1", ready],
          ["a2", off],
          ["a3", blocked],
        ]),
      },
      { stateFilter }
    )
    expect(screen.getByTestId(`agent-row-${visibleId}`)).toBeInTheDocument()
    expect(screen.getAllByTestId(/^agent-row-/)).toHaveLength(1)
    expect(screen.getByTestId("nav-global-settings")).toBeInTheDocument()
    await user.click(screen.getByTestId("agent-rail-state-filter"))
    expect(onStateFilterChange).toHaveBeenCalledWith("all")
  })

  it("includes disabled agents in Off and connecting agents in attention", () => {
    renderRail(
      undefined,
      {
        agents: [agent("disabled", "Disabled"), agent("connecting", "Connecting")],
        readinessById: new Map([
          ["disabled", { ...off, state: "disabled" }],
          ["connecting", { ...off, state: "connecting" }],
        ]),
      },
      { stateFilter: "off" }
    )
    expect(screen.getByTestId("agent-row-disabled")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-row-connecting")).not.toBeInTheDocument()
  })

  it("hides redundant preset names while preserving a custom instance's badge", () => {
    const fromPreset = (id: string, name: string) => ({
      ...agent(id, name),
      metadata: { preset: "codex" },
    })
    renderRail(undefined, {
      agents: [fromPreset("same", "  CODEX CLI  "), fromPreset("named", "Work")],
      readinessById: new Map([
        ["same", ready],
        ["named", ready],
      ]),
    })
    expect(screen.queryByTestId("agent-from-preset-same")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-from-preset-named")).toHaveTextContent("Codex CLI")
  })

  it("shows the readiness steps and states in a visible focus tooltip", async () => {
    renderRail(undefined, {
      agents: [agent("blocked", "Blocked")],
      readinessById: new Map([["blocked", blocked]]),
    })
    const dots = screen.getByTestId("agent-readiness-dots-blocked")
    expect(dots).toHaveAttribute("tabindex", "0")
    fireEvent.focus(dots)
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent(dots.getAttribute("aria-label")!)
    expect(tooltip).toHaveTextContent("Configured")
    expect(tooltip).toHaveTextContent(externalAgentMessages.readiness.stepStates.failed)
  })
})
