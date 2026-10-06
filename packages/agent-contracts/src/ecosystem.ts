/**
 * Agent ecosystem identity and integration manifests (ADR-0217).
 *
 * Eight vocabularies name the same third-party coding agents, each owned by a
 * different subsystem: session sources, migration vendors, external-agent
 * runtimes and presets (`protocol/external-agent-runtimes.json`), vendor
 * roots, plugin ecosystems, subagent importer ids and external memory agent
 * ids. An {@link AgentEcosystemEntry} stores only the cross-references between
 * them; display names and preset ids stay in the gated runtime catalog.
 *
 * Each integration package exports an {@link AgentIntegrationManifest}. The
 * host's ecosystem table is the explicit list of the manifests it registers,
 * so adding an ecosystem edits its own package and that one list.
 */

import type { ExternalAgentRuntimeCatalogEntry } from "./external-agent-lifecycle"
import type { AgentExecutionSemantics } from "./semantics"

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

/**
 * One protocol an integration implements an adapter for, with what its
 * cancel/resume/fork/approval/process behaviour actually is. Preset
 * refinements cover presets that run the same protocol differently.
 */
export interface AgentProtocolIntegration {
  /** Protocol id the host registers the adapter under (`dsh-sdk`, `codex-app-server`). */
  protocol: string
  semantics: AgentExecutionSemantics
  presetSemantics?: Readonly<Record<string, AgentExecutionSemantics>>
}

/** What an integration package declares about itself. Declaring grants nothing. */
export interface AgentIntegrationManifest {
  ecosystem: AgentEcosystemEntry
  /** Protocols this package ships adapters for (empty for catalog-only ecosystems). */
  protocols: readonly AgentProtocolIntegration[]
  /**
   * The runtime catalog rows this package owns, one per `ecosystem.runtimeIds`
   * entry. The host's catalog generator writes them into its runtime catalog
   * (Cognia: `protocol/external-agent-runtimes.json`) and fails on drift, so
   * the package is the only place a row is edited. Declaring a row grants
   * nothing: the spawn allowlist and security policy stay the host's.
   */
  runtimes?: readonly ExternalAgentRuntimeCatalogEntry[]
  /**
   * Why a runtime of this package still launches through a network-resolving
   * package runner, by runtime id. Each entry is a known governance hole that
   * may only be removed by pinning the launch.
   */
  unpinnedLaunchWaivers?: Readonly<Record<string, string>>
}

/** The semantics a preset runs with under one protocol integration. */
export function semanticsForPreset(
  integration: AgentProtocolIntegration,
  presetId: string | undefined
): AgentExecutionSemantics {
  return (presetId && integration.presetSemantics?.[presetId]) || integration.semantics
}
