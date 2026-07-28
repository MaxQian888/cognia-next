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
  PluginManifestTrayItemDef,
} from "@/types/plugin"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"
import type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"
import type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"
import type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
import type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
import type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"
import {
  registerMcpServerPreset,
  unregisterMcpServerPresetsByPlugin,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import {
  registerNativeAnthropicTool,
  unregisterNativeAnthropicToolsByPlugin,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { registerSkill, unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import { rebaseSkillSource } from "@/lib/plugin/utils/rebase-skill-source"
import { replacePluginRootTokens } from "@/lib/plugin/utils/plugin-root-tokens"
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
  registerBalanceAdapter,
  unregisterBalanceAdaptersByPlugin,
} from "@/lib/plugin/registries/balance-adapter-registry"
import {
  registerLimitsSource,
  unregisterLimitsSourcesByPlugin,
} from "@/lib/plugin/registries/limits-source-registry"
import {
  registerImRateSource,
  unregisterImRateSourcesByPlugin,
} from "@/lib/plugin/registries/im-rate-source-registry"
import {
  registerCompactionStrategy,
  unregisterCompactionStrategiesByPlugin,
} from "@/lib/plugin/registries/compaction-strategy-registry"
import {
  refreshAllWorkflowTemplateWarnings,
  registerWorkflowTemplate,
  unregisterWorkflowTemplatesByPlugin,
} from "@/lib/plugin/registries/workflow-template-registry"
import {
  registerQuickAction,
  unregisterQuickActionsByPlugin,
} from "@/lib/plugin/registries/quick-action-registry"
import {
  registerViewContainer,
  unregisterViewContainersByPlugin,
} from "@/lib/plugin/registries/view-container-registry"
import {
  registerAuthenticationProvider,
  unregisterProvidersByPlugin,
} from "@/lib/plugin/auth/auth-provider-registry"
import {
  registerPetAchievement,
  unregisterPetAchievementsByPlugin,
} from "@/lib/plugin/registries/pet-achievement-registry"
import {
  registerPetItem,
  unregisterPetItemsByPlugin,
} from "@/lib/plugin/registries/pet-item-registry"
import type { PluginQuickActionDef, PluginAuthProviderDef } from "@/types/plugin"
import { registerTrayItem, unregisterTrayItemsByPlugin } from "@/lib/tray/registry"
import type { PluginPetAchievementDef, PluginPetItemDef } from "@/types/plugin/plugin-pet"

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
 * What the dispatch loop knows about the plugin whose contributions it is
 * registering. `installRoot` is the plugin's on-disk directory (empty for
 * built-ins, whose contributions never carry filesystem paths); descriptors
 * that store paths use it to anchor plugin-dir-relative values, mirroring
 * the `installRoot` the module-bridge dispatch already passes.
 */
export interface OverlayRegistrationContext {
  pluginId: string
  installRoot?: string
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
  registerEntry: (entry: OverlayContributionEntry, ctx: OverlayRegistrationContext) => void
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
  registerEntry: (entry: E, ctx: OverlayRegistrationContext) => void
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
      // `local-folder` / `local-bundle` / `archive` sources carry a
      // filesystem path that downstream consumers (`resolveSkillMarkdown`)
      // read with no knowledge of the owning plugin. Anchor it here, once,
      // so a plugin can ship `"skills/foo"` the way it already ships
      // `main` / `wasmMain` / `cliTools[].binary.relPath`. Throws on a
      // path that escapes the plugin dir — the dispatch loop isolates
      // per-entry failures, so only the offending skill is dropped.
      const anchored = rebaseSkillSource(def, ctx.installRoot ?? "")
      const bound = ctx.installRoot ? { ...anchored, runtimePluginRoot: ctx.installRoot } : anchored
      // The registry stores the entire entry under its `id`. After
      // registration we refresh any character-pack `requires` warnings
      // (ADR-0030): a pack that was previously missing this skill id now
      // has the dep available. Also refresh agent-team-template warnings
      // for the same reason.
      registerSkill(bound.id, bound, ctx)
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
      const bound = replacePluginRootTokens(def, ctx.installRoot ?? "")
      registerMcpServerPreset(bound.id, bound, ctx)
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
      const bound = replacePluginRootTokens(def, ctx.installRoot ?? "")
      registerSubagent(bound.id, bound, ctx)
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
  "balance-adapter": defineOverlayCapability<PluginBalanceAdapterDef>({
    // Plugin contributes a subscription balance adapter. Registered verbatim
    // under its `id`; `findBalanceAdapter` lists overlay adapters before the
    // built-in array so a plugin can extend or override the bundled set.
    manifestField: "balanceAdapters",
    registerEntry: (def, ctx) => {
      registerBalanceAdapter(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterBalanceAdaptersByPlugin,
  }),
  "limits-source": defineOverlayCapability<PluginLimitsSourceDef>({
    // Plugin contributes a unified subscription limits/usage source. Registered
    // verbatim under its `id`; `resolveLimitsSources` lists overlay sources
    // before the built-in array so a plugin can extend or override the bundled
    // set (Anthropic windows, Codex windows, credit balances).
    manifestField: "limitsSources",
    registerEntry: (def, ctx) => {
      registerLimitsSource(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterLimitsSourcesByPlugin,
  }),
  "im-rate-source": defineOverlayCapability<PluginImRateSourceDef>({
    // Plugin contributes a per-conversation IM send gate. Registered verbatim
    // under its `id`; the connector runtime's ai-run branch calls
    // `evaluateImRate`, which lists this overlay and returns the first block.
    manifestField: "imRateSources",
    registerEntry: (def, ctx) => {
      registerImRateSource(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterImRateSourcesByPlugin,
  }),
  "compaction-strategy": defineOverlayCapability<PluginCompactionStrategyDef>({
    // Plugin contributes a conversation-compaction strategy (declarative
    // summary prompt + threshold knobs). Registered verbatim under its `id`;
    // `resolveSendOptions` looks it up when the compaction settings select it
    // and threads its config into `SendOptions.compaction`.
    manifestField: "compactionStrategies",
    registerEntry: (def, ctx) => {
      registerCompactionStrategy(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterCompactionStrategiesByPlugin,
  }),
  "quick-action": defineOverlayCapability<PluginQuickActionDef>({
    // Quick actions surfaced in the command palette / composer menu / tray.
    // `registerQuickAction` mirrors each entry into the unified command
    // registry (dispatch handle) and the overlay registry (surface
    // metadata); `unregisterQuickActionsByPlugin` drops both.
    manifestField: "quickActions",
    registerEntry: (def, ctx) => {
      registerQuickAction(ctx.pluginId, def)
    },
    unregisterAllByPlugin: unregisterQuickActionsByPlugin,
  }),
  tray: defineOverlayCapability<PluginManifestTrayItemDef>({
    manifestField: "trayItems",
    registerEntry: (def, ctx) => {
      registerTrayItem({
        ...def,
        id: `${ctx.pluginId}:${def.id}`,
        pluginId: ctx.pluginId,
      })
    },
    unregisterAllByPlugin: unregisterTrayItemsByPlugin,
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
  "view-container": defineOverlayCapability<PluginViewContainerDef>({
    // B1. Rail-mounted view containers. `registerViewContainer` namespaces the
    // id to the plugin and notifies the rail; `unregisterViewContainersByPlugin`
    // drops every container the plugin contributed.
    manifestField: "viewsContainers",
    registerEntry: (def, ctx) => {
      registerViewContainer(def, ctx)
    },
    unregisterAllByPlugin: unregisterViewContainersByPlugin,
  }),
  "auth-provider": defineOverlayCapability<PluginAuthProviderDef>({
    // C1. The declarative `authProviders[]` entries are metadata (id + label
    // for validation / consent UI). On enable we pre-register a PLACEHOLDER
    // provider keyed by id; the plugin's activation replaces it (same id) with
    // the live object via `ctx.auth.registerProvider`. The placeholder makes
    // the declared provider visible immediately and ensures cleanup removes it
    // even if the plugin never activates the real one.
    manifestField: "authProviders",
    registerEntry: (def, ctx) => {
      registerAuthenticationProvider({
        id: def.id,
        label: def.label,
        pluginId: ctx.pluginId,
        getSessions: async () => [],
        createSession: async () => {
          throw new Error(`Auth provider "${def.id}" is declared but not yet activated.`)
        },
        removeSession: async () => {},
      })
    },
    unregisterAllByPlugin: unregisterProvidersByPlugin,
  }),
  "pet-achievement": defineOverlayCapability<PluginPetAchievementDef>({
    // Data-only pet achievements (condition DSL, compiled at check time by
    // lib/plugin/registries/pet-achievement-registry.ts). Ids namespace as
    // `plugin:<pluginId>:<id>` inside the compiled view, so unlock records
    // can't collide with the static PET_ACHIEVEMENTS.
    manifestField: "petAchievements",
    registerEntry: (def, ctx) => {
      registerPetAchievement(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterPetAchievementsByPlugin,
  }),
  "pet-item": defineOverlayCapability<PluginPetItemDef>({
    // Data-only pet shop items, unioned into the host catalog static-first
    // (lib/pet/economy/item-catalog.ts listAllPetItems/getPetItem).
    manifestField: "petItems",
    registerEntry: (def, ctx) => {
      registerPetItem(def.id, def, ctx)
    },
    unregisterAllByPlugin: unregisterPetItemsByPlugin,
  }),
} as const satisfies Partial<Record<PluginCapability, OverlayCapabilityDescriptor>>

export type OverlayRegistryCapability = keyof typeof OVERLAY_REGISTRY_CAPABILITIES

/**
 * List of capabilities the dispatch loop must iterate, derived from
 * the map keys so a future addition automatically widens the loop.
 */
export const OVERLAY_REGISTRY_CAPABILITY_KEYS: ReadonlyArray<OverlayRegistryCapability> =
  Object.keys(OVERLAY_REGISTRY_CAPABILITIES) as ReadonlyArray<OverlayRegistryCapability>
