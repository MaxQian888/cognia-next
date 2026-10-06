/**
 * DeepSeek Harness integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the SDK runtime adapter, the process
 * transport or the installer.
 */

import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * The SDK runtime has no prompt-cancel method on the wire, so cancelling a
 * turn retires that session's runtime process. Each session owns its process
 * (SDK MCP configuration is fixed at startup), so other sessions are
 * untouched, but the cancelled session cannot continue and cannot be resumed.
 * Authority is fixed by the composition at launch: per-call approval answers
 * are refused.
 */
export const DSH_SDK_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "process", reconnectsAfterCancel: true }),
  resume: "unsupported",
  fork: "unsupported",
  approvals: "profile-fixed",
  processModel: "per-session",
}) as AgentExecutionSemantics

export const DSH_ECOSYSTEM_ID = "deepseek-harness"
export const DSH_SDK_PROTOCOL = "dsh-sdk"

/**
 * DeepSeek Harness's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes them
 * into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const DSH_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "deepseek-harness",
    presetIds: ["deepseek-harness-readonly", "deepseek-harness-workspace", "deepseek-harness-acp"],
    displayName: "DeepSeek Harness (managed runtime)",
    ownership: "managed",
    protocol: "dsh-sdk",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 15000,
    },
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  },
]

export const deepseekHarnessManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: DSH_ECOSYSTEM_ID,
    runtimeIds: ["deepseek-harness"],
    // ADR-0062 records DeepSeek Harness as deliberately out of import scope:
    // launchable, but no public session format to import.
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  }),
  protocols: [{ protocol: DSH_SDK_PROTOCOL, semantics: DSH_SDK_EXECUTION_SEMANTICS }],
  runtimes: DSH_RUNTIMES,
}) as AgentIntegrationManifest

/**
 * DeepSeek Harness's capability rows. `pnpm gen:agent-capabilities` writes them into
 * `protocol/agent-capabilities.json`; edit them here, never there.
 */
export const DSH_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    "dsh-sdk": {
      label: "DeepSeek Harness stdio JSON-RPC SDK runtime",
      note: "The SDK transport is observation-rich but cannot carry a mid-turn approval; see `dsh-sdk-client.ts`.",
      capabilities: {
        streaming: {
          level: "native",
          evidence: "protocol-spec",
        },
        "session.multi-turn": {
          level: "native",
          evidence: "protocol-spec",
        },
        "session.resume": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "tools.ordinary": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.parallel": {
          level: "unknown",
          evidence: "none",
        },
        "tools.fragmented-json": {
          level: "unknown",
          evidence: "none",
        },
        "tools.results": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        mcp: {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "launchTimeAuthorityOnly",
        },
        "permissions.interrupt-resume": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noMidTurnApproval",
        },
        "permissions.set-mode": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "launchTimeAuthorityOnly",
        },
        "prompt-caching": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        thinking: {
          level: "native",
          evidence: "protocol-spec",
        },
        "context-management": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        images: {
          level: "unknown",
          evidence: "none",
        },
        "beta-features": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "rate-limit-handling": {
          level: "unknown",
          evidence: "none",
        },
        "upstream-errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        "stream-interruption": {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "cancelKillsRuntime",
        },
        "subagents.native": {
          level: "native",
          evidence: "protocol-spec",
        },
        steer: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "set-model": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "launchTimeAuthorityOnly",
        },
        checkpoint: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        compaction: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "output.structured": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "session.store": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "session.manage": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "permissions.update-rules": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "hooks.lifecycle": {
          level: "unknown",
          evidence: "none",
        },
        "input.elicitation": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "input.dialog": {
          level: "unknown",
          evidence: "none",
        },
        "plugins.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        "skills.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "mcp.dynamic": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "subagents.manage": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "tasks.background": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "commands.dynamic": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "sandbox.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "observability.child": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "startup.prewarm": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "mcp.logs": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "agentOwned",
        },
        "rate-limit-reporting": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "sidecarOnly",
        },
        "subagents.model-selection": {
          level: "unknown",
          evidence: "none",
        },
        "models.list": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "web.search": {
          level: "unknown",
          evidence: "none",
        },
      },
    },
  },
  presetRefinements: {
    "deepseek-harness-acp": {
      protocol: "acp",
      note: "Current ACP publishes committed text, reasoning and tool updates, supports per-session MCP and persisted session list/resume/close.",
      capabilities: {
        streaming: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "committedRepliesOnly",
        },
        thinking: {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.ordinary": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.results": {
          level: "native",
          evidence: "protocol-spec",
        },
      },
    },
  },
}
