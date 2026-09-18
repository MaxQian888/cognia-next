import { resolveToolProvenance } from "./tool-provenance"

describe("resolveToolProvenance", () => {
  it("returns null for absent or empty tool names", () => {
    expect(resolveToolProvenance(undefined)).toBeNull()
    expect(resolveToolProvenance(null)).toBeNull()
    expect(resolveToolProvenance("")).toBeNull()
    expect(resolveToolProvenance(42)).toBeNull()
  })

  it("classifies bare names as builtin on the built-in surface", () => {
    expect(resolveToolProvenance("Bash")).toEqual({
      kind: "builtin",
      source: "cognia",
      declared_by: "builtin-tools-data.json",
    })
    expect(resolveToolProvenance("mcp__x")).toEqual({
      kind: "builtin",
      source: "cognia",
      declared_by: "builtin-tools-data.json",
    })
  })

  it("classifies cognia-tools namespaced names as builtin", () => {
    expect(resolveToolProvenance("mcp__cognia-tools__web_search")).toEqual({
      kind: "builtin",
      source: "cognia",
      declared_by: "builtin-tools-data.json",
    })
  })

  it("resolves plugin tools back to their pluginId and manifest path", () => {
    const pluginTools = [
      {
        name: "ripgrep-tools:ripgrep_search",
        pluginId: "ripgrep-tools",
        manifestPath: "/plugins/ripgrep-tools/plugin.json",
      },
      { name: "other", pluginId: "other-plugin" },
    ]
    expect(
      resolveToolProvenance("mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search", {
        pluginTools,
      })
    ).toEqual({
      kind: "plugin",
      source: "ripgrep-tools",
      declared_by: "/plugins/ripgrep-tools/plugin.json",
    })
    // A manifest entry with no recorded path simply omits `declared_by`.
    expect(resolveToolProvenance("mcp__cognia-plugin-tools__other", { pluginTools })).toEqual({
      kind: "plugin",
      source: "other-plugin",
    })
  })

  it("reports source 'unknown' for plugin tools missing from the manifest", () => {
    expect(resolveToolProvenance("mcp__cognia-plugin-tools__ghost_tool")).toEqual({
      kind: "plugin",
      source: "unknown",
    })
    expect(
      resolveToolProvenance("mcp__cognia-plugin-tools__ghost_tool", {
        pluginTools: [{ name: "ghost_tool" }],
      })
    ).toEqual({ kind: "plugin", source: "unknown" })
  })

  it("classifies other mcp__ names by server, splitting on the first __", () => {
    expect(resolveToolProvenance("mcp__github__create_issue")).toEqual({
      kind: "mcp",
      source: "github",
    })
    // Tool names may themselves contain `__`.
    expect(resolveToolProvenance("mcp__srv__a__b")).toEqual({
      kind: "mcp",
      source: "srv",
    })
  })

  it("names the declaring config for mcp tools when the map supplies one", () => {
    expect(
      resolveToolProvenance("mcp__github__create_issue", {
        mcpDeclaredBy: { github: "/repo/.mcp.json" },
      })
    ).toEqual({ kind: "mcp", source: "github", declared_by: "/repo/.mcp.json" })
    // A server absent from the map omits `declared_by` rather than guessing.
    expect(
      resolveToolProvenance("mcp__ghost__tool", {
        mcpDeclaredBy: { github: "/repo/.mcp.json" },
      })
    ).toEqual({ kind: "mcp", source: "ghost" })
  })

  it("classifies bare names as agent-owned when an external agent id is given", () => {
    expect(resolveToolProvenance("Bash", { externalAgentId: "claude-code" })).toEqual({
      kind: "agent",
      source: "claude-code",
    })
    // Namespaced names still resolve by shape on the external surface — the
    // agent's own mcp config isn't ours, so `declared_by` stays absent unless
    // the caller supplies a map.
    expect(
      resolveToolProvenance("mcp__github__create_issue", { externalAgentId: "claude-code" })
    ).toEqual({ kind: "mcp", source: "github" })
  })

  it("never carries arguments or secrets — metadata only", () => {
    // Real manifest entries carry more than name/pluginId (jsonSchema, access…);
    // none of it may leak into the provenance value.
    const entry = { name: "t", pluginId: "p1", jsonSchema: { secret: true } }
    const p = resolveToolProvenance("mcp__cognia-plugin-tools__t", {
      pluginTools: [entry],
    })
    expect(Object.keys(p ?? {}).sort()).toEqual(["kind", "source"])
  })
})
