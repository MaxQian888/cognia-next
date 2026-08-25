import {
  MAX_DENIALS_PER_SESSION,
  MAX_TRACKED_SESSIONS,
  __resetSessionDenialsForTesting,
  applySessionDenials,
  clearSessionDenials,
  countSessionDenials,
  denialRuleset,
  isSessionSaturated,
  rememberDenial,
} from "./session-denials"
import { resolveBashPermission, type Ruleset } from "./ruleset"
// The gate that actually runs: unlike the renderer resolver it prepends no
// `*: allow` default, so "no matching rule" reads as "ask" here.
import { resolveForToolCall } from "../../../sidecar/dispatch/permission-resolver.mjs"

beforeEach(() => {
  __resetSessionDenialsForTesting()
})

describe("rememberDenial", () => {
  it("scopes a shell refusal to the command that was refused", () => {
    rememberDenial("s1", "Bash", { command: "git push --force" })
    expect(denialRuleset("s1")).toEqual({ Bash: { "git push --force": "deny" } })
  })

  it("does not refuse the rest of the command family", () => {
    rememberDenial("s1", "Bash", { command: "git push --force" })
    const rules = [denialRuleset("s1")!]
    expect(resolveBashPermission("git push --force", rules).verdict).toBe("deny")
    expect(resolveBashPermission("git status", rules).verdict).not.toBe("deny")
  })

  it("falls back to a tool-name refusal when the call has no target", () => {
    rememberDenial("s1", "mcp__plugin__do_thing", { foo: 1 })
    expect(denialRuleset("s1")).toEqual({ mcp__plugin__do_thing: "deny" })
  })

  it("lets a tool-name refusal subsume the pattern refusals for that tool", () => {
    rememberDenial("s1", "Bash", { command: "git push" })
    rememberDenial("s1", "Bash", { command: "git pull" })
    expect(countSessionDenials("s1")).toBe(2)
    rememberDenial("s1", "Bash", {})
    expect(denialRuleset("s1")).toEqual({ Bash: "deny" })
    expect(countSessionDenials("s1")).toBe(1)
  })

  it("is idempotent for the same call", () => {
    rememberDenial("s1", "Bash", { command: "rm -rf /tmp/x" })
    rememberDenial("s1", "Bash", { command: "rm -rf /tmp/x" })
    expect(countSessionDenials("s1")).toBe(1)
  })

  it("keeps sessions apart", () => {
    rememberDenial("s1", "Bash", { command: "git push" })
    expect(denialRuleset("s2")).toBeUndefined()
  })

  it("ignores a call with no session or tool", () => {
    rememberDenial("", "Bash", { command: "x" })
    rememberDenial("s1", "", { command: "x" })
    expect(denialRuleset("s1")).toBeUndefined()
  })

  it("forgets a session on demand", () => {
    rememberDenial("s1", "Bash", { command: "git push" })
    clearSessionDenials("s1")
    expect(denialRuleset("s1")).toBeUndefined()
  })

  it("evicts the least-recently-touched session past the tracking cap", () => {
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
      rememberDenial(`s${i}`, "Bash", { command: `cmd${i}` })
    }
    expect(denialRuleset("s0")).toBeUndefined()
    expect(denialRuleset(`s${MAX_TRACKED_SESSIONS}`)).toBeDefined()
  })
})

describe("saturation", () => {
  const saturate = (sessionId: string) => {
    for (let i = 0; i <= MAX_DENIALS_PER_SESSION; i++) {
      rememberDenial(sessionId, "Bash", { command: `cmd-${i}` })
    }
  }

  it("marks the session rather than forgetting the oldest refusal", () => {
    saturate("s1")
    expect(isSessionSaturated("s1")).toBe(true)
    expect(resolveBashPermission("cmd-0", [denialRuleset("s1")!]).verdict).toBe("deny")
  })

  it("stops accepting new refusals once saturated", () => {
    saturate("s1")
    const before = countSessionDenials("s1")
    rememberDenial("s1", "Bash", { command: "one-more" })
    expect(countSessionDenials("s1")).toBe(before)
  })
})

describe("applySessionDenials", () => {
  const allowRuleset: Ruleset = { Bash: { "git *": "allow" }, Read: "allow" }

  it("passes permissions through untouched when nothing was refused", () => {
    const inputs = { ruleset: allowRuleset, alwaysAllowTools: ["Bash"] }
    expect(applySessionDenials("s1", inputs)).toBe(inputs)
    expect(applySessionDenials(undefined, inputs)).toBe(inputs)
  })

  it("layers refusals over the caller's rules", () => {
    rememberDenial("s1", "Bash", { command: "git push --force" })
    const out = applySessionDenials("s1", { ruleset: allowRuleset })
    expect(out.ruleset.Bash).toEqual({ "git *": "allow", "git push --force": "deny" })
  })

  it("makes a refusal outrank a broader allow rule", () => {
    rememberDenial("s1", "Bash", { command: "git push --force" })
    const out = applySessionDenials("s1", { ruleset: allowRuleset })
    expect(resolveBashPermission("git push --force", [out.ruleset]).verdict).toBe("deny")
    expect(resolveBashPermission("git status", [out.ruleset]).verdict).toBe("allow")
  })

  it("keeps the always-allow list while the session is healthy", () => {
    rememberDenial("s1", "Bash", { command: "git push" })
    const out = applySessionDenials("s1", { ruleset: allowRuleset, alwaysAllowTools: ["Read"] })
    expect(out.alwaysAllowTools).toEqual(["Read"])
  })

  it("fails closed when saturated: no always-allow, no allow rules", () => {
    for (let i = 0; i <= MAX_DENIALS_PER_SESSION; i++) {
      rememberDenial("s1", "Bash", { command: `cmd-${i}` })
    }
    const out = applySessionDenials("s1", {
      ruleset: { Bash: { "git *": "allow", "npm *": "ask" }, Read: "allow", Write: "deny" },
      alwaysAllowTools: ["Read"],
    })
    expect(out.alwaysAllowTools).toBeUndefined()
    expect(out.ruleset.Read).toBeUndefined()
    expect(out.ruleset.Write).toBe("deny")
    expect((out.ruleset.Bash as Record<string, string>)["git *"]).toBeUndefined()
    expect((out.ruleset.Bash as Record<string, string>)["npm *"]).toBe("ask")
    // Through the gate that actually runs: nothing auto-approves any more.
    expect(resolveForToolCall(out.ruleset, "Read", { file_path: "/x" })).toBe("ask")
    expect(resolveForToolCall(out.ruleset, "Bash", { command: "git status" })).toBe("ask")
    expect(resolveForToolCall(out.ruleset, "Bash", { command: "cmd-0" })).toBe("deny")
  })

  it("replaces a tool's glob map with a tool-name refusal", () => {
    rememberDenial("s1", "Bash", {})
    const out = applySessionDenials("s1", { ruleset: allowRuleset })
    expect(out.ruleset.Bash).toBe("deny")
  })
})
