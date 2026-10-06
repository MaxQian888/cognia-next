/**
 * DeepSeek Harness integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the SDK runtime adapter, the process
 * transport or the installer.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
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
