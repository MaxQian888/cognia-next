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

import type {
  PluginCapability,
  PluginManifest,
  PluginSkillDef,
  PluginMcpServerPresetDef,
  PluginNativeAnthropicToolDef,
  PluginExternalAgentPresetDef,
  PluginSubagentDef,
  PluginAgentTeamTemplateDef,
} from "@/types/plugin"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
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
  refreshAllPackWarnings,
  registerCharacterPack,
  unregisterCharacterPacksByPlugin,
} from "@/lib/plugin/registries/character-pack-registry"
import {
  registerPreset as registerExternalAgentPresetOverlay,
  unregisterPresetsByPlugin as unregisterExternalAgentPresetsByPlugin,
} from "@/lib/ai/agent/external/presets"
import {
  registerSubagent,
  unregisterSubagentsByPlugin,
} from "@/lib/plugin/registries/subagent-registry"
import {
  refreshAllTemplateWarnings,
  registerAgentTeamTemplate,
  unregisterAgentTeamTemplatesByPlugin,
} from "@/lib/plugin/registries/agent-team-template-registry"
import {
  registerSharedMemoryAdapter,
  unregisterSharedMemoryAdaptersByPlugin,
} from "@/lib/plugin/registries/shared-memory-adapter-registry"
import {
  refreshAllWorkflowTemplateWarnings,
  registerWorkflowTemplate,
  unregisterWorkflowTemplatesByPlugin,
} from "@/lib/plugin/registries/workflow-template-registry"

/**
 * Minimal entry shape every overlay-registry contribution conforms to.
 * The descriptor's `registerEntry` closure narrows further per
 * registry — `id` is the only field every contribution shares.
 */
export interface OverlayContributionEntry {
  id: string
  [key: string]: unknown
}

/**
 * The descriptor as the dispatch loop (`PluginManager.registerPluginContributions`)
 * sees it: `registerEntry` takes the structural lower bound every overlay
 * entry shares (`{ id: string }`), because the loop reads the manifest field
 * generically and can only prove `id` is present.
 */
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
 * The descriptor as each capability AUTHORS it: `registerEntry` is typed to
 * the concrete contribution shape `E` (e.g. `PluginSkillDef`), so the closure
 * body forwards `def` to its registry with no cast.
 */
interface TypedOverlayCapabilityDescriptor<E extends { id: string }> {
  manifestField: keyof PluginManifest
  registerEntry: (entry: E, ctx: { pluginId: string }) => void
  unregisterAllByPlugin: (pluginId: string) => number
  virtual?: true
}

/**
 * Capture the concrete contribution type `E` for one capability and widen the
 * descriptor to the loop-facing shape.
 *
 * This is the SINGLE variance bridge in the overlay-registry wiring (it
 * replaced eight scattered `as unknown as never` casts at the individual
 * register call sites). It is sound: the dispatch loop only ever calls
 * `registerEntry` with elements of `plugin.manifest[manifestField]`, whose
 * element type is exactly `E` — TypeScript just can't carry that link through
 * a `keyof PluginManifest` index, so we assert it once, here, with the link
 * documented, instead of at every call site.
 */
function defineOverlayCapability<E extends { id: string }>(
  descriptor: TypedOverlayCapabilityDescriptor<E>
): OverlayCapabilityDescriptor {
  return descriptor as unknown as OverlayCapabilityDescriptor
}

/**
 * The 5 capabilities whose enable/disable dispatch follows the
 * uniform overlay-registry shape. Adding a 6th overlay-registry
 * capability is a single map entry away from being picked up by the
 * dispatch loop — no manager surgery required.
 */
