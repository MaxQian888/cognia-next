/**
 * @jest-environment node
 */
import {
  CLI_AUTO_APPROVED_TOOLS,
  withCliAutoApprovedTools,
  withCliDisabledMcpTools,
} from "./tool-suppression"
import type { SendOptions } from "@/lib/claude/types"

describe("withCliAutoApprovedTools", () => {
  it("merges the full auto-approve set, preserving existing suppressions + extras", () => {
    const out = withCliAutoApprovedTools(
      { suppressApprovalForTools: ["pre-existing"] } as unknown as SendOptions,
      ["mcp__cognia-tools__bash"]
    )
    expect(out.suppressApprovalForTools).toContain("pre-existing")
    expect(out.suppressApprovalForTools).toContain("mcp__cognia-tools__bash")
    for (const t of CLI_AUTO_APPROVED_TOOLS) {
      expect(out.suppressApprovalForTools).toContain(t)
    }
  })

  it("includes the read-only surface but never mutating tools, and the plan signals", () => {
    const out = withCliAutoApprovedTools({} as SendOptions)
    expect(out.suppressApprovalForTools).toContain("mcp__cognia-tools__read")
    expect(out.suppressApprovalForTools).toContain("mcp__cognia-tools__exit_plan_mode")
    expect(out.suppressApprovalForTools).toContain("ExitPlanMode")
    expect(out.suppressApprovalForTools).not.toContain("mcp__cognia-tools__bash")
  })

  it("dedupes when the same name arrives from multiple sources", () => {
    const out = withCliAutoApprovedTools(
      { suppressApprovalForTools: ["mcp__cognia-tools__read"] } as unknown as SendOptions,
      ["mcp__cognia-tools__read"]
    )
    const count = out.suppressApprovalForTools!.filter(
      (t) => t === "mcp__cognia-tools__read"
    ).length
    expect(count).toBe(1)
  })
})

describe("withCliDisabledMcpTools", () => {
  it("returns the options unchanged when the overlay is empty", () => {
    const opts = { disallowedTools: ["x"] } as unknown as SendOptions
    expect(withCliDisabledMcpTools(opts, [])).toBe(opts)
  })

  it("unions the disabled overlay into disallowedTools, deduped, preserving existing", () => {
    const out = withCliDisabledMcpTools(
      { disallowedTools: ["mcp__s__a"] } as unknown as SendOptions,
      ["mcp__s__a", "mcp__s__b"]
    )
    expect(out.disallowedTools).toEqual(["mcp__s__a", "mcp__s__b"])
  })

  it("handles options with no prior disallowedTools", () => {
    const out = withCliDisabledMcpTools({} as SendOptions, ["mcp__s__b"])
    expect(out.disallowedTools).toEqual(["mcp__s__b"])
  })
})
