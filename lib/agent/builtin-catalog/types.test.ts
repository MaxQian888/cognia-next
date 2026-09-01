import { builtinAgents, resolveBuiltinToolPolicy } from "./catalog"
import type { BuiltinAgentSurface, BuiltinToolPolicy } from "./types"

/**
 * The surface vocabulary is a contract between the catalog and four call sites
 * (the workflow-editor and team agents maps, the `dispatch_agent` targets, and
 * the CLI's discovery). Listing it exhaustively here means adding a fifth is a
 * deliberate edit rather than a silent widening.
 */
const ALL_SURFACES: readonly BuiltinAgentSurface[] = ["workflow-editor", "team", "dispatch", "cli"]

describe("BuiltinAgentSurface", () => {
  it("is the closed set the projections know how to serve", () => {
    expect(ALL_SURFACES).toHaveLength(4)
  })

  it("is the only vocabulary the shipped entries use", () => {
    for (const entry of builtinAgents()) {
      for (const surface of entry.surfaces) {
        expect(ALL_SURFACES).toContain(surface)
      }
    }
  })
})

describe("BuiltinToolPolicy", () => {
  // Exhaustiveness matters more than the values: a policy the resolver does not
  // handle would fall through and silently grant the parent's whole toolset to
  // an agent meant to be clamped.
  const ALL_POLICIES: readonly BuiltinToolPolicy[] = [
    { kind: "inherit" },
    { kind: "read-only" },
    { kind: "allowlist", tools: ["x"] },
  ]

  it("is resolved for every variant, with only inherit answering undefined", () => {
    const resolved = ALL_POLICIES.map(resolveBuiltinToolPolicy)
    expect(resolved[0]).toBeUndefined()
    expect(resolved[1]).toBeDefined()
    expect(resolved[2]).toEqual(["x"])
  })

  it("is the only vocabulary the shipped entries use", () => {
    for (const entry of builtinAgents()) {
      expect(ALL_POLICIES.map((p) => p.kind)).toContain(entry.toolPolicy.kind)
    }
  })
})
