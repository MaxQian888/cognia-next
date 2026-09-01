import {
  BUILTIN_AGENT_IDS,
  builtinAgentById,
  builtinAgentDefinition,
  builtinAgents,
  builtinAgentsForSurface,
  resolveBuiltinToolPolicy,
  EXPLORE_AGENT_ID,
  GENERAL_PURPOSE_AGENT_ID,
  PLAN_AGENT_ID,
} from "./catalog"

describe("the built-in catalog", () => {
  it("ships one entry per id, with no duplicates", () => {
    expect(new Set(BUILTIN_AGENT_IDS).size).toBe(BUILTIN_AGENT_IDS.length)
    expect(BUILTIN_AGENT_IDS).toEqual(builtinAgents().map((entry) => entry.id))
  })

  it("gives every entry a description and a prompt the dispatcher can read", () => {
    for (const entry of builtinAgents()) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.prompt.length).toBeGreaterThan(20)
      expect(entry.surfaces.length).toBeGreaterThan(0)
    }
  })

  it("resolves one entry by id and nothing for an unknown one", () => {
    expect(builtinAgentById(EXPLORE_AGENT_ID)?.name).toBe("Explore")
    expect(builtinAgentById("nope")).toBeUndefined()
  })
})

describe("surfaces", () => {
  it("offers the read-only pair to dispatch and to the CLI", () => {
    const dispatch = builtinAgentsForSurface("dispatch").map((e) => e.id)
    const cli = builtinAgentsForSurface("cli").map((e) => e.id)
    expect(dispatch).toEqual(expect.arrayContaining([EXPLORE_AGENT_ID, PLAN_AGENT_ID]))
    expect(cli).toEqual(expect.arrayContaining([EXPLORE_AGENT_ID, PLAN_AGENT_ID]))
  })

  // A general delegate on every chat turn is a behaviour change of its own, and
  // `dispatch` is context-free, so general-purpose stays off it deliberately.
  it("keeps general-purpose off the context-free dispatch surface", () => {
    expect(builtinAgentsForSurface("dispatch").map((e) => e.id)).not.toContain(
      GENERAL_PURPOSE_AGENT_ID
    )
    expect(builtinAgentsForSurface("cli").map((e) => e.id)).toContain(GENERAL_PURPOSE_AGENT_ID)
    expect(builtinAgentsForSurface("team").map((e) => e.id)).toContain(GENERAL_PURPOSE_AGENT_ID)
  })

  it("keeps the four workflow agents on the workflow-editor surface", () => {
    expect(builtinAgentsForSurface("workflow-editor").map((e) => e.id)).toEqual([
      "workflow-designer",
      "workflow-debugger",
      "workflow-refactorer",
      "workflow-doc-writer",
    ])
  })

  it("never offers a workflow agent to the CLI", () => {
    expect(builtinAgentsForSurface("cli").map((e) => e.id)).not.toEqual(
      expect.arrayContaining(["workflow-designer"])
    )
  })
})

describe("tool policy", () => {
  it("inherits by resolving to no allowlist at all", () => {
    expect(resolveBuiltinToolPolicy({ kind: "inherit" })).toBeUndefined()
  })

  it("derives the read-only surface rather than hand-keeping it", () => {
    const tools = resolveBuiltinToolPolicy({ kind: "read-only" }) ?? []
    expect(tools.length).toBeGreaterThan(5)
    // Derived from the shared risk model, so a newly added read-only tool joins
    // on its own. What must never join is a mutating one. (`bash_output` reads a
    // running task's output and is correctly in the set, which is why this names
    // exact tools rather than matching on a substring.)
    for (const mutating of ["bash", "write", "edit", "terminal_repl_spawn"]) {
      expect(tools).not.toContain(`mcp__cognia-tools__${mutating}`)
    }
  })

  it("passes an explicit allowlist through as its own copy", () => {
    const tools = ["a", "b"]
    const resolved = resolveBuiltinToolPolicy({ kind: "allowlist", tools })
    expect(resolved).toEqual(tools)
    expect(resolved).not.toBe(tools)
  })

  it("clamps the read-only agents and leaves general-purpose unclamped", () => {
    expect(builtinAgentDefinition(builtinAgentById(EXPLORE_AGENT_ID)!).tools).toBeDefined()
    expect(builtinAgentDefinition(builtinAgentById(PLAN_AGENT_ID)!).tools).toBeDefined()
    expect(
      builtinAgentDefinition(builtinAgentById(GENERAL_PURPOSE_AGENT_ID)!).tools
    ).toBeUndefined()
  })
})
