import {
  RESTRICTED_MODE_DENIED_TOOLS,
  isRestrictedTool,
  withRestrictedModeDenials,
} from "./restricted-tools"

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

describe("withRestrictedModeDenials", () => {
  it("denies every restricted tool and drops it from the allow list", () => {
    const out = withRestrictedModeDenials({
      allowedTools: ["Read", "Bash", "mcp__cognia-plugin-tools__computer_use"],
      disallowedTools: ["WebSearch"],
    })
    expect(out.disallowedTools).toEqual(
      expect.arrayContaining([
        "WebSearch",
        "Bash",
        "Edit",
        "Write",
        "mcp__cognia-plugin-tools__computer_use",
      ])
    )
    expect(out.allowedTools).toEqual(["Read"])
  })

  it("restores the deny list an override replaced", () => {
    // A scheduled payload's `disallowedTools` replaces the resolved list.
    const overridden = { disallowedTools: ["WebSearch"], allowedTools: ["Bash"] }
    const out = withRestrictedModeDenials(overridden)
    expect(out.disallowedTools).toContain("Bash")
    expect(out.allowedTools).toEqual([])
  })

  it("leaves an absent allow list absent and is idempotent", () => {
    const once = withRestrictedModeDenials({ model: "m" } as {
      model: string
      allowedTools?: string[]
      disallowedTools?: string[]
    })
    expect(once).not.toHaveProperty("allowedTools")
    expect(once.model).toBe("m")
    expect(withRestrictedModeDenials(once).disallowedTools).toEqual(once.disallowedTools)
  })
})
