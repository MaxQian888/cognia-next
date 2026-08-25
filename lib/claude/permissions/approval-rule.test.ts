import { deriveAllowRuleFromApproval } from "./approval-rule"
import { resolveBashPermission } from "./ruleset"

/** Does a derived rule cover this command, per the real resolver? */
const matchesRule = (pattern: string, command: string): boolean =>
  resolveBashPermission(command, [{ Bash: { [pattern]: "allow" } }]).explicit

describe("deriveAllowRuleFromApproval", () => {
  it("scopes a shell grant to the command the user approved, keyed under Bash", () => {
    expect(deriveAllowRuleFromApproval("Bash", { command: "git status --short" })).toEqual({
      tool: "Bash",
      pattern: "git status --short",
    })
  })

  it("does NOT grant the rest of the command family", () => {
    // The whole point: approving a read-only command must not also approve the
    // destructive ones that share its head.
    const rule = deriveAllowRuleFromApproval("Bash", { command: "git status" })
    expect(rule).toEqual({ tool: "Bash", pattern: "git status" })
    expect(rule!.pattern).not.toBe("git *")
    expect(matchesRule(rule!.pattern, "git push --force")).toBe(false)
    expect(matchesRule(rule!.pattern, "git reset --hard")).toBe(false)
    expect(matchesRule(rule!.pattern, "git clean -fdx")).toBe(false)
    expect(matchesRule(rule!.pattern, "git status")).toBe(true)
  })

  it("keys the core `bash` tool under Bash too (resolver parity)", () => {
    expect(
      deriveAllowRuleFromApproval("mcp__cognia-tools__bash", { command: "npm run build" })
    ).toEqual({ tool: "Bash", pattern: "npm run build" })
  })

  it("keeps the command's path prefix — it is part of what was approved", () => {
    expect(
      deriveAllowRuleFromApproval("bash", { command: "C:\\tools\\rg.exe pattern src" })
    ).toEqual({ tool: "Bash", pattern: "C:\\tools\\rg.exe pattern src" })
  })

  it("collapses whitespace so a re-run that only differs in spacing still matches", () => {
    expect(deriveAllowRuleFromApproval("Bash", { command: "  git   status  " })).toEqual({
      tool: "Bash",
      pattern: "git status",
    })
  })

  it("leaves glob metacharacters as wildcards — the documented caveat", () => {
    const rule = deriveAllowRuleFromApproval("Bash", { command: "ls *.ts" })
    expect(rule).toEqual({ tool: "Bash", pattern: "ls *.ts" })
    // The ruleset matcher has no escape syntax, so `*` still globs. Narrow
    // enough to be worth having, wide enough to be worth knowing about.
    expect(matchesRule(rule!.pattern, "ls other.ts")).toBe(true)
  })

  it("scopes a file tool to its exact path, keyed under the exact tool name", () => {
    expect(deriveAllowRuleFromApproval("Read", { file_path: "/proj/src/a.ts" })).toEqual({
      tool: "Read",
      pattern: "/proj/src/a.ts",
    })
    expect(
      deriveAllowRuleFromApproval("mcp__cognia-tools__write", { file_path: "/proj/b" })
    ).toEqual({ tool: "mcp__cognia-tools__write", pattern: "/proj/b" })
  })

  it("uses `path` when `file_path` is absent", () => {
    expect(deriveAllowRuleFromApproval("grep", { path: "/proj/src" })).toEqual({
      tool: "grep",
      pattern: "/proj/src",
    })
  })

  it("returns null when there is no useful target (fall back to bare-name grant)", () => {
    expect(deriveAllowRuleFromApproval("mcp__plugin__do_thing", { foo: 1 })).toBeNull()
    expect(deriveAllowRuleFromApproval("Bash", {})).toBeNull()
    expect(deriveAllowRuleFromApproval("Bash", { command: "   " })).toBeNull()
    expect(deriveAllowRuleFromApproval("Read", { file_path: "" })).toBeNull()
    expect(deriveAllowRuleFromApproval("Read", null)).toBeNull()
  })
})
