import {
  resolveSubagentDispatchVerdict,
  isSubagentDispatchAllowed,
} from "./subagent-dispatch-policy"

describe("resolveSubagentDispatchVerdict", () => {
  it("allows everything when no rules are configured", () => {
    expect(resolveSubagentDispatchVerdict(undefined, "Explore")).toBe("allow")
    expect(resolveSubagentDispatchVerdict({}, "Explore")).toBe("allow")
  })

  it("denies an explicitly denied id", () => {
    expect(resolveSubagentDispatchVerdict({ Explore: "deny" }, "Explore")).toBe("deny")
  })

  it("matches globs over projected ids", () => {
    const rules = { "template:*": "deny" as const }
    expect(resolveSubagentDispatchVerdict(rules, "template:my-agent")).toBe("deny")
    expect(resolveSubagentDispatchVerdict(rules, "Explore")).toBe("allow")
  })

  it("most-specific match wins (allow carve-out under a broad deny)", () => {
    const rules = { "myplugin:*": "deny" as const, "myplugin:reviewer": "allow" as const }
    expect(resolveSubagentDispatchVerdict(rules, "myplugin:reviewer")).toBe("allow")
    expect(resolveSubagentDispatchVerdict(rules, "myplugin:other")).toBe("deny")
  })

  it("treats the reserved `ask` verdict as allow in v1", () => {
    expect(resolveSubagentDispatchVerdict({ Explore: "ask" }, "Explore")).toBe("allow")
  })

  it("defaults to allow when no rule matches", () => {
    expect(resolveSubagentDispatchVerdict({ "other:*": "deny" }, "Explore")).toBe("allow")
  })

  it("isSubagentDispatchAllowed is the boolean convenience", () => {
    expect(isSubagentDispatchAllowed({ Explore: "deny" }, "Explore")).toBe(false)
    expect(isSubagentDispatchAllowed({ Explore: "deny" }, "Plan")).toBe(true)
  })
})
