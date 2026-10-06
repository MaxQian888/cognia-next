/**
 * Pi integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the RPC adapter, the peer or the event
 * mapper.
 */

import type {
  AgentCapabilityContribution,
  AgentIntegrationManifest,
} from "@cognia/agent-contracts/ecosystem"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { AgentExecutionSemantics } from "@cognia/agent-contracts/semantics"

/**
 * One `pi --mode rpc` process per session, at most four per host. A cancel
 * sends Pi's `abort`, which ends the turn and leaves the process and session
 * running. A session whose process is gone resumes by relaunching with the
 * same `--session-id`; `--fork` branches a stored session natively. Pi asks
 * for each native tool call through the bundled extension.
 */
export const PI_RPC_EXECUTION_SEMANTICS: AgentExecutionSemantics = Object.freeze({
  cancel: Object.freeze({ scope: "turn", reconnectsAfterCancel: false }),
  resume: "relaunch-with-session",
  fork: "native",
  approvals: "per-tool-call",
  processModel: "per-session",
  maxProcesses: 4,
}) as AgentExecutionSemantics

export const PI_ECOSYSTEM_ID = "pi"
export const PI_RPC_PROTOCOL = "pi-rpc"
/** The session-history source id Pi sessions are imported under. */
export const PI_SESSION_SOURCE_ID = "pi"

/**
 * Pi's runtime catalog rows. `pnpm gen:external-agent-runtimes` writes them
 * into `protocol/external-agent-runtimes.json`; edit them here, never there.
 */
export const PI_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = [
  {
    runtimeId: "pi",
    presetIds: ["pi-rpc"],
    displayName: "Pi (native RPC)",
    ownership: "system",
    protocol: "pi-rpc",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    systemCommand: "pi",
    launchArgs: ["--mode", "rpc"],
    versionProbe: {
      args: ["--version"],
      parser: "semver-anywhere",
      timeoutMs: 10000,
    },
    distributions: [],
    sandbox: {
      required: true,
      windowsExceptionEligible: false,
    },
    docsUrl: "https://pi.dev/docs/latest/rpc",
  },
]

export const piManifest: AgentIntegrationManifest = Object.freeze({
  ecosystem: Object.freeze({
    id: PI_ECOSYSTEM_ID,
    runtimeIds: ["pi"],
    sessionSourceIds: [PI_SESSION_SOURCE_ID],
    migrationVendor: "pi",
    vendorRootKeys: ["piAgentDir", "piSessionDir"],
    configRootKey: "piAgentDir",
    probeRootKeys: ["piAgentDir"],
    pluginEcosystem: null,
    subagentSourceId: "pi",
    memoryAgentId: "pi",
  }),
  protocols: [{ protocol: PI_RPC_PROTOCOL, semantics: PI_RPC_EXECUTION_SEMANTICS }],
  runtimes: PI_RUNTIMES,
}) as AgentIntegrationManifest

/**
 * Pi's capability rows. `pnpm gen:agent-capabilities` writes them into
 * `protocol/agent-capabilities.json`; edit them here, never there.
 */
export const PI_CAPABILITIES: AgentCapabilityContribution = {
  protocols: {
    "pi-rpc": {
      label: "Pi native `pi --mode rpc` JSONL command/event protocol",
      note: "Pi RPC with the bundled Cognia extension: the extension mounts per-session MCP servers as Pi custom tools, enforces native-tool permissions, and reports tool events. Native RPC owns session resume, model selection and cancellation.",
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
          level: "native",
          evidence: "adapter-code",
        },
        "tools.ordinary": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.parallel": {
          level: "native",
          evidence: "protocol-spec",
        },
        "tools.fragmented-json": {
          level: "native",
          evidence: "protocol-spec",
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
          reasonKey: "cogniaExtensionBridge",
        },
        "permissions.interrupt-resume": {
          level: "native",
          evidence: "protocol-spec",
        },
        "permissions.set-mode": {
          level: "unknown",
          evidence: "none",
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
          level: "native",
          evidence: "adapter-code",
        },
        "beta-features": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        "rate-limit-handling": {
          level: "native",
          evidence: "protocol-spec",
        },
        "upstream-errors": {
          level: "native",
          evidence: "protocol-spec",
        },
        "stream-interruption": {
          level: "native",
          evidence: "protocol-spec",
        },
        "subagents.native": {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        steer: {
          level: "native",
          evidence: "protocol-spec",
        },
        "set-model": {
          level: "native",
          evidence: "adapter-code",
        },
        checkpoint: {
          level: "unsupported",
          evidence: "protocol-spec",
          reasonKey: "noProtocolSlot",
        },
        compaction: {
          level: "native",
          evidence: "adapter-code",
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
          level: "unknown",
          evidence: "none",
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
          level: "native",
          evidence: "protocol-spec",
        },
        "input.dialog": {
          level: "native",
          evidence: "protocol-spec",
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
          level: "native",
          evidence: "protocol-spec",
        },
        "web.search": {
          level: "unknown",
          evidence: "none",
        },
      },
    },
  },
}
