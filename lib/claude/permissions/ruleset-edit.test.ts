import { setToolRule, removeToolRule, listRules, deterministicRulesetSort } from "./ruleset-edit"
import type { Ruleset } from "./ruleset"

describe("setToolRule", () => {
  it("adds a rule to an empty ruleset", () => {
    expect(setToolRule(undefined, "Bash", "git *", "allow")).toEqual({
      Bash: { "git *": "allow" },
    })
  })

  it("updates an existing pattern and keeps siblings", () => {
    const rs: Ruleset = { Bash: { "git *": "allow", "rm *": "deny" } }
    expect(setToolRule(rs, "Bash", "git *", "ask")).toEqual({
      Bash: { "git *": "ask", "rm *": "deny" },
    })
    // input untouched (pure)
    expect(rs.Bash).toEqual({ "git *": "allow", "rm *": "deny" })
  })

  it("preserves a flat verdict entry as a * rule", () => {
    const rs: Ruleset = { grep: "allow" }
    expect(setToolRule(rs, "grep", "src/**", "ask")).toEqual({
      grep: { "*": "allow", "src/**": "ask" },
    })
  })
})

describe("removeToolRule", () => {
  it("removes a pattern and drops the tool key when empty", () => {
    const rs: Ruleset = { Bash: { "git *": "allow" } }
    expect(removeToolRule(rs, "Bash", "git *")).toEqual({})
  })

  it("keeps remaining patterns", () => {
    const rs: Ruleset = { Bash: { "git *": "allow", "rm *": "deny" } }
    expect(removeToolRule(rs, "Bash", "rm *")).toEqual({ Bash: { "git *": "allow" } })
  })

  it("is a no-op for missing tools or flat entries", () => {
    expect(removeToolRule(undefined, "Bash", "x")).toEqual({})
    expect(removeToolRule({ Bash: "allow" }, "Bash", "x")).toEqual({ Bash: "allow" })
  })
})

describe("listRules", () => {
  it("flattens and sorts rows, expanding flat verdicts to *", () => {
    const rs: Ruleset = {
      write: "deny",
      Bash: { "rm *": "deny", "git *": "allow" },
    }
    expect(listRules(rs)).toEqual([
      { tool: "Bash", pattern: "git *", verdict: "allow" },
      { tool: "Bash", pattern: "rm *", verdict: "deny" },
      { tool: "write", pattern: "*", verdict: "deny" },
    ])
  })

  it("returns [] for undefined", () => {
    expect(listRules(undefined)).toEqual([])
  })
})

describe("deterministicRulesetSort", () => {
  it("sorts tool keys and glob keys so serialization is byte-stable", () => {
    const a: Ruleset = { b: { z: "ask", a: "allow" }, a: "deny" }
    const b: Ruleset = { a: "deny", b: { a: "allow", z: "ask" } }
    expect(JSON.stringify(deterministicRulesetSort(a))).toBe(
      JSON.stringify(deterministicRulesetSort(b))
    )
    expect(Object.keys(deterministicRulesetSort(a))).toEqual(["a", "b"])
  })
})
