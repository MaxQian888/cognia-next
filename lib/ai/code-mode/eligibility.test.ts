import {
  checkToolEligibility,
  divergesFromApprovalFlag,
  isProgrammaticReadOnly,
  programmaticReadOnlyToolNames,
  programmaticReadOnlyTools,
} from "./eligibility"
import { BUILTIN_TOOL_CATEGORIES, namespaced } from "@/lib/settings/builtin-tools"

const ALL_TOOLS = BUILTIN_TOOL_CATEGORIES.flatMap((category) => category.tools)

describe("programmaticReadOnlyTools", () => {
  it("returns only tools the metadata explicitly flags", () => {
    for (const tool of programmaticReadOnlyTools()) {
      const meta = ALL_TOOLS.find((candidate) => candidate.name === tool.name)
      expect(meta?.programmaticReadOnly).toBe(true)
    }
  })

  it("carries the namespaced name the registry is keyed by", () => {
    const read = programmaticReadOnlyTools().find((tool) => tool.name === "read")
    expect(read?.namespacedName).toBe(namespaced("read"))
  })

  it("is non-empty", () => {
    expect(programmaticReadOnlyToolNames().length).toBeGreaterThan(0)
  })
})

describe("the allowlist boundary", () => {
  it("excludes state-mutating tools that happen to skip the approval prompt", () => {
    // The exact reason eligibility is a separate flag: all four of these carry
    // `requiresApproval: false` and all four change state.
    for (const name of ["TodoWrite", "TaskCreate", "TaskUpdate", "monitor_cancel"]) {
      expect(isProgrammaticReadOnly(name)).toBe(false)
    }
  })

  it("excludes the environment readers", () => {
    expect(isProgrammaticReadOnly("list_env")).toBe(false)
    expect(isProgrammaticReadOnly("get_env")).toBe(false)
  })

  it("includes the read and search surface", () => {
    for (const name of ["read", "grep", "glob", "ls", "file_hash"]) {
      expect(isProgrammaticReadOnly(name)).toBe(true)
    }
  })

  it("never marks a tool that requires approval as eligible", () => {
    for (const name of programmaticReadOnlyToolNames()) {
      const meta = ALL_TOOLS.find((candidate) => candidate.name === name)
      expect(meta?.requiresApproval).toBe(false)
    }
  })
})

describe("divergesFromApprovalFlag", () => {
  // A regression guard rather than a feature: if this list empties out, someone
  // has redefined eligibility as "does not require approval".
  it("is non-empty, proving eligibility is not derived from the approval flag", () => {
    expect(divergesFromApprovalFlag().length).toBeGreaterThan(0)
  })

  it("contains the mutating-but-unprompted tools", () => {
    expect(divergesFromApprovalFlag()).toEqual(expect.arrayContaining(["TodoWrite"]))
  })
})

describe("checkToolEligibility", () => {
  it("allows an eligible tool and reports its namespaced name", () => {
    expect(checkToolEligibility("read")).toEqual({
      allowed: true,
      namespacedName: namespaced("read"),
    })
  })

  it("distinguishes ineligible from unknown", () => {
    expect(checkToolEligibility("TodoWrite")).toEqual({
      allowed: false,
      reason: "not-programmatic-read-only",
    })
    expect(checkToolEligibility("definitely_not_a_tool")).toEqual({
      allowed: false,
      reason: "unknown-tool",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(checkToolEligibility("  read  ").allowed).toBe(true)
  })

  it("is case sensitive", () => {
    expect(checkToolEligibility("Read").allowed).toBe(false)
  })

  it("rejects an empty name", () => {
    expect(checkToolEligibility("   ")).toEqual({ allowed: false, reason: "unknown-tool" })
  })
})
