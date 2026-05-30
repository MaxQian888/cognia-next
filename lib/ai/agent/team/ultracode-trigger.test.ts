import { isUltracodeActive } from "./ultracode-trigger"
import type { AgentTeam } from "@/types/agent/agent-team"

function team(
  ultracode?: AgentTeam["config"]["ultracode"],
  complexity?: "simple" | "moderate" | "complex"
): Pick<AgentTeam, "config" | "routingAssessment"> {
  return {
    config: { ultracode } as AgentTeam["config"],
    routingAssessment: complexity
      ? ({ factors: { taskComplexity: complexity } } as AgentTeam["routingAssessment"])
      : undefined,
  }
}

describe("isUltracodeActive", () => {
  it("force override always wins", () => {
    expect(isUltracodeActive(team(undefined), "force")).toBe(true)
    expect(isUltracodeActive(team({ enabled: false }), "force")).toBe(true)
  })

  it("off override always wins", () => {
    expect(isUltracodeActive(team({ enabled: true, autoMode: "always" }), "off")).toBe(false)
  })

  it("is inactive when ultracode is not enabled", () => {
    expect(isUltracodeActive(team(undefined))).toBe(false)
    expect(isUltracodeActive(team({ enabled: false, autoMode: "always" }))).toBe(false)
  })

  it("always mode orchestrates every enabled run", () => {
    expect(isUltracodeActive(team({ enabled: true, autoMode: "always" }))).toBe(true)
  })

  it("never mode never orchestrates", () => {
    expect(isUltracodeActive(team({ enabled: true, autoMode: "never" }, "complex"))).toBe(false)
  })

  it("auto mode orchestrates only complex tasks", () => {
    expect(isUltracodeActive(team({ enabled: true, autoMode: "auto" }, "complex"))).toBe(true)
    expect(isUltracodeActive(team({ enabled: true, autoMode: "auto" }, "moderate"))).toBe(false)
    expect(isUltracodeActive(team({ enabled: true, autoMode: "auto" }))).toBe(false)
  })

  it("defaults autoMode to auto when omitted", () => {
    expect(isUltracodeActive(team({ enabled: true }, "complex"))).toBe(true)
    expect(isUltracodeActive(team({ enabled: true }, "simple"))).toBe(false)
  })
})
