/**
 * Aider integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the CLI adapter or the history reader.
 */

import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
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

/**
 * Aider's capability rows. `pnpm gen:agent-capabilities` writes them into
 * `protocol/agent-capabilities.json`; edit them here, never there.
 */
export const AIDER_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    "aider-cli": {
      label: "Aider official CLI",
      note: "One-shot official CLI with Cognia-owned per-session history and read-only/automatic launch modes. Text output only; no structured tool approvals, MCP, native session protocol, cold history discovery or native thinking controls. Resume reopens Cognia history rather than a provider-owned session.",
      capabilities: {
        streaming: {
          level: "native",
          evidence: "adapter-code",
        },
        "session.multi-turn": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "session.resume": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "tools.ordinary": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "tools.parallel": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "tools.fragmented-json": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "tools.results": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "tools.errors": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        mcp: {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "permissions.interrupt-resume": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "permissions.set-mode": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "prompt-caching": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        thinking: {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "context-management": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        // The adapter writes each inline image beside the repo and adds it to
        // the turn's files, which Aider hands a vision model as an image.
        images: {
          level: "native",
          evidence: "adapter-code",
        },
        "beta-features": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "rate-limit-handling": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "upstream-errors": {
          level: "native",
          evidence: "adapter-code",
        },
        "stream-interruption": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "subagents.native": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        steer: {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "set-model": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        checkpoint: {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        compaction: {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "output.structured": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "session.store": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "session.manage": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "aiderCliBridge",
        },
        "permissions.update-rules": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "hooks.lifecycle": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "input.elicitation": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "input.dialog": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "plugins.native": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "skills.native": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "mcp.dynamic": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "subagents.manage": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "tasks.background": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "commands.dynamic": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "sandbox.native": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "observability.child": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "startup.prewarm": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "mcp.logs": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "rate-limit-reporting": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "subagents.model-selection": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "models.list": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
        "web.search": {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: "noProtocolSlot",
        },
      },
    },
  },
}
