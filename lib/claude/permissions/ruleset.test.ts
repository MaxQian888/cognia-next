import {
  resolvePermission,
  matchGlob,
  mergeRulesets,
  DEFAULT_RULESET,
  type Ruleset,
} from "./ruleset"

describe("matchGlob", () => {
  it("matches * within a segment but not across separators", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true)
    expect(matchGlob("src/*.ts", "src/deep/a.ts")).toBe(false)
  })

  it("matches ** across separators", () => {
    expect(matchGlob("src/**/*.ts", "src/deep/nested/a.ts")).toBe(true)
    expect(matchGlob("**/*.env", "/proj/config/.env")).toBe(true)
  })

  it("matches a slashless glob against the basename", () => {
    expect(matchGlob("*.env", "/proj/.env")).toBe(true)
    expect(matchGlob("*.env", "/proj/app.env")).toBe(true)
    expect(matchGlob("*.env", "/proj/env.ts")).toBe(false)
  })

  it("matches ? as a single non-separator char", () => {
    expect(matchGlob("a?.ts", "ab.ts")).toBe(true)
    expect(matchGlob("a?.ts", "a/.ts")).toBe(false)
  })
})

describe("resolvePermission", () => {
  it("defaults to allow for unconstrained tools", () => {
    expect(resolvePermission("Bash", "ls", [])).toBe("allow")
    expect(resolvePermission("Read", "/proj/a.ts", [], { cwd: "/proj" })).toBe("allow")
  })

  it("gates env files behind a prompt via the default ruleset", () => {
    expect(resolvePermission("Edit", "/proj/.env", [], { cwd: "/proj" })).toBe("ask")
    expect(resolvePermission("Write", "/proj/app.env.local", [], { cwd: "/proj" })).toBe("ask")
  })

  it("lets a higher-precedence ruleset override the default", () => {
    const user: Ruleset = { Edit: { "**/*.env": "allow" } }
    expect(resolvePermission("Edit", "/proj/.env", [user], { cwd: "/proj" })).toBe("allow")
  })

  it("applies deny from a user ruleset", () => {
    const user: Ruleset = { Bash: "deny" }
    expect(resolvePermission("Bash", "rm -rf /", [user])).toBe("deny")
  })

  it("prefers a tool-specific rule over the wildcard tool in the same layer", () => {
    const rs: Ruleset = { "*": "deny", Read: "allow" }
    expect(resolvePermission("Read", "/proj/a.ts", [rs])).toBe("allow")
    expect(resolvePermission("Bash", "ls", [rs])).toBe("deny")
  })

  it("prefers a more specific glob within the same tool", () => {
    const rs: Ruleset = { Edit: { "**/*": "allow", "**/secret/**": "deny" } }
    expect(resolvePermission("Edit", "/proj/secret/key.ts", [rs])).toBe("deny")
    expect(resolvePermission("Edit", "/proj/src/a.ts", [rs])).toBe("allow")
  })

  it("escalates a default-allow to ask for paths outside the workspace", () => {
    expect(resolvePermission("Edit", "/etc/hosts", [], { cwd: "/proj" })).toBe("ask")
    expect(resolvePermission("Edit", "/proj/src/a.ts", [], { cwd: "/proj" })).toBe("allow")
  })

  it("respects an explicit allow for an external path", () => {
    const user: Ruleset = { Edit: { "/tmp/**": "allow" } }
    expect(resolvePermission("Edit", "/tmp/scratch.ts", [user], { cwd: "/proj" })).toBe("allow")
  })

  it("does not escalate non-absolute targets", () => {
    expect(resolvePermission("Bash", "git status", [], { cwd: "/proj" })).toBe("allow")
  })

  it("later rulesets win over earlier ones", () => {
    const a: Ruleset = { Bash: "deny" }
    const b: Ruleset = { Bash: "allow" }
    expect(resolvePermission("Bash", "ls", [a, b])).toBe("allow")
  })

  it("DEFAULT_RULESET allows everything by default", () => {
    expect(DEFAULT_RULESET["*"]).toBe("allow")
  })
})

describe("mergeRulesets", () => {
  it("merges per-tool glob maps with later winning", () => {
    const merged = mergeRulesets({ Edit: { "a/**": "deny" } }, { Edit: { "b/**": "allow" } })
    expect(merged.Edit).toEqual({ "a/**": "deny", "b/**": "allow" })
  })

  it("a flat verdict replaces a prior map and vice versa", () => {
    expect(mergeRulesets({ Bash: { "*": "deny" } }, { Bash: "allow" }).Bash).toBe("allow")
    expect(mergeRulesets({ Bash: "allow" }, { Bash: { "rm*": "deny" } }).Bash).toEqual({
      "rm*": "deny",
    })
  })

  it("skips nullish inputs", () => {
    expect(mergeRulesets(undefined, null, { Read: "allow" })).toEqual({ Read: "allow" })
  })
})
