/** App host wiring for Continue's documented headless CLI contract (ADR-0217). */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import { ContinueAdapter } from "@cognia/agent-continue/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { buildAgentEnv } from "../config/env-builder"
import { createAgentTransportFileHost } from "../host/file-host"
import { createAgentTransportProcessHost } from "../host/process-host"

export function createContinueAdapter(
  processHost = createAgentTransportProcessHost("any"),
  fileHost = createAgentTransportFileHost()
): ContinueAdapter {
  return new ContinueAdapter({
    processHost,
    fileHost,
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    resolveLaunchEnvironment: buildAgentEnv,
  })
}
export function createContinueAdapterFactory(
  processHost = createAgentTransportProcessHost("any"),
  fileHost = createAgentTransportFileHost()
): ProtocolAdapterFactory {
  return () => createContinueAdapter(processHost, fileHost)
}
