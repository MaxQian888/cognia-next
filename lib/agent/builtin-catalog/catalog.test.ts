import {
  BUILTIN_AGENT_IDS,
  builtinAgentById,
  builtinAgentDefinition,
  builtinAgents,
  builtinAgentsForSurface,
  resolveBuiltinToolPolicy,
  CODE_REVIEWER_AGENT_ID,
  EXPLORE_AGENT_ID,
  GENERAL_PURPOSE_AGENT_ID,
  PLAN_AGENT_ID,
} from "./catalog"
import { isNamedAgentColor, normalizeAgentColor } from "@/lib/claude/agents/agent-color"
import { SUBAGENT_CONTRACT_TAG } from "@/lib/agent/prompts/subagent-frame"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

describe("the built-in catalog", () => {
  it("lets every built-in inherit the unified execution budget", () => {
    for (const entry of builtinAgents()) {
      expect(entry.maxTurns).toBeUndefined()
      expect(builtinAgentDefinition(entry).maxTurns).toBeUndefined()
    }
  })
  it("ships one entry per id, with no duplicates", () => {
    expect(new Set(BUILTIN_AGENT_IDS).size).toBe(BUILTIN_AGENT_IDS.length)
    expect(BUILTIN_AGENT_IDS).toEqual(builtinAgents().map((entry) => entry.id))
  })

  it("gives every entry a description and a prompt the dispatcher can read", () => {
    for (const entry of builtinAgents()) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.identity.defaultBody.length).toBeGreaterThan(20)
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

describe("code-reviewer", () => {
  it("is a read-only dispatch-and-CLI agent, never a session agent", () => {
    const entry = builtinAgentById(CODE_REVIEWER_AGENT_ID)!
    expect(entry.toolPolicy).toEqual({ kind: "read-only" })
    expect(builtinAgentsForSurface("dispatch").map((e) => e.id)).toContain(CODE_REVIEWER_AGENT_ID)
    expect(builtinAgentsForSurface("cli").map((e) => e.id)).toContain(CODE_REVIEWER_AGENT_ID)
    expect(builtinAgentsForSurface("team").map((e) => e.id)).not.toContain(CODE_REVIEWER_AGENT_ID)
    expect(builtinAgentsForSurface("workflow-editor").map((e) => e.id)).not.toContain(
      CODE_REVIEWER_AGENT_ID
    )
    expect(builtinAgentDefinition(entry).tools).toBeDefined()
  })

  it("asks for severity-ordered, confirmed findings and refuses praise", () => {
    const prompt = builtinAgentById(CODE_REVIEWER_AGENT_ID)!.identity.defaultBody
    for (const phrase of ["severity", "file:line", "smallest fix", "No praise", "read-only"]) {
      expect(prompt).toContain(phrase)
    }
  })
})

describe("prompt hygiene", () => {
  // The runtime frames every dispatched child with the shared contract, so the
  // catalog prompts must not restate it (it would drift, and it is wrong for a
  // nesting-enabled child).
  it("never restates the dispatched-subagent contract", () => {
    for (const entry of builtinAgents()) {
      expect(entry.identity.defaultBody).not.toContain(`<${SUBAGENT_CONTRACT_TAG}>`)
      expect(entry.identity.defaultBody).not.toMatch(/cannot dispatch (further )?subagents/i)
      expect(entry.identity.defaultBody).not.toMatch(/final message is the ONLY/i)
      expect(entry.identity.defaultBody).not.toMatch(/follow-up questions/i)
    }
  })

  it("gives the non-workflow built-ins a palette colour that the definition projects", () => {
    for (const id of [
      GENERAL_PURPOSE_AGENT_ID,
      EXPLORE_AGENT_ID,
      PLAN_AGENT_ID,
      CODE_REVIEWER_AGENT_ID,
    ]) {
      const entry = builtinAgentById(id)!
      const color = normalizeAgentColor(entry.color)
      if (!color) throw new Error("Expected builtin agent color")
      expect(color).toBe(entry.color)
      expect(isNamedAgentColor(color)).toBe(true)
      expect(builtinAgentDefinition(entry).color).toBe(entry.color)
    }
    const colours = [
      GENERAL_PURPOSE_AGENT_ID,
      EXPLORE_AGENT_ID,
      PLAN_AGENT_ID,
      CODE_REVIEWER_AGENT_ID,
    ].map((id) => builtinAgentById(id)!.color)
    expect(new Set(colours).size).toBe(colours.length)
  })
})

describe("customized built-in identities (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("gives every built-in its own editable identity slot", () => {
    const ids = builtinAgents().map((entry) => entry.identity.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of builtinAgents()) {
      expect(entry.identity.id).toBe(`agent.builtin.${entry.id}.identity`)
      expect(entry.identity.kind).toBe("role")
    }
  })

  it("projects the customized identity and keeps the entry's tool policy", () => {
    const explore = builtinAgentById(EXPLORE_AGENT_ID)!
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: explore.identity.id,
          scope: "account",
          targetId: "",
          revisionId: "por",
          body: "You are a terse scout. Report paths only.",
          contractVersion: explore.identity.contractVersion,
        },
      ])
    )
    const def = builtinAgentDefinition(explore)
    expect(def.prompt).toBe("You are a terse scout. Report paths only.")
    expect(def.tools).toEqual(resolveBuiltinToolPolicy(explore.toolPolicy))
  })
})
