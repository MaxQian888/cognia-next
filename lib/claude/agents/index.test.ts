import {
  CLAUDE_CODE_AGENT,
  CLAUDE_DESKTOP_AGENT,
  CLINE_AGENT,
  CODEX_AGENT,
  COGNIA_AGENT,
  CURSOR_AGENT,
  GEMINI_AGENT,
  MCP_AGENT_ADAPTERS,
  ROO_CODE_AGENT,
  VSCODE_AGENT,
  WINDSURF_AGENT,
  getAgentAdapter,
  requireAgentAdapter,
} from "./index"

describe("MCP_AGENT_ADAPTERS registry", () => {
  it("contains exactly the 13 known adapters", () => {
    expect(MCP_AGENT_ADAPTERS).toHaveLength(13)
    expect(MCP_AGENT_ADAPTERS.map((a) => a.id).sort()).toEqual(
      [
        "claude-code",
        "claude-desktop",
        "cline",
        "codex",
        "cognia",
        "cursor",
        "gemini",
        "kiro",
        "opencode",
        "roo-code",
        "vscode",
        "windsurf",
        "zed",
      ].sort()
    )
  })

  it("orders writable adapters before read-only ones", () => {
    const ids = MCP_AGENT_ADAPTERS.map((a) => a.id)
    const writableLast = ids.indexOf("windsurf")
    const firstReadOnly = ids.indexOf("cline")
    expect(writableLast).toBeLessThan(firstReadOnly)
    // Both read-only adapters live at the tail.
    expect(ids[ids.length - 1]).toBe("roo-code")
    expect(ids[ids.length - 2]).toBe("cline")
  })

  it("re-exports each adapter named export", () => {
    expect(CLAUDE_CODE_AGENT.id).toBe("claude-code")
    expect(CLAUDE_DESKTOP_AGENT.id).toBe("claude-desktop")
    expect(CURSOR_AGENT.id).toBe("cursor")
    expect(VSCODE_AGENT.id).toBe("vscode")
    expect(CODEX_AGENT.id).toBe("codex")
    expect(GEMINI_AGENT.id).toBe("gemini")
    expect(WINDSURF_AGENT.id).toBe("windsurf")
    expect(CLINE_AGENT.id).toBe("cline")
    expect(ROO_CODE_AGENT.id).toBe("roo-code")
    expect(COGNIA_AGENT.id).toBe("cognia")
  })

  it("each adapter exposes the documented interface fields", () => {
    for (const a of MCP_AGENT_ADAPTERS) {
      expect(typeof a.id).toBe("string")
      expect(typeof a.displayName).toBe("string")
      expect(["json", "jsonc", "toml"]).toContain(a.format)
      expect(typeof a.writable).toBe("boolean")
      expect(typeof a.parse).toBe("function")
      expect(typeof a.project).toBe("function")
    }
  })
})

describe("getAgentAdapter", () => {
  it("returns the adapter for a known id", () => {
    expect(getAgentAdapter("vscode")).toBe(VSCODE_AGENT)
    expect(getAgentAdapter("claude-code")).toBe(CLAUDE_CODE_AGENT)
  })

  it("returns undefined for an unknown id", () => {
    expect(getAgentAdapter("nope" as never)).toBeUndefined()
  })
})

describe("requireAgentAdapter", () => {
  it("returns the adapter for a known id", () => {
    expect(requireAgentAdapter("cursor")).toBe(CURSOR_AGENT)
  })

  it("throws for an unknown id", () => {
    expect(() => requireAgentAdapter("nope" as never)).toThrow(/unknown agent: nope/)
  })
})
