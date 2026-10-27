/** Pure identity/capability contribution; no runtime or Node bridge imports. */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"
import { EXTERNAL_AGENT_CAPABILITY_IDS } from "@cognia/agent-contracts/external-agent-capability"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"

export const CODEBUFF_PROTOCOL = "codebuff-sdk"
export const CODEBUFF_EXECUTION_SEMANTICS: AgentExecutionSemantics = {
  cancel: { scope: "process", reconnectsAfterCancel: true },
  resume: "history-replay",
  fork: "unsupported",
  approvals: "per-tool-call",
  processModel: "per-session",
}
export const codebuffManifest: AgentIntegrationManifest = {
  ecosystem: {
    id: "codebuff",
    runtimeIds: ["codebuff"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  protocols: [{ protocol: CODEBUFF_PROTOCOL, semantics: CODEBUFF_EXECUTION_SEMANTICS }],
  runtimes: [
    {
      runtimeId: "codebuff",
      bundledBridgeId: "codebuff",
      presetIds: ["codebuff"],
      displayName: "Codebuff SDK",
      ownership: "system",
      protocol: CODEBUFF_PROTOCOL,
      transport: "stdio",
      platforms: ["darwin", "linux"],
      systemCommand: "node",
      launchArgs: [],
      versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      supportedRange: ">=26.0.0",
      certifiedVersions: [],
      distributions: [],
      sandbox: { required: true, windowsExceptionEligible: false },
      docsUrl: "https://www.codebuff.com/docs/advanced/sdk",
    },
  ],
}
const supported = new Set([
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.results",
  "permissions.interrupt-resume",
  "thinking",
  "upstream-errors",
  "stream-interruption",
  "session.store",
  "session.manage",
])
export const CODEBUFF_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    [CODEBUFF_PROTOCOL]: {
      label: "Codebuff SDK",
      note: "Official SDK in a separate Node bridge; host-brokered permissions/network and persisted SDK RunState. Unsupported MCP is rejected.",
      capabilities: Object.fromEntries(
        EXTERNAL_AGENT_CAPABILITY_IDS.map((id) => [
          id,
          {
            level: supported.has(id)
              ? id.startsWith("session.")
                ? "equivalent"
                : "native"
              : "unsupported",
            evidence: "adapter-code",
            ...(supported.has(id)
              ? id.startsWith("session.")
                ? { reasonKey: "codebuffSdkBridge" }
                : {}
              : { reasonKey: "noProtocolSlot" }),
          },
        ])
      ) as ExternalAgentCapabilityMatrix,
    },
  },
}
