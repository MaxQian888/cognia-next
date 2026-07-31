/**
 * Tauri command wrappers for the M3 Rust HTTP MCP server.
 *
 * The Rust side (src-tauri/src/mcp_server/) exposes 4 commands:
 *   • mcp_server_start(port, token, settings_json, sidecar_path) → bound port
 *   • mcp_server_stop()
 *   • mcp_server_restart(...)                                    → bound port
 *   • mcp_server_status()                                        → status snapshot
 *
 * This module is a thin TS shim — it isolates the transport.call() boundary so
 * the rest of the bridge code never sees a `@tauri-apps/api` import directly,
 * and so web-mode callers get a useful error from the WebStubTransport.
 */

import { isTauri, transport } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { activeHostSupportsFeature } from "@/stores/remote-host/remote-host-store"
import type { ExternalBridgeSettings } from "@/types/wiki"

export interface McpServerStatus {
  running: boolean
  port: number | null
  startedAt: string | null
}

export interface StartArgs {
  /** Bind port; pass 0 for OS-assigned ephemeral. */
  port: number
  /** Bearer token — required even with localhost binding. */
  token: string
  /** Current settings snapshot — passed to the sidecar via env. */
  settings: ExternalBridgeSettings
  /** Filesystem path to `cognia-mcp.js` (the bundled standalone-entry). */
  sidecarPath?: string
}

export interface ExternalBridgeHostConfig {
  revision: number
  enabledScopes: string[]
  port: number
  bindMode: "loopback" | "relay" | "direct-tls"
  autoStart: boolean
}

export interface ExternalBridgeClient {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  expiresAt?: number | null
  revokedAt?: number | null
}

export interface ExternalBridgeClientCredential {
  client: ExternalBridgeClient
  credential: string
}

export interface ExternalBridgeHostStatus {
  state: "stopped" | "starting" | "running" | "degraded"
  configRevision: number
  endpoint?: string | null
  bindMode: string
  health: "inactive" | "healthy" | "unhealthy"
  sidecarBuild: string
  startedAt?: string | null
  error?: string | null
}

export function isHostManagedBridgeAvailable(): boolean {
  return activeHostSupportsFeature("external-bridge.lifecycle", "external_bridge_status")
}

export function isMcpServerHostAvailable(): boolean {
  return !isRemoteHostActive() && (isTauri() || isHeadlessHost())
}

/** Start the HTTP MCP server. Returns the bound port. */
export async function startMcpServer(args: StartArgs): Promise<number> {
  const payload: Record<string, unknown> = {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
  }
  if (args.sidecarPath) payload.sidecarPath = args.sidecarPath
  return transport.call<number>("mcp_server_start", payload)
}

/** Stop the HTTP MCP server (graceful). No-op if already stopped. */
export async function stopMcpServer(): Promise<void> {
  await transport.call<void>("mcp_server_stop")
}

/** Stop + start in one atomic call. Returns the new bound port. */
export async function restartMcpServer(args: StartArgs): Promise<number> {
  const payload: Record<string, unknown> = {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
  }
  if (args.sidecarPath) payload.sidecarPath = args.sidecarPath
  return transport.call<number>("mcp_server_restart", payload)
}

export async function getExternalBridgeConfig(): Promise<ExternalBridgeHostConfig> {
  return transport.call<ExternalBridgeHostConfig>("external_bridge_config_get")
}

export async function updateExternalBridgeConfig(
  update: Omit<ExternalBridgeHostConfig, "revision"> & { expectedRevision: number },
  adminLease: string
): Promise<ExternalBridgeHostConfig> {
  return transport.call<ExternalBridgeHostConfig>("external_bridge_config_update", {
    update,
    adminLease,
  })
}

export async function createExternalBridgeClient(
  args: {
    name: string
    scopes: string[]
    expiresAt?: number
  },
  adminLease: string
): Promise<ExternalBridgeClientCredential> {
  return transport.call<ExternalBridgeClientCredential>("external_bridge_client_create", {
    ...args,
    adminLease,
  })
}

export async function listExternalBridgeClients(): Promise<ExternalBridgeClient[]> {
  return transport.call<ExternalBridgeClient[]>("external_bridge_client_list")
}

export async function rotateExternalBridgeClient(
  clientId: string,
  adminLease: string
): Promise<ExternalBridgeClientCredential> {
  return transport.call<ExternalBridgeClientCredential>("external_bridge_client_rotate", {
    clientId,
    adminLease,
  })
}

export async function revokeExternalBridgeClient(
  clientId: string,
  adminLease: string
): Promise<ExternalBridgeClient> {
  return transport.call<ExternalBridgeClient>("external_bridge_client_revoke", {
    clientId,
    adminLease,
  })
}

export async function startExternalBridge(adminLease: string): Promise<number> {
  return transport.call<number>("external_bridge_start", { adminLease })
}

export async function stopExternalBridge(adminLease: string): Promise<void> {
  await transport.call<void>("external_bridge_stop", { adminLease })
}

export async function restartExternalBridge(adminLease: string): Promise<number> {
  return transport.call<number>("external_bridge_restart", { adminLease })
}

export async function getExternalBridgeStatus(): Promise<ExternalBridgeHostStatus> {
  return transport.call<ExternalBridgeHostStatus>("external_bridge_status")
}

/**
 * Snapshot the current server status. Returns a stub `{ running: false }`
 * in plain-web mode so UI code can still render "MCP server unavailable"
 * without special-casing the env check. Capacitor mode (M2+) will reach
 * the desktop's real status through the companion transport — the stub
 * fall-through only fires when transport is the WebStub.
 */
export async function getMcpServerStatus(): Promise<McpServerStatus> {
  if (!isMcpServerHostAvailable()) {
    return { running: false, port: null, startedAt: null }
  }
  return transport.call<McpServerStatus>("mcp_server_status")
}
