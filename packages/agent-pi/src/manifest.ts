/**
 * Pi integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the RPC adapter, the peer or the event
 * mapper.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
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
}) as AgentIntegrationManifest
