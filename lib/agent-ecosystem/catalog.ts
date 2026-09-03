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

import type { AgentEcosystemEntry } from "./types"

export const AGENT_ECOSYSTEMS: readonly AgentEcosystemEntry[] = [
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
  {
    // ACP first: `VENDOR_RUNTIME` resolved codex to the `codex` preset, which
    // the ACP adapter owns. Listing the app-server first would silently change
    // which connection the post-migration offer creates.
    id: "codex",
    runtimeIds: ["codex-acp", "codex-app-server"],
    sessionSourceIds: ["codex"],
    migrationVendor: "codex",
    vendorRootKeys: ["codexHome"],
    configRootKey: "codexHome",
    probeRootKeys: ["codexHome"],
    pluginEcosystem: "codex",
    subagentSourceId: "codex-cli",
    memoryAgentId: "codex",
  },
  {
    id: "opencode",
    runtimeIds: ["opencode", "opencode-acp", "opencode-remote", "opencode-v2-service"],
    sessionSourceIds: ["opencode"],
    migrationVendor: "opencode",
    vendorRootKeys: ["opencodeDataDir", "opencodeConfigDir", "opencodePlatformDataDir"],
    // Config and history live apart. `configRootKey` feeds the subagent and
    // command scans, `probeRootKeys` feeds install detection, and the probe
    // order preserves the original `opencodeDataDir || opencodeConfigDir`.
    configRootKey: "opencodeConfigDir",
    probeRootKeys: ["opencodeDataDir", "opencodeConfigDir"],
    pluginEcosystem: null,
    subagentSourceId: "opencode",
    memoryAgentId: "opencode",
  },
  {
    id: "pi",
    runtimeIds: ["pi"],
    sessionSourceIds: ["pi"],
    migrationVendor: "pi",
    vendorRootKeys: ["piAgentDir", "piSessionDir"],
    configRootKey: "piAgentDir",
    probeRootKeys: ["piAgentDir"],
    pluginEcosystem: null,
    subagentSourceId: "pi",
    memoryAgentId: "pi",
  },
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
    vendorRootKeys: [],
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
    // History import only. Cursor, Cline and Copilot CLI share the canonical
    // portable-agent store, but only Cline has a subagent importer.
    id: "cline",
    runtimeIds: [],
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
  {
    // Picker-only. Aider keeps `.aider.chat.history.md` per repository, so it
    // has no machine-wide root a scan could find.
    id: "aider",
    runtimeIds: [],
    sessionSourceIds: ["aider"],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
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
  {
    id: "deepseek-harness",
    runtimeIds: ["deepseek-harness"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
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
