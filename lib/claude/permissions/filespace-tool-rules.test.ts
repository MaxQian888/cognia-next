import { buildFilespaceToolRuleset } from "./filespace-tool-rules"

describe("buildFilespaceToolRuleset", () => {
  it("allows reading and revoking, asks before giving access, on both name forms", () => {
    const rules = buildFilespaceToolRuleset({ sharing: true })
    for (const tool of ["filespace_list", "filespace_revoke_share", "filespace_disable_webdav"]) {
      expect(rules[tool]).toBe("allow")
      expect(rules[`mcp__cognia-plugin-tools__${tool}`]).toBe("allow")
    }
    for (const tool of ["filespace_share", "filespace_enable_webdav"]) {
      expect(rules[tool]).toBe("ask")
      expect(rules[`mcp__cognia-plugin-tools__${tool}`]).toBe("ask")
    }
  })

  it("carries no tier for sharing tools the turn does not offer", () => {
    const rules = buildFilespaceToolRuleset({ sharing: false })
    expect(Object.keys(rules).sort()).toEqual(
      [
        "filespace_disable_webdav",
        "filespace_list",
        "filespace_revoke_share",
        "mcp__cognia-plugin-tools__filespace_disable_webdav",
        "mcp__cognia-plugin-tools__filespace_list",
        "mcp__cognia-plugin-tools__filespace_revoke_share",
      ].sort()
    )
  })
})
