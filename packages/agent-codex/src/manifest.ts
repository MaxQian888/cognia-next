/**
 * Codex integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the app-server adapter, the history
 * parser or any process code.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * `turn/interrupt` stops one turn by id; the thread and the shared app-server
 * process keep running. Resume is native (`thread/resume`); a fork is native
 * but only at a completed turn boundary (typed forks need Codex ≥ 0.159.2).
 * Command, file and permission approvals arrive one call at a time.
 */
export const CODEX_APP_SERVER_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "native",
  fork: "native-turn-boundary",
  approvals: "per-tool-call",
  processModel: "shared",
}) as AgentExecutionSemantics

export const CODEX_ECOSYSTEM_ID = "codex"
export const CODEX_APP_SERVER_PROTOCOL = "codex-app-server"
/** The session-history source id Codex rollouts are imported under. */
export const CODEX_SESSION_SOURCE_ID = "codex"

/**
 * Codex's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes them
 * into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const CODEX_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "codex-app-server",
    presetIds: ["codex-app-server"],
    displayName: "OpenAI Codex (app-server)",
    ownership: "system",
    protocol: "codex-app-server",
    transport: "stdio",
    platforms: ["darwin", "linux", "win32"],
    systemCommand: "codex",
    launchArgs: ["app-server"],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    supportedRange: ">=0.149.0",
    certifiedVersions: ["0.150.1"],
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: true,
    },
    docsUrl: "https://developers.openai.com/codex/app-server",
  },
  {
    runtimeId: "codex-acp",
    presetIds: ["codex", "codex-acp"],
    displayName: "Codex ACP adapter",
    ownership: "system",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin", "linux", "win32"],
    systemCommand: "npx",
    launchArgs: ["-y", "@agentclientprotocol/codex-acp"],
    versionProbe: {
      args: ["-y", "@agentclientprotocol/codex-acp", "--version"],
      parser: "semver-anywhere",
      timeoutMs: 20000,
    },
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: true,
    },
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
    notes: {
      certification:
        "Deliberately uncertified. This runtime launches through `npx -y @agentclientprotocol/codex-acp`, which re-resolves the package on every start, so a pinned supportedRange would describe a version that is not necessarily what launches. See unpinnedLaunchWaivers.",
    },
  },
]

export const codexManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: CODEX_ECOSYSTEM_ID,
    // ACP first: `VENDOR_RUNTIME` resolved codex to the `codex` preset, which
    // the ACP adapter owns. Listing the app-server first would silently change
    // which connection the post-migration offer creates.
    runtimeIds: ["codex-acp", "codex-app-server"],
    sessionSourceIds: [CODEX_SESSION_SOURCE_ID],
    migrationVendor: "codex",
    vendorRootKeys: ["codexHome"],
    configRootKey: "codexHome",
    probeRootKeys: ["codexHome"],
    pluginEcosystem: "codex",
    subagentSourceId: "codex-cli",
    memoryAgentId: "codex",
  }),
  // The `codex-acp` runtime speaks plain ACP; its adapter belongs to the ACP
  // integration. This package ships the app-server adapter.
  protocols: [
    { protocol: CODEX_APP_SERVER_PROTOCOL, semantics: CODEX_APP_SERVER_EXECUTION_SEMANTICS },
  ],
  runtimes: CODEX_RUNTIMES,
  unpinnedLaunchWaivers: {
    "codex-acp":
      "Maintained Codex ACP app-server adapter. No vetted lock asset has been curated for a pinned version yet; the preset keeps `npx -y @agentclientprotocol/codex-acp` until one is.",
  },
}) as AgentIntegrationManifest
