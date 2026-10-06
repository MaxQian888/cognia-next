/**
 * The agent ecosystem rows. See `./types` for why this table exists and what
 * it deliberately does not store.
 *
 * Keyed by ecosystem rather than by runtime id because the two do not
 * correspond: Codex has two catalogued runtimes and OpenCode has four, while
 * one Codex session history and one OpenCode config directory serve all of
 * them. A runtime-keyed table would have had to pick an arbitrary runtime to
 * hang `sessionSourceIds` on.
 */

import { aiderManifest } from "@cognia/agent-aider/manifest"
import { codexManifest } from "@cognia/agent-codex/manifest"
import { deepseekHarnessManifest } from "@cognia/agent-dsh/manifest"
import { opencodeManifest } from "@cognia/agent-opencode/manifest"
import { piManifest } from "@cognia/agent-pi/manifest"

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { AgentEcosystemEntry } from "./types"

/**
 * The integration packages that own ecosystem rows and runtime catalog rows.
 * `AGENT_ECOSYSTEMS` lists their rows and the runtime catalog generator writes
 * their runtimes (`./runtime-catalog`).
 */
export const INTEGRATION_MANIFESTS: readonly AgentIntegrationManifest[] = [
  aiderManifest,
  codexManifest,
  deepseekHarnessManifest,
  opencodeManifest,
  piManifest,
]

export const AGENT_ECOSYSTEMS: readonly AgentEcosystemEntry[] = [
  {
    // Native session management is negotiated over ACP; no portable importer is claimed.
    id: "kimi",
    runtimeIds: ["kimi"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    // Launch-only over ACP: no portable session format or config to import.
    id: "goose",
    runtimeIds: ["goose"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "qoder",
    runtimeIds: ["qoder"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "devin",
    runtimeIds: ["devin"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "claude-code",
    runtimeIds: ["claude-agent-acp"],
    sessionSourceIds: ["claude-code"],
    migrationVendor: "claude-code",
    vendorRootKeys: ["claudeConfigDir"],
    configRootKey: "claudeConfigDir",
    probeRootKeys: ["claudeConfigDir"],
    pluginEcosystem: "claude-code",
    subagentSourceId: "claude-code",
    memoryAgentId: "claude-code",
  },
  codexManifest.ecosystem,
  opencodeManifest.ecosystem,
  piManifest.ecosystem,
  {
    id: "gemini-cli",
    runtimeIds: ["gemini-cli"],
    sessionSourceIds: ["gemini-cli"],
    migrationVendor: null,
    vendorRootKeys: ["geminiDir"],
    configRootKey: "geminiDir",
    probeRootKeys: ["geminiDir"],
    pluginEcosystem: "gemini-cli",
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "cursor",
    runtimeIds: ["cursor-agent"],
    sessionSourceIds: ["cursor"],
    migrationVendor: null,
    vendorRootKeys: ["cursorDir"],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: "cursor",
    memoryAgentId: null,
  },
  {
    id: "copilot-cli",
    runtimeIds: ["copilot-cli"],
    sessionSourceIds: ["copilot-cli"],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "qwen-code",
    runtimeIds: ["qwen-code"],
    sessionSourceIds: ["qwen-code"],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    // Native CLI execution complements the existing portable history/subagent importers.
    id: "cline",
    runtimeIds: ["cline"],
    sessionSourceIds: ["cline"],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: "cline",
    memoryAgentId: null,
  },
  {
    id: "continue-dev",
    runtimeIds: [],
    sessionSourceIds: ["continue-dev"],
    migrationVendor: null,
    vendorRootKeys: ["continueDir"],
    configRootKey: "continueDir",
    probeRootKeys: ["continueDir"],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  aiderManifest.ecosystem,
  {
    // Launchable, but no public session format to import. ADR-0062 records
    // Kiro, Droid and DeepSeek Harness as deliberately out of import scope.
    id: "kiro",
    runtimeIds: ["kiro-cli"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  {
    id: "droid",
    runtimeIds: ["droid"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  // Integration packages own their rows (ADR-0217); this table lists them.
  deepseekHarnessManifest.ecosystem,
]

export function findEcosystemById(id: string): AgentEcosystemEntry | undefined {
  return AGENT_ECOSYSTEMS.find((entry) => entry.id === id)
}

export function findEcosystemByRuntimeId(runtimeId: string): AgentEcosystemEntry | undefined {
  return AGENT_ECOSYSTEMS.find((entry) => entry.runtimeIds.includes(runtimeId))
}

export function findEcosystemBySessionSource(sourceId: string): AgentEcosystemEntry | undefined {
  return AGENT_ECOSYSTEMS.find((entry) => entry.sessionSourceIds.includes(sourceId))
}

export function findEcosystemByMigrationVendor(vendor: string): AgentEcosystemEntry | undefined {
  return AGENT_ECOSYSTEMS.find((entry) => entry.migrationVendor === vendor)
}

/**
 * The primary runtime id for a migration vendor, or null.
 *
 * Null for a vendor with no launchable runtime, which is a real state rather
 * than an error: a user can import Aider history without Cognia ever being
 * able to run Aider.
 */
export function primaryRuntimeIdForMigrationVendor(vendor: string): string | null {
  return findEcosystemByMigrationVendor(vendor)?.runtimeIds[0] ?? null
}

/** Ordered install-detection roots for a migration vendor. */
export function probeRootKeysForMigrationVendor(vendor: string): readonly string[] {
  return findEcosystemByMigrationVendor(vendor)?.probeRootKeys ?? []
}

/** Where a migration vendor keeps user-level config, agents and commands. */
export function configRootKeyForMigrationVendor(vendor: string): string | null {
  return findEcosystemByMigrationVendor(vendor)?.configRootKey ?? null
}

/** The subagent importer id for a migration vendor, or null when it has none. */
export function subagentSourceIdForMigrationVendor(vendor: string): string | null {
  return findEcosystemByMigrationVendor(vendor)?.subagentSourceId ?? null
}
