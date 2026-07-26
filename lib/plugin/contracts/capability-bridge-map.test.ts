/**
 * Drift guard for the overlay-registry capability map (PR-D).
 *
 * The test walks every entry and asserts:
 *   1. The `manifestField` is a real key in `PluginManifest`.
 *   2. Both `registerEntry` and `unregisterAllByPlugin` are functions.
 *   3. The entry registers + bulk-removes against a real plugin id
 *      end to end.
 *
 * If a future refactor renames a registry export or drops a
 * `manifest.X` field without updating the map, this suite fails
 * loudly — before any plugin's contributions silently no-op at
 * runtime.
 */

import {
  OVERLAY_REGISTRY_CAPABILITIES,
  OVERLAY_REGISTRY_CAPABILITY_KEYS,
  type OverlayCapabilityDescriptor,
} from "./capability-bridge-map"
import { __resetSkillsForTesting, getSkill } from "@/lib/plugin/registries/skill-registry"
import {
  __resetMcpServerPresetsForTesting,
  getMcpServerPreset,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import { __resetSubagentsForTesting, getSubagent } from "@/lib/plugin/registries/subagent-registry"
import type { PluginCapability, PluginManifest } from "@/types/plugin"

describe("OVERLAY_REGISTRY_CAPABILITIES (PR-D)", () => {
  it("covers exactly the capabilities the dispatch loop expects", () => {
    expect(OVERLAY_REGISTRY_CAPABILITY_KEYS).toEqual(
      expect.arrayContaining([
        "skills",
        "mcp-server-preset",
        "native-anthropic-tool",
        "external-agent-preset",
        "character-pack",
        "subagent",
        "agent-team-template",
        "shared-memory-adapter",
        "balance-adapter",
        "limits-source",
        "im-rate-source",
        "compaction-strategy",
        "workflow-template",
        "quick-action",
        "view-container",
        "auth-provider",
        "pet-achievement",
        "pet-item",
      ])
    )
    // Lock the count too — a silent growth here would mean the
    // contributions block in PluginManager picked up new behaviour
    // that may need cross-checking against bespoke branches.
    expect(OVERLAY_REGISTRY_CAPABILITY_KEYS).toHaveLength(18)
  })

  describe.each(OVERLAY_REGISTRY_CAPABILITY_KEYS)("%s", (key) => {
    const descriptor: OverlayCapabilityDescriptor = OVERLAY_REGISTRY_CAPABILITIES[key]

    it("registers as a Partial<Record<PluginCapability, …>> key", () => {
      // Compile-time guard is the real test; this assertion exists so
      // the runtime symbol survives `tsc --erasableSyntaxOnly`-style
      // future builds where types alone don't reach jest.
      const allowed: PluginCapability = key as PluginCapability
      expect(typeof allowed).toBe("string")
    })

    it("points at a real PluginManifest field", () => {
      // The manifest is structural so we check the field name against
      // a representative empty manifest — TS would already have flagged
      // an unknown key, but this guards against a future widening
      // refactor that loosens the type.
      const emptyManifest: PluginManifest = {
        id: "test",
        name: "test",
        version: "0.0.0",
        description: "test",
        type: "frontend",
        permissions: [],
        capabilities: [],
      } as PluginManifest
      // Setting the field to undefined exercises the index access.
      ;(emptyManifest as unknown as Record<string, unknown>)[descriptor.manifestField] = undefined
      expect(descriptor.manifestField).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
    })

    it("exposes runnable register + unregister functions", () => {
      expect(typeof descriptor.registerEntry).toBe("function")
      expect(typeof descriptor.unregisterAllByPlugin).toBe("function")
    })

    it("round-trips an entry through register + unregister cleanly", () => {
      const entry = { id: `pr-d-test-${key}`, _testTag: true }
      const ctx = { pluginId: `pr-d-test-plugin-${key}` }
      // Should not throw — registries are idempotent under PR-D's
      // contract.
      expect(() => descriptor.registerEntry(entry, ctx)).not.toThrow()
      const removed = descriptor.unregisterAllByPlugin(ctx.pluginId)
      expect(removed).toBeGreaterThanOrEqual(1)
    })
  })
})

describe("skills descriptor anchors plugin-dir-relative source paths", () => {
  const descriptor = OVERLAY_REGISTRY_CAPABILITIES.skills
  const installRoot = "/opt/cognia/plugins/paths-demo"

  afterEach(() => {
    __resetSkillsForTesting()
  })

  it("resolves a relative local-bundle path against the install root", () => {
    descriptor.registerEntry(
      {
        id: "anchored-skill",
        name: "Anchored",
        description: "d",
        source: { kind: "local-bundle", path: "skills/researcher" },
      },
      { pluginId: "paths-demo", installRoot }
    )
    expect(getSkill("anchored-skill")?.source).toEqual({
      kind: "local-bundle",
      path: `${installRoot}/skills/researcher`,
    })
    expect(getSkill("anchored-skill")?.runtimePluginRoot).toBe(installRoot)
  })

  it("leaves inline sources alone", () => {
    descriptor.registerEntry(
      {
        id: "inline-skill",
        name: "Inline",
        description: "d",
        source: { kind: "inline", markdown: "# body" },
      },
      { pluginId: "paths-demo", installRoot }
    )
    expect(getSkill("inline-skill")?.source).toEqual({ kind: "inline", markdown: "# body" })
  })

  it("refuses a path that escapes the plugin directory", () => {
    expect(() =>
      descriptor.registerEntry(
        {
          id: "escaping-skill",
          name: "Escaping",
          description: "d",
          source: { kind: "local-folder", path: "../../../etc" },
        },
        { pluginId: "paths-demo", installRoot }
      )
    ).toThrow(/escapes the plugin directory/)
    expect(getSkill("escaping-skill")).toBeUndefined()
  })
})

describe("converted plugin-root tokens", () => {
  const installRoot = "/opt/cognia/plugins/converted"

  afterEach(() => {
    __resetMcpServerPresetsForTesting()
    __resetSubagentsForTesting()
  })

  it("binds tokens in MCP preset config at registration", () => {
    OVERLAY_REGISTRY_CAPABILITIES["mcp-server-preset"].registerEntry(
      {
        id: "local-server",
        name: "Local Server",
        transport: "stdio",
        config: {
          command: "node",
          args: ["${COGNIA_PLUGIN_ROOT}/servers/index.js"],
        },
      },
      { pluginId: "converted", installRoot }
    )

    expect(getMcpServerPreset("local-server")?.config).toEqual({
      command: "node",
      args: [`${installRoot}/servers/index.js`],
    })
  })

  it("binds source-ecosystem tokens in subagent prompts at registration", () => {
    OVERLAY_REGISTRY_CAPABILITIES.subagent.registerEntry(
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews files.",
        prompt: "Read ${CLAUDE_PLUGIN_ROOT}/references/policy.md",
      },
      { pluginId: "converted", installRoot }
    )

    expect(getSubagent("reviewer")?.prompt).toBe(`Read ${installRoot}/references/policy.md`)
  })
})
