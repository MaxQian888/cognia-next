/** Pure package-owned identity and execution semantics (ADR-0217). */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import {
  AGENT_CAPABILITY_IDS,
  type AgentCapabilityId,
} from "@cognia/agent-contracts/capability-ids"
import type { ExternalAgentCapabilityMatrix } from "@cognia/agent-contracts/external-agent-capability"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

export const OPENCLAUDE_PROTOCOL = "openclaude-cli"
export const OPENCLAUDE_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "relaunch-with-session",
  fork: "unsupported",
  approvals: "per-tool-call",
  processModel: "per-session",
})
export const openClaudeManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: {
    id: "openclaude",
    runtimeIds: ["openclaude"],
    sessionSourceIds: [],
    migrationVendor: null,
    vendorRootKeys: [],
    configRootKey: null,
    probeRootKeys: [],
    pluginEcosystem: null,
    subagentSourceId: null,
    memoryAgentId: null,
  },
  protocols: [{ protocol: OPENCLAUDE_PROTOCOL, semantics: OPENCLAUDE_EXECUTION_SEMANTICS }],
  runtimes: [
    {
      runtimeId: "openclaude",
      presetIds: ["openclaude"],
      displayName: "OpenClaude",
      ownership: "system",
      protocol: OPENCLAUDE_PROTOCOL,
      transport: "stdio",
      platforms: ["darwin", "linux", "win32"],
      systemCommand: "openclaude",
      launchArgs: [],
      versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      supportedRange: ">=0.33.0 <0.34.0",
      certifiedVersions: [],
      distributions: [],
      sandbox: { required: true, windowsExceptionEligible: false },
      docsUrl: "https://github.com/Twigpine/openclaude",
    },
  ],
}) as AgentIntegrationManifest

const NATIVE_CAPABILITIES = new Set<AgentCapabilityId>([
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.fragmented-json",
  "tools.results",
  "tools.errors",
  "mcp",
  "permissions.interrupt-resume",
  "thinking",
  "images",
  "upstream-errors",
  "stream-interruption",
  "input.elicitation",
])
export const OPENCLAUDE_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    [OPENCLAUDE_PROTOCOL]: {
      label: "OpenClaude native stream-json",
      note: "Published OpenClaude CLI control protocol over a confined process per conversation. Native text/thinking/tool JSON, inline images, explicit resume, MCP, PreToolUse policy and user forms. No ACP inference, cold history discovery, native subagent inspection, arbitrary attachment loading or JSON-schema output control. Provider authentication and installed-runtime acceptance are separate from adapter tests.",
      capabilities: Object.fromEntries(
        AGENT_CAPABILITY_IDS.map((id) => [
          id,
          NATIVE_CAPABILITIES.has(id)
            ? { level: "native", evidence: "adapter-code" }
            : id === "permissions.set-mode" || id === "tools.permission-policy"
              ? { level: "equivalent", evidence: "adapter-code", reasonKey: "cogniaHookRuntime" }
              : { level: "unsupported", evidence: "adapter-code", reasonKey: "noProtocolSlot" },
        ])
      ) as ExternalAgentCapabilityMatrix,
    },
  },
}
