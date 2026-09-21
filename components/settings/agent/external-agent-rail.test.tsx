/**
 * ExternalAgentRail — props-driven rail: overview entry, agent rows with
 * mini readiness dots + quick connect, and the configure destinations.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalAgentRail, type AgentSettingsView } from "./external-agent-rail"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

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

function renderRail(view: AgentSettingsView = { kind: "overview" }) {
  const onViewChange = jest.fn()
  const onNewAgent = jest.fn()
  const onConnect = jest.fn()
  const onDisconnect = jest.fn()
  render(
    <ExternalAgentRail
      agents={[agent("a1", "Alpha"), agent("a2", "Beta")]}
      readinessById={
        new Map([
          ["a1", ready],
          ["a2", off],
        ])
      }
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
})
