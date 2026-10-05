/**
 * Host wiring for the Codex integration (`@cognia/agent-codex`).
 *
 * The package owns the app-server protocol. The app supplies what is the
 * host's: the process plane (local, a paired Host, the headless brain or the
 * CLI backend), the per-configuration launch environment (ADR-0216 secrets,
 * state root and bound account through `buildAgentEnv`), the configuration's
 * approval-list policy, the bounded logger and task-workspace file evidence.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import { CodexAppServerAdapter } from "@cognia/agent-codex/app-server-client"
import { loggers } from "@cognia/logging"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { buildAgentEnv } from "../config/env-builder"
import { configuredApprovalPolicy } from "../policy/tool-preapproval"
import { createAgentLogger } from "../host/agent-logger"
import { createAgentTransportProcessHost } from "../host/process-host"

/** Record a completed `fileChange` as task-workspace evidence. Best effort. */
function recordFileChanges(sessionId: string, toolUseId: string, changes: unknown): void {
  void import("@/lib/task-workspace/tool-evidence")
    .then(({ recordToolFileChanges }) => recordToolFileChanges(sessionId, toolUseId, changes))
    .catch(() => undefined)
}

/** The `codex-app-server` adapter factory the manager registers. */
export function createCodexAppServerAdapterFactory(
  processHost = createAgentTransportProcessHost("any")
): ProtocolAdapterFactory {
  const logger = createAgentLogger(loggers.agent)
  return () =>
    new CodexAppServerAdapter({
      processHost,
      resolveLaunchEnvironment: buildAgentEnv,
      approvalPolicy: configuredApprovalPolicy,
      outboundGate: hasNoLeakingPiiDeep,
      logger,
      onFileChanges: recordFileChanges,
    })
}
