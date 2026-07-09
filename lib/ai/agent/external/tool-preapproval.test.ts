import { isToolPreApproved } from "./tool-preapproval"

describe("isToolPreApproved", () => {
  it("returns false when the allow-list is empty or the tool name is missing", () => {
    expect(isToolPreApproved("Read", undefined, undefined)).toBe(false)
    expect(isToolPreApproved("Read", undefined, [])).toBe(false)
    expect(isToolPreApproved(undefined, undefined, ["Read"])).toBe(false)
  })

  it("approves a bare tool-name entry regardless of input", () => {
    expect(isToolPreApproved("Read", { file_path: "/x" }, ["Read"])).toBe(true)
    expect(isToolPreApproved("Write", undefined, ["Read", "Write"])).toBe(true)
  })

  it("rejects a tool not present in the allow-list", () => {
    expect(isToolPreApproved("Bash", { command: "ls" }, ["Read", "Write"])).toBe(false)
  })

  it("supports wildcard tool-name entries", () => {
    expect(isToolPreApproved("AnyTool", undefined, ["*"])).toBe(true)
    expect(isToolPreApproved("mcp__srv__do", undefined, ["mcp__*"])).toBe(true)
  })

  it("honours a Tool(specifier) entry against the derived target", () => {
    expect(isToolPreApproved("Bash", { command: "git status" }, ["Bash(git:*)"])).toBe(false)
    expect(isToolPreApproved("Bash", { command: "git status" }, ["Bash(git*)"])).toBe(true)
    expect(isToolPreApproved("Bash", { command: "rm -rf /" }, ["Bash(git*)"])).toBe(false)
  })

  it("fails closed when a specifier entry has no derivable target", () => {
    // Bash matches the base name but there is no `command` to test the glob.
    expect(isToolPreApproved("Bash", {}, ["Bash(git*)"])).toBe(false)
    expect(isToolPreApproved("Bash", undefined, ["Bash(git*)"])).toBe(false)
  })

  it("matches file-path specifiers via the file_path/path keys", () => {
    expect(isToolPreApproved("Read", { file_path: "/repo/a.ts" }, ["Read(/repo/*)"])).toBe(true)
    expect(isToolPreApproved("Read", { path: "/etc/passwd" }, ["Read(/repo/*)"])).toBe(false)
  })

  it("skips empty entries", () => {
    expect(isToolPreApproved("Read", undefined, ["", "Read"])).toBe(true)
  })

  it("tolerates a specifier entry with no closing paren", () => {
    // `Bash(ls` — malformed but the specifier still reads to the end of string.
    expect(isToolPreApproved("Bash", { command: "ls" }, ["Bash(ls"])).toBe(true)
    expect(isToolPreApproved("Bash", { command: "rm" }, ["Bash(ls"])).toBe(false)
  })
})
