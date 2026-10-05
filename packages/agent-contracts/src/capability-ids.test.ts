import { AGENT_CAPABILITY_IDS, isAgentCapabilityId } from "./capability-ids"

describe("capability vocabulary", () => {
  it("has no duplicate ids", () => {
    expect(new Set(AGENT_CAPABILITY_IDS).size).toBe(AGENT_CAPABILITY_IDS.length)
  })

  it("recognises only listed ids", () => {
    expect(isAgentCapabilityId("session.resume")).toBe(true)
    expect(isAgentCapabilityId("session.teleport")).toBe(false)
    expect(isAgentCapabilityId(42)).toBe(false)
  })
})
