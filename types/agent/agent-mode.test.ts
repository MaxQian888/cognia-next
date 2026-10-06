import { BUILT_IN_AGENT_MODES, getAgentMode, getAgentModeByType } from "./agent-mode"
import type { AgentModeType } from "@cognia/provider-types/agent-mode"
import type { RoutingContext } from "@cognia/provider-types/auto-router"

describe("shared agent mode contract", () => {
  it("keeps built-in modes usable by the routing context", () => {
    for (const mode of BUILT_IN_AGENT_MODES) {
      const agentMode: AgentModeType = mode.type
      const context: RoutingContext = { agentMode }
      expect(getAgentModeByType(context.agentMode!)).toBe(mode)
      expect(getAgentMode(mode.id)).toBe(mode)
    }
  })

  it("preserves plan and build permissions after moving the shared type", () => {
    expect(getAgentModeByType("plan")?.permissionMode).toBe("plan")
    expect(getAgentModeByType("build")?.permissionMode).toBe("acceptEdits")
    expect(getAgentMode("unknown")).toBeUndefined()
  })
})
