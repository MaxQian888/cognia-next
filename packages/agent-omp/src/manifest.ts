/** Package declarations only: host registration, allowlists and certification are separate. */
import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

export const OMP_ECOSYSTEM_ID = "oh-my-pi"
export const OMP_RPC_PROTOCOL = "omp-rpc"
export const OMP_SESSION_SOURCE_ID = "oh-my-pi"
export const OMP_VERIFIED_VERSION = "18.6.1"
/** Stop terminates the dedicated process; native abort alone does not clear all future work. */
export const OMP_RPC_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "process", reconnectsAfterCancel: true }),
  resume: "relaunch-with-session",
  fork: "native",
  approvals: "per-tool-call",
  processModel: "per-session",
  maxProcesses: 4,
})
/** The host's closed protocol union remains unchanged until integration is approved. */
export type OmpRuntimeDeclaration = Omit<ExternalAgentRuntimeCatalogEntry, "protocol"> & {
  protocol: typeof OMP_RPC_PROTOCOL
}
export const OMP_RUNTIMES: readonly OmpRuntimeDeclaration[] = [
  {
    runtimeId: OMP_ECOSYSTEM_ID,
    presetIds: [OMP_RPC_PROTOCOL],
    displayName: "Oh My Pi (native RPC)",
    ownership: "system",
    protocol: OMP_RPC_PROTOCOL,
    transport: "stdio",
    platforms: ["darwin", "linux"],
    systemCommand: "omp",
    launchArgs: ["--mode", "rpc"],
    versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
    distributions: [],
    sandbox: { required: true, windowsExceptionEligible: false },
    docsUrl: "https://github.com/can1357/oh-my-pi/blob/v18.6.1/docs/rpc.md",
  },
]
export type OmpIntegrationManifest = Omit<AgentIntegrationManifest, "runtimes"> & {
  runtimes: readonly OmpRuntimeDeclaration[]
}
export const ompManifest: OmpIntegrationManifest = {
  ecosystem: {
    id: OMP_ECOSYSTEM_ID,
    runtimeIds: [OMP_ECOSYSTEM_ID],
    sessionSourceIds: [OMP_SESSION_SOURCE_ID],
    migrationVendor: "oh-my-pi",
    vendorRootKeys: ["ompAgentDir", "ompSessionDir"],
    configRootKey: "ompAgentDir",
    probeRootKeys: ["ompAgentDir"],
    pluginEcosystem: null,
    subagentSourceId: "oh-my-pi",
    memoryAgentId: "oh-my-pi",
  },
  protocols: [{ protocol: OMP_RPC_PROTOCOL, semantics: OMP_RPC_EXECUTION_SEMANTICS }],
  runtimes: OMP_RUNTIMES,
}
const native = { level: "native", evidence: "protocol-spec" } as const
const unknown = { level: "unknown", evidence: "none" } as const
export const OMP_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    "omp-rpc": {
      label: "OMP native omp --mode rpc JSONL protocol",
      note: "OMP 18.6.1 protocol declarations; host permissions, sandbox and live negotiation must constrain availability. No host integration or conformance certification is implied.",
      capabilities: {
        streaming: native,
        "session.multi-turn": native,
        "session.resume": native,
        "tools.ordinary": native,
        "tools.parallel": native,
        "tools.fragmented-json": native,
        "tools.results": native,
        "tools.errors": native,
        thinking: native,
        images: native,
        steer: native,
        "set-model": native,
        compaction: native,
        "models.list": native,
        "session.manage": native,
        "commands.dynamic": native,
        "tasks.background": native,
        "subagents.native": native,
        "subagents.manage": native,
        "input.elicitation": native,
        "input.dialog": native,
        "upstream-errors": native,
        "stream-interruption": native,
        "permissions.interrupt-resume": unknown,
        "permissions.set-mode": unknown,
        "permissions.update-rules": unknown,
        "hooks.lifecycle": unknown,
        "sandbox.native": unknown,
        "web.search": unknown,
        mcp: unknown,
        "plugins.native": unknown,
      },
    },
  },
}
