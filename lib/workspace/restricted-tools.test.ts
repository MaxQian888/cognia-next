import { RESTRICTED_MODE_DENIED_TOOLS, isRestrictedTool } from "./restricted-tools"

describe("restricted tools", () => {
  it("denies disk/host-mutating SDK tools", () => {
    for (const t of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(isRestrictedTool(t)).toBe(true)
    }
  })

  it("allows read-only tools", () => {
    for (const t of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]) {
      expect(isRestrictedTool(t)).toBe(false)
    }
  })

  it("denies the coreFiles mutators (bare and namespaced)", () => {
    for (const t of ["bash", "edit", "write", "multi_edit"]) {
      expect(isRestrictedTool(t)).toBe(true)
      expect(isRestrictedTool(`mcp__cognia-tools__${t}`)).toBe(true)
    }
  })

  it("allows the read-only coreFiles tools", () => {
    for (const t of ["read", "grep", "glob", "ls"]) {
      expect(isRestrictedTool(t)).toBe(false)
    }
  })

  it("denies computer-use plugin tools by prefix", () => {
    expect(isRestrictedTool("mcp__cognia-plugin-tools__computer_use")).toBe(true)
    expect(isRestrictedTool("mcp__cognia-plugin-tools__bash")).toBe(true)
    expect(isRestrictedTool("mcp__cognia-plugin-tools__text_editor")).toBe(true)
  })

  it("exposes the core deny list as a constant", () => {
    expect(RESTRICTED_MODE_DENIED_TOOLS).toContain("Bash")
    expect(RESTRICTED_MODE_DENIED_TOOLS).toContain("Write")
  })

  it("allows unrelated mcp tools", () => {
    expect(isRestrictedTool("mcp__some-other__read")).toBe(false)
  })
})
