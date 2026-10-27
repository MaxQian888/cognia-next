/** The SDK is confined to the verified native bridge, outside the static app graph. */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { CodebuffAdapter } from "@cognia/agent-codebuff/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { createAgentTransportFileHost } from "../host/file-host"
import { createAgentTransportProcessHost } from "../host/process-host"
import { resolveBundledAgentBridge } from "../host/native-bridge"
import { configuredApprovalPolicy } from "../policy/tool-preapproval"
function requireLocal(id: string): void {
  if (!runsExternalAgentProcessesLocally() || spawnPlacementFor(id))
    throw new Error(
      "Codebuff requires the verified local bridge with mandatory OS network isolation"
    )
}
export function createCodebuffAdapter(
  processHost: AgentProcessHost = createAgentTransportProcessHost("local"),
  fileHost = createAgentTransportFileHost()
): CodebuffAdapter {
  const guardedHost: AgentProcessHost = {
    ...processHost,
    get available() {
      return processHost.available
    },
    spawn: (spec) => {
      const index = spec.id.lastIndexOf(":codebuff:")
      if (index < 0) throw new Error("Invalid Codebuff process identity")
      requireLocal(spec.id.slice(0, index))
      if (spec.sandboxPolicy?.network !== "off" || spec.sandboxPolicy.readableScope !== "workspace")
        throw new Error("Codebuff bridge cannot widen its enforced sandbox")
      return processHost.spawn(spec)
    },
  }
  return new CodebuffAdapter({
    processHost: guardedHost,
    fileHost,
    fetch: platformStreamingFetch,
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    approvalPolicy: configuredApprovalPolicy,
    resolveBridgeLaunch: async (config) => {
      requireLocal(config.id)
      if (config.process?.args?.length)
        throw new Error("Codebuff uses only the fixed verified SDK bridge arguments")
      const bridge = await resolveBundledAgentBridge("codebuff"),
        env = await buildAgentEnv(config, config.process?.env ?? {})
      requireLocal(config.id)
      // The registered native bridge launch is enforced by the host: POSIX OS
      // sandbox + network:off, with no Windows/consent/unsandboxed fallback.
      return { command: bridge.command, args: bridge.args, env, networkIsolated: true }
    },
  })
}
export function createCodebuffAdapterFactory(
  processHost = createAgentTransportProcessHost("local"),
  fileHost = createAgentTransportFileHost()
): ProtocolAdapterFactory {
  return () => createCodebuffAdapter(processHost, fileHost)
}
