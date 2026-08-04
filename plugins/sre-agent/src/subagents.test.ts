import { sreSubagentRuntimeId } from "./ids"
import { SRE_DISALLOWED_TOOLS, SRE_SUBAGENTS, SRE_SYSTEM_PROMPT } from "./subagents"
import { SRE_TOOL_NAMES } from "./tools"

describe("SRE subagent definition", () => {
  it("defines the namespaced runtime id helper", () => {
    expect(sreSubagentRuntimeId()).toBe("sre-agent:incident-diagnostician")
  })

  it("exposes one read-only incident diagnostician", () => {
    expect(SRE_SUBAGENTS).toHaveLength(1)
    expect(SRE_SUBAGENTS[0]).toMatchObject({
      id: "incident-diagnostician",
      name: "SRE Incident Diagnostician",
      effort: "high",
      maxTurns: 15,
      tools: [...SRE_TOOL_NAMES],
    })
  })

  it("requires evidence-backed timelines and validator use", () => {
    expect(SRE_SYSTEM_PROMPT).toContain("call-chain timeline table")
    expect(SRE_SYSTEM_PROMPT).toContain("Every timeline row must cite")
    expect(SRE_SYSTEM_PROMPT).toContain("sre_validate_timeline")
  })

  it("keeps production mutation tools disallowed", () => {
    expect(SRE_DISALLOWED_TOOLS).toEqual(
      expect.arrayContaining(["restart_service", "rollback_deployment", "scale_service"])
    )
    expect(SRE_SUBAGENTS[0].disallowedTools).toEqual([...SRE_DISALLOWED_TOOLS])
  })
})
