/**
 * Host wiring for the Pi integration (`@cognia/agent-pi`).
 *
 * The package owns Pi's RPC protocol, its framing, the event mapping and the
 * native-tool table. The app supplies the process plane, the two questions only
 * a host can answer (`resolve_pi_extension`, `list_pi_sessions`), the PII gate,
 * the configuration's approval policy and glob, the operator kill switch, the
 * typed process-lease conflict and the plugin registry for Pi packages.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import {
  isPiRpcDisabled,
  PiRpcClientAdapter,
  type PiExtensionVerdict,
  type PiHostServices,
  type PiPackageResolver,
  type PiSessionRecord,
} from "@cognia/agent-pi/rpc-client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { matchGlob } from "@/lib/claude/permissions/ruleset"
import { agentProcessConflictFrom } from "@/lib/execution/lease-conflict"
import { agentInvoke } from "../agent-transport"
import { createAgentTransportProcessHost } from "../host/process-host"
import { configuredApprovalPolicy } from "../policy/tool-preapproval"

/** The Pi-specific host commands, over the selected Host. */
export const piHostServices: PiHostServices = {
  resolveExtension: () => agentInvoke<PiExtensionVerdict>("resolve_pi_extension", {}),
  listSessions: (cwd) =>
    agentInvoke<PiSessionRecord[] | null | undefined>("list_pi_sessions", cwd ? { cwd } : {}),
}

/**
 * Plugin-contributed Pi packages (ADR-0210), resolved from the plugin
 * registry. Lazy: only a session that opted into a package pays for the
 * registry, and hosts without a plugin manager never load it.
 */
export const resolvePluginPiPackages: PiPackageResolver = async (refs, context) => {
  const { resolveHostedPiPackages } = await import("@/lib/plugin/pi-packages/session")
  return resolveHostedPiPackages(refs, context)
}

/** One `pi-rpc` adapter over the app's ports. */
export function createPiRpcAdapter(
  processHost = createAgentTransportProcessHost("any"),
  hostServices: PiHostServices = piHostServices
): PiRpcClientAdapter {
  return new PiRpcClientAdapter({
    processHost,
    hostServices,
    outboundGate: hasNoLeakingPiiDeep,
    approvalPolicy: configuredApprovalPolicy,
    matchToolPattern: matchGlob,
    isDisabled: () => isPiRpcDisabled(),
    classifySpawnConflict: agentProcessConflictFrom,
    resolvePiPackages: resolvePluginPiPackages,
  })
}

/** The `pi-rpc` adapter factory the manager registers. */
export function createPiRpcAdapterFactory(
  processHost = createAgentTransportProcessHost("any"),
  hostServices: PiHostServices = piHostServices
): ProtocolAdapterFactory {
  return () => createPiRpcAdapter(processHost, hostServices)
}
