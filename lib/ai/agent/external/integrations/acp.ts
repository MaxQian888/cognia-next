/**
 * Host wiring for the ACP integration (`@cognia/agent-acp`).
 *
 * The package owns the Agent Client Protocol: the client, wire codec, feature
 * profile, permission-input derivation, ACP Registry v1 and the
 * per-conversation Devin adapter. The app supplies every port: the process
 * plane (Tauri, a paired Host, the headless brain or the CLI backend), the
 * confined workspace files, the native host terminals, the proxy-aware and
 * streaming fetches, the platform WebSocket, the host's ACP capability truth,
 * the launch environment, the approval policy and allow-list check, the PII
 * gate, the bounded logger and the dynamic-MCP gateway.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AcpDynamicMcpHostController } from "@cognia/agent-contracts/external-agent"
import { AcpClientAdapter, type AcpClientDeps } from "@cognia/agent-acp/client"
import { DevinAcpAdapter } from "@cognia/agent-acp/devin-adapter"
import { loggers } from "@cognia/logging"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { createPlatformWebSocket } from "@/lib/network/platform-websocket"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { getAcpHostCapabilities } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { createAgentLogger } from "../host/agent-logger"
import { createAgentTransportFileHost } from "../host/file-host"
import { createAgentTransportProcessHost } from "../host/process-host"
import { createNativeTerminalHost } from "../host/terminal-host"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"

let dynamicMcpHostController: AcpDynamicMcpHostController | undefined

/**
 * Attach the host-owned MCP gateway used by preview ACP-channel MCP servers.
 * Passing `undefined` disables the feature immediately; every ACP client reads
 * it live and will not advertise or accept dynamic MCP operations without one.
 */
export function setAcpDynamicMcpHostController(
  controller: AcpDynamicMcpHostController | undefined
): void {
  dynamicMcpHostController = controller
}

/** The app's ports for one ACP client. */
export function createAcpClientDeps(): AcpClientDeps {
  return {
    processHost: createAgentTransportProcessHost(),
    files: createAgentTransportFileHost(),
    terminals: createNativeTerminalHost(),
    requestFetch: proxyFetch,
    streamFetch: platformStreamingFetch,
    openWebSocket: createPlatformWebSocket,
    hostCapabilities: getAcpHostCapabilities,
    resolveLaunchEnvironment: buildAgentEnv,
    approvalPolicy: configuredApprovalPolicy,
    toolPreApproval: isToolPreApproved,
    outboundGate: hasNoLeakingPiiDeep,
    dynamicMcpHost: () => dynamicMcpHostController,
    logger: createAgentLogger(loggers.agent),
  }
}

/** One `acp` adapter over the app's ports. */
export function createAcpClientAdapter(
  deps: AcpClientDeps = createAcpClientDeps()
): AcpClientAdapter {
  return new AcpClientAdapter(deps)
}

/** The `acp` adapter factory the manager registers. */
export function createAcpAdapterFactory(): ProtocolAdapterFactory {
  return () => createAcpClientAdapter()
}

/**
 * Devin over stdio: `discovery` serves the configuration, and each
 * conversation gets its own ACP client over the same ports.
 */
export function createDevinAcpAdapter(discovery: AcpClientAdapter): DevinAcpAdapter {
  return new DevinAcpAdapter(
    discovery,
    () => createAcpClientAdapter(),
    createAgentLogger(loggers.agent)
  )
}
