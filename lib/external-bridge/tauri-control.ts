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
  sidecarPath: string
}

export function isMcpServerHostAvailable(): boolean {
  return isTauri() || isHeadlessHost() || isRemoteHostActive()
}

/** Start the HTTP MCP server. Returns the bound port. */
export async function startMcpServer(args: StartArgs): Promise<number> {
  return transport.call<number>("mcp_server_start", {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
    sidecarPath: args.sidecarPath,
  })
}

/** Stop the HTTP MCP server (graceful). No-op if already stopped. */
export async function stopMcpServer(): Promise<void> {
  await transport.call<void>("mcp_server_stop")
}

/** Stop + start in one atomic call. Returns the new bound port. */
export async function restartMcpServer(args: StartArgs): Promise<number> {
  return transport.call<number>("mcp_server_restart", {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
    sidecarPath: args.sidecarPath,
  })
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
