/**
 * The mapping layer between the agent-facing subsystems.
 *
 * Eight vocabularies name the same third-party coding agents, each owned by a
 * different subsystem: session sources (`lib/session-import/registry.ts`),
 * migration vendors (`lib/agent-migration/types.ts`), external-agent runtimes
 * and presets (`protocol/external-agent-runtimes.json`), `VendorRoots`
 * (`lib/agent-roots`), plugin ecosystems (`lib/plugin/convert/ecosystem.ts`),
 * subagent importer ids (`lib/claude/subagent-importers`), and external memory
 * agent ids (`lib/memory/external/types.ts`). Nothing used to relate them but
 * two hand-written maps that had already drifted apart. `VENDOR_RUNTIME` in
 * `lib/onboarding/scan.ts` claimed Pi's preset was `"pi"`, which is a
 * *runtimeId*, not a preset id, so an installed Pi resolved to nothing.
 *
 * This module stores ONLY the cross-references. It deliberately does not carry
 * display names or preset ids: `protocol/external-agent-runtimes.json` is
 * already the gated source of truth for those, and a second copy would just be
 * the next thing to drift. Read them through `./runtime-link`.
 *
 * It also does not carry the migration capability matrix. `SUPPORT` in
 * `lib/agent-migration/providers.ts` owns which artifacts a vendor can import,
 * and it fails closed by construction.
 *
 * Type-only imports, on purpose: this file and `./catalog` stay leaves so the
 * consumers that must remain testable in the fast `node` Jest project (notably
 * `lib/onboarding/scan.ts`) can depend on them without dragging a registry in.
 */

/** One third-party agent ecosystem and everything the app knows it by. */
export interface AgentEcosystemEntry {
  /** Stable ecosystem id, distinct from every other subsystem's id below. */
  id: string
  /**
   * Runtime ids in `protocol/external-agent-runtimes.json`, primary first.
   *
   * The primary is the surface a user most likely wants when the app offers to
   * connect this agent, and it is what `presetIdsForEcosystem` resolves. Codex
   * lists the ACP adapter first and the app-server second so the connection
   * offered after a migration stays the one the old `VENDOR_RUNTIME` produced.
   *
   * Empty when the ecosystem has history to import but nothing Cognia can
   * launch (Cline, Continue, Aider).
   */
  runtimeIds: readonly string[]
  /** Session-history source ids in `lib/session-import/registry.ts`. */
  sessionSourceIds: readonly string[]
  /** `MIGRATION_VENDORS` member, or null when config migration is unsupported. */
  migrationVendor: string | null
  /** Every `VendorRoots` key this ecosystem owns. Drives the coverage check. */
  vendorRootKeys: readonly string[]
  /**
   * Where user-level config, agents and commands live.
   *
   * OpenCode splits these. Config sits under `opencodeConfigDir` while session
   * history sits under `opencodeDataDir`. Collapsing the two into one ordered
   * list would have silently pointed the subagent scan at the data directory.
   */
  configRootKey: string | null
  /** Install-detection roots, ordered. The first non-empty one is used. */
  probeRootKeys: readonly string[]
  /** `PluginEcosystem` member when this agent has a convertible plugin format. */
  pluginEcosystem: string | null
  /** `SubagentSourceId` for `lib/claude/subagent-importers`. */
  subagentSourceId: string | null
  /** `ExternalAgentId` for `lib/memory/external`. */
  memoryAgentId: string | null
}

/** True when the entry can be offered as a launchable external agent. */
export function hasLaunchableRuntime(entry: AgentEcosystemEntry): boolean {
  return entry.runtimeIds.length > 0
}

/** True when the entry participates in the ADR-0107 migration wizard. */
export function isMigratable(entry: AgentEcosystemEntry): boolean {
  return entry.migrationVendor !== null
}
