/**
 * @jest-environment node
 */
import {
  BUILTIN_AGENT_IDS,
  EXPLORE_AGENT_ID,
  GENERAL_PURPOSE_AGENT_ID,
  PLAN_AGENT_ID,
  exploreAgent,
  generalPurposeAgent,
  planAgent,
  withBuiltinAgents,
} from "./builtin-agents"
import { READ_ONLY_BUILTIN_TOOLS } from "./tool-suppression"
import type { AgentSummary } from "./discover-agents"

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    description: `${id} agent`,
    def: { id, name: id, description: `${id} agent`, prompt: `${id} prompt` },
  }
}

describe("generalPurposeAgent", () => {
  it("is an always-dispatchable leaf that inherits the parent's model and tools", () => {
    const a = generalPurposeAgent()
    expect(a.id).toBe(GENERAL_PURPOSE_AGENT_ID)
    expect(a.name).toBe(GENERAL_PURPOSE_AGENT_ID)
    expect(a.description.trim().length).toBeGreaterThan(0)
    expect(a.def.id).toBe(GENERAL_PURPOSE_AGENT_ID)
    expect(a.def.prompt.trim().length).toBeGreaterThan(0)
    // No model override → buildChildConfig inherits the active provider's model.
    expect(a.def.model).toBeUndefined()
    // No tool allowlist → inherits the parent's full toolset.
    expect(a.def.tools).toBeUndefined()
  })

  it("is the canonical built-in", () => {
    expect(BUILTIN_AGENT_IDS).toContain(GENERAL_PURPOSE_AGENT_ID)
  })
})

describe("exploreAgent / planAgent", () => {
  it("Explore is a read-only leaf whitelisted to the read-only tool surface", () => {
    const a = exploreAgent()
    expect(a.id).toBe(EXPLORE_AGENT_ID)
    expect(a.def.prompt.trim().length).toBeGreaterThan(0)
    // A non-empty allowlist locked to the read-only surface — no mutating tools.
    expect(a.def.tools).toEqual([...READ_ONLY_BUILTIN_TOOLS])
    expect(a.def.tools?.length).toBeGreaterThan(0)
    // The concrete mutating tools never appear in the read-only allowlist.
    const mutating = [
      "write",
      "edit",
      "multi_edit",
      "bash",
      "shell_execute_advanced",
      "file_append",
    ].map((n) => `mcp__cognia-tools__${n}`)
    for (const name of mutating) expect(a.def.tools).not.toContain(name)
  })

  it("Plan is a read-only leaf whitelisted to the read-only tool surface", () => {
    const a = planAgent()
    expect(a.id).toBe(PLAN_AGENT_ID)
    expect(a.def.prompt.trim().length).toBeGreaterThan(0)
    expect(a.def.tools).toEqual([...READ_ONLY_BUILTIN_TOOLS])
  })

  it("both are canonical built-ins", () => {
    expect(BUILTIN_AGENT_IDS).toContain(EXPLORE_AGENT_ID)
    expect(BUILTIN_AGENT_IDS).toContain(PLAN_AGENT_ID)
  })
})

describe("withBuiltinAgents", () => {
  it("appends the built-in general-purpose agent when nothing is discovered", () => {
    const merged = withBuiltinAgents([])
    expect(merged.map((a) => a.id)).toContain(GENERAL_PURPOSE_AGENT_ID)
  })

  it("keeps discovered agents and appends built-ins with distinct ids", () => {
    const merged = withBuiltinAgents([agent("reviewer")])
    expect(merged.map((a) => a.id)).toEqual([
      "reviewer",
      GENERAL_PURPOSE_AGENT_ID,
      EXPLORE_AGENT_ID,
      PLAN_AGENT_ID,
    ])
  })

  it("lets a user-authored agent override a built-in of the same id", () => {
    const custom = agent(GENERAL_PURPOSE_AGENT_ID)
    const merged = withBuiltinAgents([custom])
    const ids = merged.map((a) => a.id)
    // Only ONE general-purpose entry, and it is the user's.
    expect(ids.filter((id) => id === GENERAL_PURPOSE_AGENT_ID)).toHaveLength(1)
    expect(merged.find((a) => a.id === GENERAL_PURPOSE_AGENT_ID)).toBe(custom)
  })

  it("does not mutate the input array", () => {
    const input: AgentSummary[] = []
    withBuiltinAgents(input)
    expect(input).toHaveLength(0)
  })
})