export const OVERLAY_REGISTRY_CAPABILITIES = {
  skills: defineOverlayCapability<PluginSkillDef>({
    manifestField: "skills",
    registerEntry: (def, ctx) => {
      // Skill defs pass through verbatim — the registry stores the
      // entire entry under its `id`. After registration we refresh any
      // character-pack `requires` warnings (ADR-0030): a pack that was
      // previously missing this skill id now has the dep available.
      // Also refresh agent-team-template warnings for the same reason.
      registerSkill(def.id, def, ctx)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterSkillsByPlugin(pluginId)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
      return n
    },
  }),
  "mcp-server-preset": defineOverlayCapability<PluginMcpServerPresetDef>({
    manifestField: "mcpServerPresets",
    registerEntry: (def, ctx) => {
      registerMcpServerPreset(def.id, def, ctx)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterMcpServerPresetsByPlugin(pluginId)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
      return n
    },
  }),
  "native-anthropic-tool": defineOverlayCapability<PluginNativeAnthropicToolDef>({
    manifestField: "nativeAnthropicTools",
    registerEntry: (def, ctx) => {
      registerNativeAnthropicTool(def.id, def, ctx)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterNativeAnthropicToolsByPlugin(pluginId)
      refreshAllPackWarnings()
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
      return n
    },
  }),
  "external-agent-preset": defineOverlayCapability<PluginExternalAgentPresetDef>({
    manifestField: "externalAgentPresets",
    registerEntry: (def, ctx) => {
      // External-agent presets historically destructured `id` out of
      // the def before forwarding — preserving that for a true
      // behaviour-preserving refactor. `PluginExternalAgentPresetDef`
      // extends `ExternalAgentPresetConfig` with just `id`, so the rest
      // is exactly the config the overlay expects (no cast needed).
      const { id, ...config } = def
      registerExternalAgentPresetOverlay(id, config, ctx)
      refreshAllTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterExternalAgentPresetsByPlugin(pluginId)
      refreshAllTemplateWarnings()
      return n
    },
  }),
  "character-pack": defineOverlayCapability<PluginCharacterPackDef>({
    // ADR-0030. Plugin contributes ready-to-use character bundles. Pack
    // defs flow through verbatim — the registry stores the entire entry
    // under its `id` (the pack id). Pack-local character ids are
    // separately resolved through `getPackCharacterByRuntimeId` when
    // `lib/db/characters.ts:resolveCharacterById` projects an overlay
    // synthetic id into a `Character` row.
    manifestField: "characterPacks",
    registerEntry: (def, ctx) => {
      registerCharacterPack(def.id, def, ctx)
      refreshAllTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterCharacterPacksByPlugin(pluginId)
      refreshAllTemplateWarnings()
      return n
    },
  }),
  subagent: defineOverlayCapability<PluginSubagentDef>({
    // Plugin contributes Claude SDK subagents callable by teams and the
    // workflow editor. Each entry mirrors the AgentDefinition shape; the
    // runtime resolution loop unions overlay entries with the 4 host-bundled
    // subagents under `<pluginId>:<id>` so dispatcher-name collisions are
    // impossible. Adding a subagent may unblock waiting agent-team-template
    // `requires.subagentIds[]` dependencies, so we refresh those warnings.
    manifestField: "subagents",
    registerEntry: (def, ctx) => {
      registerSubagent(def.id, def, ctx)
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
    },
    unregisterAllByPlugin: (pluginId) => {
      const n = unregisterSubagentsByPlugin(pluginId)
      refreshAllTemplateWarnings()
      refreshAllWorkflowTemplateWarnings()
      return n
    },
  }),
  "agent-team-template": defineOverlayCapability<PluginAgentTeamTemplateDef>({
    // Plugin contributes complete agent-team blueprints — roster, tasks,
    // config overrides, plus a `requires` block declaring cross-capability
    // dependencies. `registerAgentTeamTemplate` runs `validateTemplateRequires`
    // internally and stamps non-blocking warnings on the registry entry.
    // The team-templates settings UI reads them via `getTemplateWarnings`.
    manifestField: "agentTeamTemplates",
    registerEntry: (def, ctx) => {
      registerAgentTeamTemplate(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterAgentTeamTemplatesByPlugin,
  }),
  "shared-memory-adapter": defineOverlayCapability<PluginSharedMemoryAdapterDef>({
    // Plugin contributes a bidirectional backing store for agent-team shared
    // memory. Registered verbatim under its `id`; a team opts in via
    // `team.config.sharedMemoryAdapterId`. Registering/dropping one may flip a
    // team's `missing-shared-memory-adapter` audit warning, but that audit is
    // refreshed centrally in the manager disable flow, so no inline refresh
    // is needed here.
    manifestField: "sharedMemoryAdapters",
    registerEntry: (def, ctx) => {
      registerSharedMemoryAdapter(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterSharedMemoryAdaptersByPlugin,
  }),
  "workflow-template": defineOverlayCapability<PluginWorkflowTemplateDef>({
    // ADR-0017/0032. Plugin contributes complete visual-workflow blueprints —
    // nodes + edges + settings + a `requires` block declaring cross-capability
    // dependencies. `registerWorkflowTemplate` runs `validateWorkflowTemplateRequires`
    // internally and stamps non-blocking warnings; the editor Settings tab reads
    // them via `getWorkflowTemplateWarnings`.
    manifestField: "workflowTemplates",
    registerEntry: (def, ctx) => {
      registerWorkflowTemplate(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterWorkflowTemplatesByPlugin,
  }),
} as const satisfies Partial<Record<PluginCapability, OverlayCapabilityDescriptor>>

export type OverlayRegistryCapability = keyof typeof OVERLAY_REGISTRY_CAPABILITIES

/**
 * List of capabilities the dispatch loop must iterate, derived from
 * the map keys so a future addition automatically widens the loop.
 */
export const OVERLAY_REGISTRY_CAPABILITY_KEYS: ReadonlyArray<OverlayRegistryCapability> =
  Object.keys(OVERLAY_REGISTRY_CAPABILITIES) as ReadonlyArray<OverlayRegistryCapability>
