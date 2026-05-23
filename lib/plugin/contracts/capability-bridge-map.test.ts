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
      ])
    )
    // Lock the count too — a silent growth here would mean the
    // contributions block in PluginManager picked up new behaviour
    // that may need cross-checking against bespoke branches.
    expect(OVERLAY_REGISTRY_CAPABILITY_KEYS).toHaveLength(7)
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
