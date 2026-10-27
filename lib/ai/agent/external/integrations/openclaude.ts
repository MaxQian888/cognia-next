/** Host ports for the independent OpenClaude stream-json package (ADR-0217). */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import { OpenClaudeAdapter } from "@cognia/agent-openclaude/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { createAgentTransportProcessHost } from "../host/process-host"
import { createAgentLogger } from "../host/agent-logger"
import { buildAgentEnv } from "../config/env-builder"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"

export function createOpenClaudeAdapter(
  processHost = createAgentTransportProcessHost("any")
): OpenClaudeAdapter {
  return new OpenClaudeAdapter({
    processHost,
    resolveLaunchEnvironment: buildAgentEnv,
    approvalPolicy: configuredApprovalPolicy,
    toolPreApproval: isToolPreApproved,
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    logger: createAgentLogger(loggers.agent),
  })
}

export function createOpenClaudeAdapterFactory(
  processHost = createAgentTransportProcessHost("any")
): ProtocolAdapterFactory {
  return () => createOpenClaudeAdapter(processHost)
}
