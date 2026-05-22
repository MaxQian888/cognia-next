/**
 * Codified registry: which `PluginCapability` values feed which
 * overlay-registry register/unregister pair (the `createOverlayRegistry`
 * pattern from `lib/plugin/registries/createOverlayRegistry.ts`).
 *
 * PR-D of the plugin system optimization (see plans/noble-hatching-mango.md).
 *
 * Scope note: only capabilities whose enable/disable dispatch follows
 * the uniform "for each entry in `manifest.<field>` call register(id,
 * def, { pluginId }); on disable call unregisterByPlugin(pluginId)"
 * pattern live in this map. Capabilities with bespoke wiring (modes
 * with id prefixing, commands with async slash-command registration,
 * themes via the bridge factory, lsp servers via dynamic require,
 * a2ui components/templates via the in-context bridge, etc.) stay in
 * `PluginManager.registerPluginContributions` / `unregisterPluginContributions`
 * because their per-entry logic doesn't fit the uniform shape.
 *
 * The `satisfies Partial<Record<PluginCapability, …>>` guard ensures:
 *   - Adding a new uniform-shaped capability to `PluginCapability`
 *     without an entry here is allowed (Partial) — but the dispatch
 *     loop in the manager won't pick it up, which is what we want for
 *     bespoke-shaped capabilities.
 *   - Spelling drift on the `PluginCapability` enum that this map
 *     keys against is caught at compile time.
 *   - A CI-gated test (see `capability-bridge-map.test.ts`) walks
 *     `OVERLAY_REGISTRY_CAPABILITIES` and asserts every entry's
 *     `manifestField` is a real PluginManifest key + the register /
 *     unregister functions are present, so a future refactor that
 *     drops a registry export fails loudly.
 */

import type { PluginCapability, PluginManifest } from "@/types/plugin"
import {
  registerMcpServerPreset,
  unregisterMcpServerPresetsByPlugin,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import {
  registerNativeAnthropicTool,
  unregisterNativeAnthropicToolsByPlugin,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { registerSkill, unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import {
  registerPreset as registerExternalAgentPresetOverlay,
  unregisterPresetsByPlugin as unregisterExternalAgentPresetsByPlugin,
} from "@/lib/ai/agent/external/presets"

/**
 * Minimal entry shape every overlay-registry contribution conforms to.
 * The descriptor's `registerEntry` closure narrows further per
 * registry — `id` is the only field every contribution shares.
 */
export interface OverlayContributionEntry {
  id: string
  [key: string]: unknown
}

export interface OverlayCapabilityDescriptor {
  /** PluginManifest array field the entries live on. */
  manifestField: keyof PluginManifest
  /**
   * Per-entry register call. Implementations may destructure or pass
   * the entry through verbatim — the uniform contract is just "this
   * adds one entry to its registry under `pluginId`".
   */
  registerEntry: (entry: OverlayContributionEntry, ctx: { pluginId: string }) => void
  /**
   * Bulk cleanup. Implementations must idempotently drop every entry
   * the named plugin contributed. Returns the count for diagnostics.
   */
  unregisterAllByPlugin: (pluginId: string) => number
  /**
   * Marker for capabilities declared in `plugin-points.ts` that have
   * no JSX mount yet. The dispatch loop still registers them; audit
   * mode (existing) can warn separately.
   */
  virtual?: true
}

/**
 * The 4 capabilities whose enable/disable dispatch follows the
 * uniform overlay-registry shape. Adding a 5th overlay-registry
 * capability is a single map entry away from being picked up by the
 * dispatch loop — no manager surgery required.
 */
export const OVERLAY_REGISTRY_CAPABILITIES = {
  skills: {
    manifestField: "skills",
    registerEntry: (def, ctx) => {
      // Skill defs pass through verbatim — the registry stores the
      // entire entry under its `id`.
      registerSkill(def.id, def as unknown as never, ctx)
    },
    unregisterAllByPlugin: unregisterSkillsByPlugin,
  },
  "mcp-server-preset": {
    manifestField: "mcpServerPresets",
    registerEntry: (def, ctx) => {
      registerMcpServerPreset(def.id, def as unknown as never, ctx)
    },
    unregisterAllByPlugin: unregisterMcpServerPresetsByPlugin,
  },
  "native-anthropic-tool": {
    manifestField: "nativeAnthropicTools",
    registerEntry: (def, ctx) => {
      registerNativeAnthropicTool(def.id, def as unknown as never, ctx)
    },
    unregisterAllByPlugin: unregisterNativeAnthropicToolsByPlugin,
  },
  "external-agent-preset": {
    manifestField: "externalAgentPresets",
    registerEntry: (def, ctx) => {
      // External-agent presets historically destructured `id` out of
      // the def before forwarding — preserving that for a true
      // behaviour-preserving refactor.
      const { id, ...config } = def
      registerExternalAgentPresetOverlay(id, config as unknown as never, ctx)
    },
    unregisterAllByPlugin: unregisterExternalAgentPresetsByPlugin,
  },
} as const satisfies Partial<Record<PluginCapability, OverlayCapabilityDescriptor>>

export type OverlayRegistryCapability = keyof typeof OVERLAY_REGISTRY_CAPABILITIES

/**
 * List of capabilities the dispatch loop must iterate, derived from
 * the map keys so a future addition automatically widens the loop.
 */
export const OVERLAY_REGISTRY_CAPABILITY_KEYS: ReadonlyArray<OverlayRegistryCapability> =
  Object.keys(OVERLAY_REGISTRY_CAPABILITIES) as ReadonlyArray<OverlayRegistryCapability>
