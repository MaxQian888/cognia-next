/**
 * Aider integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the CLI adapter or the history reader.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * One official CLI process per turn. Cancelling kills only that turn's
 * process; the session's chat, input and prompt files stay, so the next turn
 * starts a fresh process on the same history without a reconnect. Aider has
 * no session id of its own: a resumed session is Aider replaying the
 * Cognia-owned chat file (`--restore-chat-history`), never a native resume.
 * There is no approval channel; the CLI runs `--yes-always` inside the host
 * sandbox, and plan mode is enforced by `--chat-mode ask --dry-run`.
 */
export const AIDER_CLI_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "history-replay",
  fork: "unsupported",
  approvals: "none",
  processModel: "per-turn",
}) as AgentExecutionSemantics

export const AIDER_ECOSYSTEM_ID = "aider"
export const AIDER_CLI_PROTOCOL = "aider-cli"
/** The session-history source id Aider chat files are imported under. */
export const AIDER_SESSION_SOURCE_ID = "aider"

/**
 * Aider's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes them
 * into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const AIDER_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "aider",
    presetIds: ["aider"],
    displayName: "Aider",
    ownership: "system",
    protocol: "aider-cli",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    systemCommand: "aider",
    launchArgs: [],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    supportedRange: ">=0.86.2 <0.87.0",
    certifiedVersions: ["0.86.2"],
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://aider.chat/docs/install.html",
  },
]

export const aiderManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    // Aider runs through its official CLI; imported histories remain per repo.
    id: AIDER_ECOSYSTEM_ID,
    runtimeIds: ["aider"],
    sessionSourceIds: [AIDER_SESSION_SOURCE_ID],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  }),
  protocols: [{ protocol: AIDER_CLI_PROTOCOL, semantics: AIDER_CLI_EXECUTION_SEMANTICS }],
  runtimes: AIDER_RUNTIMES,
}) as AgentIntegrationManifest
