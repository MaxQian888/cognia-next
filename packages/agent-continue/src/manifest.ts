/** Pure identity/capability contribution; no runtime or Node bridge imports. */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"
import { EXTERNAL_AGENT_CAPABILITY_IDS } from "@cognia/agent-contracts/external-agent-capability"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"

export const CONTINUE_PROTOCOL = "continue-cli"
export const CONTINUE_EXECUTION_SEMANTICS: AgentExecutionSemantics = {
  cancel: { scope: "turn", reconnectsAfterCancel: false },
  resume: "history-replay",
  fork: "unsupported",
  approvals: "profile-fixed",
  processModel: "per-turn",
}
export const continueDevManifest: AgentIntegrationManifest = {
  ecosystem: {
    id: "continue-dev",
    runtimeIds: ["continue-dev"],
    sessionSourceIds: ["continue-dev"],
    migrationVendor: null,
    vendorRootKeys: ["continueDir"],
    configRootKey: "continueDir",
    probeRootKeys: ["continueDir"],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  protocols: [{ protocol: CONTINUE_PROTOCOL, semantics: CONTINUE_EXECUTION_SEMANTICS }],
  runtimes: [
    {
      runtimeId: "continue-dev",
      presetIds: ["continue-dev"],
      displayName: "Continue CLI",
      ownership: "system",
      protocol: CONTINUE_PROTOCOL,
      transport: "stdio",
      platforms: ["darwin", "linux"],
      systemCommand: "cn",
      launchArgs: [],
      versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      supportedRange: ">=1.5.47 <1.6.0",
      certifiedVersions: [],
      distributions: [],
      sandbox: { required: true, windowsExceptionEligible: false },
      docsUrl: "https://docs.continue.dev/cli/quickstart",
    },
  ],
}
const supported = new Set([
  "session.multi-turn",
  "session.resume",
  "upstream-errors",
  "stream-interruption",
  "output.structured",
  "session.store",
  "session.manage",
])
export const CONTINUE_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    [CONTINUE_PROTOCOL]: {
      label: "Continue CLI",
      note: "Published headless JSON output with host history replay and fixed readonly/automatic permissions. No native tool-event or approval channel.",
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
                ? { reasonKey: "continueCliBridge" }
                : {}
              : { reasonKey: "noProtocolSlot" }),
          },
        ])
      ) as ExternalAgentCapabilityMatrix,
    },
  },
}
