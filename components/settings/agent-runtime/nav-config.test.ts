import {
  AGENT_RUNTIME_NAV_GROUPS,
  AGENT_RUNTIME_NAV_ITEMS,
  AGENT_RUNTIME_PANEL_PARAM,
  DEFAULT_AGENT_RUNTIME_PANEL,
  resolveAgentRuntimePanel,
} from "./nav-config"

describe("agent-runtime nav-config", () => {
  it("exposes every grouped item in the flat list", () => {
    const grouped = AGENT_RUNTIME_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(AGENT_RUNTIME_NAV_ITEMS.map((i) => i.id)).toEqual(grouped)
  })

  it("covers all five panels exactly once", () => {
    const ids = AGENT_RUNTIME_NAV_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(
      ["a2ui", "defaults", "permissions", "sessions", "sidecar"].sort()
    )
  })

  it("keeps the legacy tab param so existing deep links still resolve", () => {
    expect(AGENT_RUNTIME_PANEL_PARAM).toBe("agentRuntimeTab")
  })

  it("resolves a known deep link", () => {
    expect(resolveAgentRuntimePanel("sessions")).toBe("sessions")
  })

  it("falls back to the default for unknown, empty and absent values", () => {
    expect(resolveAgentRuntimePanel("nope")).toBe(DEFAULT_AGENT_RUNTIME_PANEL)
    expect(resolveAgentRuntimePanel("")).toBe(DEFAULT_AGENT_RUNTIME_PANEL)
    expect(resolveAgentRuntimePanel(null)).toBe(DEFAULT_AGENT_RUNTIME_PANEL)
    expect(resolveAgentRuntimePanel(undefined)).toBe(DEFAULT_AGENT_RUNTIME_PANEL)
  })

  it("gives every item an icon so no nav row renders bare", () => {
    for (const item of AGENT_RUNTIME_NAV_ITEMS) {
      expect(item.icon).toBeDefined()
    }
  })
})
