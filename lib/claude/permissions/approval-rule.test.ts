import { deriveAllowRuleFromApproval } from "./approval-rule"

describe("deriveAllowRuleFromApproval", () => {
  it("scopes a shell command to its head, keyed under Bash", () => {
    expect(deriveAllowRuleFromApproval("Bash", { command: "git status --short" })).toEqual({
      tool: "Bash",
      pattern: "git *",
    })
  })

  it("keys the core `bash` tool under Bash too (resolver parity)", () => {
    expect(
      deriveAllowRuleFromApproval("mcp__cognia-tools__bash", { command: "npm run build" })
    ).toEqual({ tool: "Bash", pattern: "npm *" })
  })

  it("strips a directory prefix and .exe suffix from the command head", () => {
    expect(
      deriveAllowRuleFromApproval("bash", { command: "C:\\tools\\rg.exe pattern src" })
    ).toEqual({ tool: "Bash", pattern: "rg *" })
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
