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

import type { ProtocolAdapter, ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type {
  AcpDynamicMcpHostController,
  ExternalAgentConfig,
} from "@cognia/agent-contracts/external-agent"
import { AcpClientAdapter, acpClientExtension, type AcpClientDeps } from "@cognia/agent-acp/client"
import { MiniMaxAcpAdapter } from "@cognia/agent-acp/minimax-adapter"
import { DevinAcpAdapter } from "@cognia/agent-acp/devin-adapter"
import { IsolatedAcpAdapter } from "@cognia/agent-acp/isolated-adapter"
import { resolveAcpVendorProfile } from "@cognia/agent-acp/vendor-profile"
import { ACP_VENDOR_PROFILES } from "@cognia/agent-acp/vendor-profiles"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import { loggers } from "@cognia/logging"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { createPlatformWebSocket } from "@/lib/network/platform-websocket"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { getAcpHostCapabilities } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { isDevinAgentConfig, isMiniMaxAgentConfig } from "../config/preset-identity"
import { createAgentLogger } from "../host/agent-logger"
import { createAgentTransportFileHost } from "../host/file-host"
import { createAgentTransportProcessHost } from "../host/process-host"
import { createNativeTerminalHost } from "../host/terminal-host"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"
import { isTrustedLocalMcpCredential } from "../session/renderer-tool-host"
import { AGENT_STATE_KEY_ENV } from "../policy/security-policy"
import { hermesStateKey, prepareHermesControlledDaemon } from "./hermes-daemon"

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
    isTrustedLocalMcpCredential,
    dynamicMcpHost: () => dynamicMcpHostController,
    logger: createAgentLogger(loggers.agent),
    prepareControlledDaemon: prepareHermesControlledDaemon,
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

/**
 * Give native Devin one ACP process per conversation. Applies only when the
 * factory registered for `acp` still produced the built-in client: a custom
 * factory a host or plugin registered stays authoritative.
 */
export function isolateNativeDevin(
  config: ExternalAgentConfig,
  adapter: ProtocolAdapter | undefined
): ProtocolAdapter | undefined {
  const acp = adapter ? acpClientExtension.resolve(adapter) : undefined
  return config.transport === "stdio" &&
    isDevinAgentConfig(config) &&
    acp?.constructor === AcpClientAdapter
    ? createDevinAcpAdapter(acp)
    : adapter
}

/**
 * These protocols bind a viewer to a project. Hermes' viewers deliberately
 * retain one stable host-managed gateway key: native session durability must
 * not depend on the order in which child viewer processes were constructed.
 */
class WorkspaceScopedAcpAdapter extends IsolatedAcpAdapter {
  protected override readonly isolationId: string
  protected override readonly label: string
  constructor(id: string, label: string, discovery: AcpClientAdapter) {
    super(discovery, () => createAcpClientAdapter(), createAgentLogger(loggers.agent))
    this.isolationId = id
    this.label = label
  }
  protected override processConfig(
    suffix: string,
    options?: SessionCreateOptions
  ): ExternalAgentConfig {
    const workspace = this._config?.process?.cwd
    if (!workspace || !(workspace.startsWith("/") || /^[a-z]:[\\/]/i.test(workspace)))
      throw new Error(`${this.label} requires an absolute configured workspace before discovery`)
    const requested = options?.cwd ?? workspace
    if (!isPathUnderRoot(requested, workspace))
      throw new Error(`${this.label} session workspace must remain inside the configured workspace`)
    const config = super.processConfig(suffix, options)
    if (this.isolationId !== "hermes-agent") return config
    return {
      ...config,
      process: {
        ...config.process!,
        args: ["--profile", "default", "acp"],
        env: {
          ...config.process!.env,
          [AGENT_STATE_KEY_ENV]: hermesStateKey(this._config!.id),
        },
      },
    }
  }
}

/** Isolate process-wide ACP authority without replacing plugin-owned factories. */
export function isolateNativeAcp(
  config: ExternalAgentConfig,
  adapter: ProtocolAdapter | undefined
): ProtocolAdapter | undefined {
  const acp = adapter ? acpClientExtension.resolve(adapter) : undefined
  if (
    config.transport === "stdio" &&
    isMiniMaxAgentConfig(config) &&
    acp?.constructor === AcpClientAdapter
  )
    return new MiniMaxAcpAdapter(
      acp,
      () => createAcpClientAdapter(),
      createAgentLogger(loggers.agent)
    )
  const profile = resolveAcpVendorProfile(config, ACP_VENDOR_PROFILES)
  if (
    config.transport === "stdio" &&
    acp?.constructor === AcpClientAdapter &&
    profile &&
    ["command-code", "zcode", "hermes-agent"].includes(profile.id)
  )
    return new WorkspaceScopedAcpAdapter(profile.id, profile.label, acp)
  return isolateNativeDevin(config, adapter)
}
