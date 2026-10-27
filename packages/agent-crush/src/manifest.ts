/** Pure identity/capability contribution; no runtime or Node bridge imports. */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"
import { EXTERNAL_AGENT_CAPABILITY_IDS } from "@cognia/agent-contracts/external-agent-capability"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"

export const CRUSH_PROTOCOL = "crush-http"
export const CRUSH_EXECUTION_SEMANTICS: AgentExecutionSemantics = {
  cancel: { scope: "turn", reconnectsAfterCancel: false },
  resume: "native",
  fork: "unsupported",
  approvals: "per-tool-call",
  processModel: "per-session",
}
export const crushManifest: AgentIntegrationManifest = {
  ecosystem: {
    id: "crush",
    runtimeIds: ["crush"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  protocols: [{ protocol: CRUSH_PROTOCOL, semantics: CRUSH_EXECUTION_SEMANTICS }],
  runtimes: [
    {
      runtimeId: "crush",
      presetIds: ["crush"],
      displayName: "Crush (Charm)",
      ownership: "system",
      protocol: CRUSH_PROTOCOL,
      transport: "http",
      platforms: ["darwin", "linux"],
      systemCommand: "crush",
      launchArgs: ["server"],
      versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      supportedRange: ">=0.98.2 <0.99.0",
      certifiedVersions: [],
      distributions: [],
      sandbox: { required: true, windowsExceptionEligible: false },
      docsUrl: "https://github.com/charmbracelet/crush",
    },
  ],
}
const supported = new Set([
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.results",
  "tools.errors",
  "permissions.interrupt-resume",
  "thinking",
  "upstream-errors",
  "stream-interruption",
  "session.store",
  "session.manage",
])
export const CRUSH_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    [CRUSH_PROTOCOL]: {
      label: "Crush (Charm)",
      note: "Native HTTP service with session-bound tool approvals and cancellation. Host MCP injection and unimplemented optional controls are rejected.",
      capabilities: Object.fromEntries(
        EXTERNAL_AGENT_CAPABILITY_IDS.map((id) => [
          id,
          {
            level: supported.has(id) ? "native" : "unsupported",
            evidence: "adapter-code",
            ...(supported.has(id) ? {} : { reasonKey: "noProtocolSlot" }),
          },
        ])
      ) as ExternalAgentCapabilityMatrix,
    },
  },
}
