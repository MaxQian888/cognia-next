/**
 * Claude Code integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the history reader. Claude Code runs over
 * ACP through `@cognia/agent-acp`, which owns the protocol semantics, so this
 * manifest declares no protocol of its own.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"

export const CLAUDE_CODE_ECOSYSTEM_ID = "claude-code"
/** The session-history source id Claude Code transcripts are imported under. */
export const CLAUDE_CODE_SESSION_SOURCE_ID = "claude-code"
/** The preset that resumes an imported Claude Code session. */
export const CLAUDE_CODE_PRESET_ID = "claude-code"

/**
 * Claude Code's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes
 * them into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const CLAUDE_CODE_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "claude-agent-acp",
    presetIds: [CLAUDE_CODE_PRESET_ID],
    displayName: "Claude Code ACP adapter",
    ownership: "system",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin", "linux", "win32"],
    systemCommand: "claude-agent-acp",
    launchArgs: [],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: true,
    },
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
]

export const claudeCodeManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: CLAUDE_CODE_ECOSYSTEM_ID,
    runtimeIds: ["claude-agent-acp"],
    sessionSourceIds: [CLAUDE_CODE_SESSION_SOURCE_ID],
    migrationVendor: "claude-code",
    vendorRootKeys: ["claudeConfigDir"],
    configRootKey: "claudeConfigDir",
    probeRootKeys: ["claudeConfigDir"],
    pluginEcosystem: "claude-code",
    subagentSourceId: "claude-code",
    memoryAgentId: "claude-code",
  }),
  protocols: [],
  runtimes: CLAUDE_CODE_RUNTIMES,
}) as AgentIntegrationManifest
