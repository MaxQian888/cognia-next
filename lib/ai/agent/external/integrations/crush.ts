/** App host wiring for Crush's private Unix-socket service bridge (ADR-0217). */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { CrushAdapter } from "@cognia/agent-crush/client"
import { createCrushSocketBridge } from "@cognia/agent-crush/socket-bridge"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { resolveBundledAgentBridge } from "../host/native-bridge"
import { createAgentTransportProcessHost } from "../host/process-host"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"

function requireLocal(agentId: string): void {
  if (!runsExternalAgentProcessesLocally() || spawnPlacementFor(agentId))
    throw new Error(
      "Crush private socket requires this local process host without a selected runtime environment"
    )
}
export function createCrushAdapter(
  processHost: AgentProcessHost = createAgentTransportProcessHost("local")
): CrushAdapter {
  const guardedHost: AgentProcessHost = {
    ...processHost,
    get available() {
      return processHost.available
    },
    spawn: (spec) => {
      const index = spec.id.lastIndexOf(":crush-socket:")
      if (index < 0) throw new Error("Invalid Crush process identity")
      requireLocal(spec.id.slice(0, index))
      return processHost.spawn(spec)
    },
  }
  const bridge = createCrushSocketBridge({
    processHost: guardedHost,
    outboundGate: hasNoLeakingPiiDeep,
    resolveBridgeLaunch: async (config) => {
      requireLocal(config.id)
      if (config.process?.command !== "crush" || config.process.args?.length)
        throw new Error("Crush service flags are owned by its private socket bridge")
      const result = await resolveBundledAgentBridge("crush-http"),
        env = await buildAgentEnv(config, config.process?.env ?? {})
      requireLocal(config.id)
      return { command: result.command, args: result.args, env }
    },
  })
  return new CrushAdapter({
    ...bridge,
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    approvalPolicy: configuredApprovalPolicy,
    isToolPreApproved,
  })
}
export function createCrushAdapterFactory(
  processHost = createAgentTransportProcessHost("local")
): ProtocolAdapterFactory {
  return () => createCrushAdapter(processHost)
}
