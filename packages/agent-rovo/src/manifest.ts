/** Pure identity/capability contribution; no runtime or Node bridge imports. */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"
import { EXTERNAL_AGENT_CAPABILITY_IDS } from "@cognia/agent-contracts/external-agent-capability"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"

export const ROVO_PROTOCOL = "rovo-http"
export const ROVO_EXECUTION_SEMANTICS: AgentExecutionSemantics = {
  cancel: { scope: "turn", reconnectsAfterCancel: false },
  resume: "native",
  fork: "unsupported",
  approvals: "per-tool-call",
  processModel: "per-session",
}
export const rovoDevManifest: AgentIntegrationManifest = {
  ecosystem: {
    id: "rovo-dev",
    runtimeIds: ["rovo-dev"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  protocols: [{ protocol: ROVO_PROTOCOL, semantics: ROVO_EXECUTION_SEMANTICS }],
  runtimes: [
    {
      runtimeId: "rovo-dev",
      presetIds: ["rovo-dev"],
      displayName: "Rovo Dev",
      ownership: "system",
      protocol: ROVO_PROTOCOL,
      transport: "http",
      platforms: ["darwin", "linux"],
      systemCommand: "acli",
      launchArgs: ["rovodev", "serve"],
      versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      certifiedVersions: [],
      distributions: [],
      sandbox: { required: true, windowsExceptionEligible: false },
      docsUrl: "https://support.atlassian.com/rovo/docs/use-server-mode-in-rovo-dev-cli/",
    },
  ],
}
const supported = new Set([
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.fragmented-json",
  "tools.results",
  "permissions.interrupt-resume",
  "upstream-errors",
  "stream-interruption",
  "session.store",
  "session.manage",
])
export const ROVO_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    [ROVO_PROTOCOL]: {
      label: "Rovo Dev",
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
