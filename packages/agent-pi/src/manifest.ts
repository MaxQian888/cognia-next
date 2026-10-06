/**
 * Pi integration manifest (ADR-0217).
 *
 * Pure data: importing it never loads the RPC adapter, the peer or the event
 * mapper.
 */

import type { AgentIntegrationManifest } from "@cognia/agent-contracts/ecosystem"
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
