/**
 * Host wiring for the Aider integration (`@cognia/agent-aider`).
 *
 * The package owns the CLI protocol, its session files and the history
 * format. The app supplies the process plane (local, a paired Host, the
 * headless brain or the CLI backend), the confined workspace file plane, the
 * PII gate and the credential redactor for process output.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import { AiderCliClientAdapter } from "@cognia/agent-aider/cli-client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { createAgentTransportFileHost } from "../host/file-host"
import { createAgentTransportProcessHost } from "../host/process-host"

/** One `aider-cli` adapter over the app's ports. */
export function createAiderCliAdapter(
  processHost = createAgentTransportProcessHost("any"),
  fileHost = createAgentTransportFileHost()
): AiderCliClientAdapter {
  return new AiderCliClientAdapter({
    processHost,
    fileHost,
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
  })
}

/** The `aider-cli` adapter factory the manager registers. */
export function createAiderCliAdapterFactory(
  processHost = createAgentTransportProcessHost("any"),
  fileHost = createAgentTransportFileHost()
): ProtocolAdapterFactory {
  return () => createAiderCliAdapter(processHost, fileHost)
}
