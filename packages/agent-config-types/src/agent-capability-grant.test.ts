import {
  AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
  applyCapabilityIdDelta,
  capPermissionModeByGrant,
  filterSubagentsByGrant,
  foldCapabilityGrants,
  mergeCapabilityGrants,
  subagentKeyMatches,
  validateAgentCapabilityGrant,
} from "./agent-capability-grant"
import type { AgentCapabilityGrantV1 } from "./agent-capability-grant"

function grant(fields: Partial<AgentCapabilityGrantV1> = {}): AgentCapabilityGrantV1 {
  return {
    schemaVersion: AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
    source: { kind: "scheduler", id: "task-1" },
    ...fields,
  }
}

describe("validateAgentCapabilityGrant", () => {
  it("accepts a fully populated grant", () => {
    const result = validateAgentCapabilityGrant(
      grant({
        model: "sonnet",
        provider: "anthropic",
        effort: "high",
        maxTurns: 12,
        instructions: ["Write in French."],
        skills: { add: ["report"], remove: ["chit-chat"] },
        mcpServers: { only: ["github"], add: ["linear"], remove: ["slack"] },
        tools: { add: ["Read"], deny: ["Bash"], restrictTo: ["Read", "Grep"] },
        knowledgeBases: { add: ["kb-1"] },
        subagents: { only: ["workflow-designer"] },
        permissionMode: "plan",
      })
    )
    expect(result.ok).toBe(true)
  })

  it("rejects a malformed subagent restriction", () => {
    const result = validateAgentCapabilityGrant({
      ...grant(),
      subagents: { only: [""], add: ["x"] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "subagents.add is not a recognised field",
          "subagents.only must be an array of non-empty strings",
        ])
      )
    }
  })

  it("rejects a non-object, a wrong version and an unknown source", () => {
    expect(validateAgentCapabilityGrant(null)).toEqual({
      ok: false,
      errors: ["grant must be an object"],
    })
    const result = validateAgentCapabilityGrant({ schemaVersion: 2, source: { kind: "nope" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "schemaVersion must be 1",
          expect.stringContaining("source.kind must be one of"),
        ])
      )
    }
  })

  it("rejects malformed scalars, id lists, unknown delta keys and permission modes", () => {
    const result = validateAgentCapabilityGrant({
      schemaVersion: 1,
      source: { kind: "plugin", id: 7 },
      model: "  ",
      effort: "extreme",
      maxTurns: 101,
      instructions: [""],
      skills: { add: "report" },
      tools: { allow: ["Read"] },
      mcpServers: [],
      permissionMode: "root",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "source.id must be a string",
          "model must be a non-empty string",
          expect.stringContaining("effort must be one of"),
          "maxTurns must be an integer between 1 and 100",
          "instructions must be an array of non-empty strings",
          "skills.add must be an array of non-empty strings",
          "tools.allow is not a recognised field",
          "mcpServers must be an object",
          "permissionMode must be a known permission mode",
        ])
      )
    }
  })
})

describe("applyCapabilityIdDelta", () => {
  it("adds, de-duplicates and lets remove win over add", () => {
    expect(
      applyCapabilityIdDelta(["a", "b"], { add: ["b", "c", "d"], remove: ["a", "d"] })
    ).toEqual(["b", "c"])
  })

  it("returns a de-duplicated copy when there is no delta", () => {
    expect(applyCapabilityIdDelta(["a", "a"], undefined)).toEqual(["a"])
  })
})

