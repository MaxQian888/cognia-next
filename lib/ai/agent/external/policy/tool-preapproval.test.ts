import { configuredApprovalPolicy, isToolPreApproved } from "./tool-preapproval"

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

describe("projected Cognia tool identity", () => {
  it("requires an exact mounted bridge namespace", async () => {
    const { isCogniaProjectedTool } = await import("./tool-preapproval")
    expect(isCogniaProjectedTool("mcp__cognia-tools__read", ["cognia-tools"])).toBe(true)
    expect(isCogniaProjectedTool("mcp__cognia-plugin-tools__write", ["cognia-tools"])).toBe(false)
    expect(isCogniaProjectedTool("mcp__cognia-tools-evil__read", ["cognia-tools"])).toBe(false)
    expect(isCogniaProjectedTool("mcp__cognia-tools__read", [])).toBe(false)
    expect(isCogniaProjectedTool("Read", ["cognia-tools"])).toBe(false)
  })
})

describe("configuredApprovalPolicy", () => {
  const lists = { autoApprovePatterns: ["Read", "Bash(git status*)"], requireApprovalFor: ["edit"] }

  it("leaves the decision to the mode without lists", () => {
    expect(configuredApprovalPolicy(undefined, { title: "Read" })).toBeNull()
    expect(configuredApprovalPolicy({}, { title: "Read" })).toBeNull()
  })

  it("approves a request an auto-approval entry matches", () => {
    expect(configuredApprovalPolicy(lists, { title: "Read" })).toBe("approve")
    expect(
      configuredApprovalPolicy(lists, {
        toolInfo: { name: "Bash" },
        rawInput: { command: "git status -s" },
      })
    ).toBe("approve")
    // A specifier that cannot be satisfied fails closed.
    expect(
      configuredApprovalPolicy(lists, {
        toolInfo: { name: "Bash" },
        rawInput: { command: "rm -rf /" },
      })
    ).toBeNull()
  })

  it("lets always-ask win, matching the kind as well as the name", () => {
    expect(configuredApprovalPolicy(lists, { title: "Apply patch", kind: "edit" })).toBe("ask")
    expect(
      configuredApprovalPolicy(
        { autoApprovePatterns: ["*"], requireApprovalFor: ["Write"] },
        { title: "Write" }
      )
    ).toBe("ask")
  })
})
