import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveToolProvenance } from "./tool-provenance.mjs"

// Mirror of lib/claude/hooks/tool-provenance.test.ts — the sidecar copy cannot
// import `@/`, so both copies are pinned by identical shape assertions.

test("resolveToolProvenance: null for absent or empty names", () => {
  assert.equal(resolveToolProvenance(undefined), null)
  assert.equal(resolveToolProvenance(null), null)
  assert.equal(resolveToolProvenance(""), null)
  assert.equal(resolveToolProvenance(42), null)
})

test("resolveToolProvenance: bare names are builtin on the built-in surface", () => {
  assert.deepEqual(resolveToolProvenance("Bash"), {
    kind: "builtin",
    source: "cognia",
    declared_by: "builtin-tools-data.json",
  })
  assert.deepEqual(resolveToolProvenance("mcp__x"), {
    kind: "builtin",
    source: "cognia",
    declared_by: "builtin-tools-data.json",
  })
})

test("resolveToolProvenance: cognia-tools namespaced names are builtin", () => {
  assert.deepEqual(resolveToolProvenance("mcp__cognia-tools__web_search"), {
    kind: "builtin",
    source: "cognia",
    declared_by: "builtin-tools-data.json",
  })
})

test("resolveToolProvenance: plugin tools resolve to their pluginId + manifest path", () => {
  const pluginTools = [
    {
      name: "ripgrep-tools:ripgrep_search",
      pluginId: "ripgrep-tools",
      manifestPath: "/plugins/ripgrep-tools/plugin.json",
    },
    { name: "other", pluginId: "other-plugin" },
  ]
  assert.deepEqual(
    resolveToolProvenance("mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search", {
      pluginTools,
    }),
    {
      kind: "plugin",
      source: "ripgrep-tools",
      declared_by: "/plugins/ripgrep-tools/plugin.json",
    }
  )
  // A manifest entry with no recorded path omits `declared_by`.
  assert.deepEqual(resolveToolProvenance("mcp__cognia-plugin-tools__other", { pluginTools }), {
    kind: "plugin",
    source: "other-plugin",
  })
  assert.deepEqual(resolveToolProvenance("mcp__cognia-plugin-tools__ghost"), {
    kind: "plugin",
    source: "unknown",
  })
})

test("resolveToolProvenance: other mcp__ names split server from tool", () => {
  assert.deepEqual(resolveToolProvenance("mcp__github__create_issue"), {
    kind: "mcp",
    source: "github",
  })
  assert.deepEqual(resolveToolProvenance("mcp__srv__a__b"), {
    kind: "mcp",
    source: "srv",
  })
})

test("resolveToolProvenance: mcp declared_by comes from the per-server map", () => {
  assert.deepEqual(
    resolveToolProvenance("mcp__github__create_issue", {
      mcpDeclaredBy: { github: "/repo/.mcp.json" },
    }),
    { kind: "mcp", source: "github", declared_by: "/repo/.mcp.json" }
  )
  // A server absent from the map omits `declared_by` rather than guessing.
  assert.deepEqual(
    resolveToolProvenance("mcp__ghost__tool", { mcpDeclaredBy: { github: "/repo/.mcp.json" } }),
    { kind: "mcp", source: "ghost" }
  )
})

test("resolveToolProvenance: external-agent surface owns bare names", () => {
  assert.deepEqual(resolveToolProvenance("Bash", { externalAgentId: "claude-code" }), {
    kind: "agent",
    source: "claude-code",
  })
})

test("resolveToolProvenance: metadata only — no args, secrets, or manifest fields", () => {
  const p = resolveToolProvenance("mcp__cognia-plugin-tools__t", {
    pluginTools: [{ name: "t", pluginId: "p1", jsonSchema: { secret: true } }],
  })
  assert.deepEqual(Object.keys(p ?? {}).sort(), ["kind", "source"])
})