describe("mergeCapabilityGrants", () => {
  it("takes inner scalars and the inner source, and concatenates instructions", () => {
    const merged = mergeCapabilityGrants(
      grant({ model: "haiku", effort: "low", maxTurns: 3, instructions: ["outer"] }),
      grant({ source: { kind: "bot", id: "b" }, model: "sonnet", instructions: ["inner"] })
    )
    expect(merged).toMatchObject({
      source: { kind: "bot", id: "b" },
      model: "sonnet",
      effort: "low",
      maxTurns: 3,
      instructions: ["outer", "inner"],
    })
  })

  it("composes id deltas in order", () => {
    const merged = mergeCapabilityGrants(
      grant({ skills: { add: ["a", "b"], remove: ["c"] } }),
      grant({ skills: { add: ["c"], remove: ["a"] } })
    )
    expect(merged.skills).toEqual({ add: ["b", "c"], remove: ["a"] })
  })

  it("never lets a later layer re-admit a denied tool", () => {
    const merged = mergeCapabilityGrants(
      grant({ tools: { deny: ["Bash"] } }),
      grant({ tools: { add: ["Bash", "Read"] } })
    )
    expect(merged.tools).toEqual({ add: ["Read"], deny: ["Bash"] })
  })

  it("intersects restrictTo and mcp only lists", () => {
    const merged = mergeCapabilityGrants(
      grant({ tools: { restrictTo: ["Read", "Grep"] }, mcpServers: { only: ["gh", "linear"] } }),
      grant({ tools: { restrictTo: ["Grep", "Bash"] }, mcpServers: { only: ["linear"] } })
    )
    expect(merged.tools?.restrictTo).toEqual(["Grep"])
    expect(merged.mcpServers).toEqual({ only: ["linear"] })
  })

  it("keeps a one-sided restriction and unions knowledge bases", () => {
    const merged = mergeCapabilityGrants(
      grant({ mcpServers: { only: ["gh"] }, knowledgeBases: { add: ["k1"] } }),
      grant({ mcpServers: { add: ["linear"] }, knowledgeBases: { add: ["k1", "k2"] } })
    )
    expect(merged.mcpServers).toEqual({ add: ["linear"], only: ["gh"] })
    expect(merged.knowledgeBases).toEqual({ add: ["k1", "k2"] })
  })

  it("keeps the less privileged permission cap", () => {
    expect(
      mergeCapabilityGrants(
        grant({ permissionMode: "acceptEdits" }),
        grant({ permissionMode: "bypassPermissions" })
      ).permissionMode
    ).toBe("acceptEdits")
    expect(mergeCapabilityGrants(grant(), grant({ permissionMode: "plan" })).permissionMode).toBe(
      "plan"
    )
  })

  it("intersects subagent restrictions and keeps a one-sided one", () => {
    expect(
      mergeCapabilityGrants(
        grant({ subagents: { only: ["a", "b"] } }),
        grant({ subagents: { only: ["b", "c"] } })
      ).subagents
    ).toEqual({ only: ["b"] })
    expect(mergeCapabilityGrants(grant(), grant({ subagents: { only: [] } })).subagents).toEqual({
      only: [],
    })
  })

  it("omits empty sections", () => {
    const merged = mergeCapabilityGrants(grant(), grant())
    expect(Object.keys(merged).sort()).toEqual(["schemaVersion", "source"])
  })
})

describe("foldCapabilityGrants", () => {
  it("returns undefined for no grants and skips nullish entries", () => {
    expect(foldCapabilityGrants(undefined)).toBeUndefined()
    expect(foldCapabilityGrants([null, undefined])).toBeUndefined()
    const only = grant({ model: "x" })
    expect(foldCapabilityGrants([undefined, only])).toBe(only)
  })

  it("folds outermost first", () => {
    const folded = foldCapabilityGrants([
      grant({ model: "a", tools: { deny: ["Bash"] } }),
      grant({ model: "b" }),
      grant({ tools: { add: ["Bash"] } }),
    ])
    expect(folded?.model).toBe("b")
    expect(folded?.tools).toEqual({ deny: ["Bash"] })
  })
})

describe("filterSubagentsByGrant", () => {
  const agents = { "workflow-designer": 1, "acme:reviewer": 2, "template:notes": 3 }

  it("matches exact keys and bare ids of namespaced plugin entries", () => {
    expect(subagentKeyMatches("acme:reviewer", "reviewer")).toBe(true)
    expect(subagentKeyMatches("acme:reviewer", "other:reviewer")).toBe(false)
    expect(
      filterSubagentsByGrant(agents, { subagents: { only: ["reviewer", "workflow-designer"] } })
    ).toEqual({ "workflow-designer": 1, "acme:reviewer": 2 })
  })

  it("drops the map when nothing survives and leaves it alone without a restriction", () => {
    expect(filterSubagentsByGrant(agents, { subagents: { only: [] } })).toBeUndefined()
    expect(filterSubagentsByGrant(agents, { subagents: { only: ["missing"] } })).toBeUndefined()
    expect(filterSubagentsByGrant(agents, undefined)).toBe(agents)
    expect(filterSubagentsByGrant(undefined, { subagents: { only: ["a"] } })).toBeUndefined()
  })
})

describe("capPermissionModeByGrant", () => {
  it("never raises the resolved mode", () => {
    expect(capPermissionModeByGrant("plan", { permissionMode: "bypassPermissions" })).toBe("plan")
    expect(capPermissionModeByGrant("bypassPermissions", { permissionMode: "acceptEdits" })).toBe(
      "acceptEdits"
    )
  })

  it("treats an unresolved mode as the SDK default", () => {
    expect(capPermissionModeByGrant(undefined, { permissionMode: "bypassPermissions" })).toBe(
      "default"
    )
    expect(capPermissionModeByGrant(undefined, { permissionMode: "plan" })).toBe("plan")
  })

  it("leaves the mode alone without a cap", () => {
    expect(capPermissionModeByGrant("acceptEdits", undefined)).toBe("acceptEdits")
    expect(capPermissionModeByGrant(undefined, {})).toBeUndefined()
  })
})
