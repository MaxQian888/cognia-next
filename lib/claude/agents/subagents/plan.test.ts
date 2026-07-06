import { planAgent } from "./plan"
import { readOnlyBuiltinToolNames } from "@/lib/settings/builtin-tools"

describe("planAgent", () => {
  it("is a read-only architect scoped to the derived read-only tool surface", () => {
    expect(planAgent.tools).toEqual(readOnlyBuiltinToolNames())
    expect(planAgent.tools?.every((t) => t.startsWith("mcp__cognia-tools__"))).toBe(true)
    expect(planAgent.description.toLowerCase()).toContain("read-only")
    // It drafts a step-by-step plan grounded in real files.
    expect(planAgent.prompt.toLowerCase()).toContain("step-by-step")
  })
})
