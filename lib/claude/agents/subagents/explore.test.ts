import { exploreAgent } from "./explore"
import { readOnlyBuiltinToolNames } from "@/lib/settings/builtin-tools"

// Isolate the dispatchable-subagents resolver from the plugin registry + the
// zustand template store so this test only exercises the built-in registration.
jest.mock("@/lib/plugin/registries/subagent-registry", () => ({
  listSubagentEntries: () => [],
}))
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: { getState: () => ({ templates: {} }) },
}))

describe("exploreAgent", () => {
  it("is a read-only scout scoped to the derived read-only tool surface", () => {
    expect(exploreAgent.tools).toEqual(readOnlyBuiltinToolNames())
    // No approval-required (mutating) tools may be present.
    expect(exploreAgent.tools?.every((t) => t.startsWith("mcp__cognia-tools__"))).toBe(true)
    expect(exploreAgent.description.toLowerCase()).toContain("read-only")
    expect(exploreAgent.prompt).toContain("Explore")
  })

  it("is registered as a dispatchable subagent under the id 'Explore' (and 'Plan')", () => {
    const { resolveDispatchableSubagents } = jest.requireActual<typeof import("./index")>("./index")
    const ids = resolveDispatchableSubagents().map((s) => s.id)
    expect(ids).toContain("Explore")
    expect(ids).toContain("Plan")
  })
})
