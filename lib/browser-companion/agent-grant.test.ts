import { validateAgentCapabilityGrant } from "@cognia/agent-config-types/agent-capability-grant"

import { BROWSER_COMPANION_AGENT_INSTRUCTION, browserCompanionGrant } from "./agent-grant"

describe("browserCompanionGrant", () => {
  it("is a valid grant that only adds instructions", () => {
    const grant = browserCompanionGrant("browser-a")
    expect(grant).toEqual({
      schemaVersion: 1,
      source: { kind: "browser-companion", id: "browser-a" },
      instructions: [BROWSER_COMPANION_AGENT_INSTRUCTION],
    })
    // No tool, skill, MCP or permission change: those would widen or narrow
    // the run beyond "act in the browser the user started from".
    expect(grant).not.toHaveProperty("tools")
    expect(grant).not.toHaveProperty("permissionMode")
    expect(validateAgentCapabilityGrant(grant)).toMatchObject({ ok: true })
  })

  it("tells the model how the user stays in charge", () => {
    for (const phrase of [
      "browser_site_permission_required",
      "browser_user_takeover",
      "password",
    ]) {
      expect(BROWSER_COMPANION_AGENT_INSTRUCTION).toContain(phrase)
    }
  })
})
