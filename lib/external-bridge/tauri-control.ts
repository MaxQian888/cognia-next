/**
 * Tauri command wrappers for the M3 Rust HTTP MCP server.
 *
 * The Rust side (src-tauri/src/mcp_server/) exposes 4 commands:
 *   • mcp_server_start(port, token, settings_json, sidecar_path) → bound port
 *   • mcp_server_stop()
 *   • mcp_server_restart(...)                                    → bound port
 *   • mcp_server_status()                                        → status snapshot
 *
 * This module is a thin TS shim — it isolates the `invoke()` calls so the
 * rest of the bridge code never sees a `@tauri-apps/api` import directly,
 * and so web-mode callers get a useful "not in Tauri" error instead of an
 * `invoke is not a function` crash.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
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

function ensureTauri(): void {
  if (!isTauri()) {
    throw new Error(
      "The Rust MCP HTTP server is Tauri-only. Run the desktop app (`pnpm tauri dev`) to use this feature."
    )
  }
}

/** Start the HTTP MCP server. Returns the bound port. */
export async function startMcpServer(args: StartArgs): Promise<number> {
  ensureTauri()
  return invoke<number>("mcp_server_start", {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
    sidecarPath: args.sidecarPath,
  })
}

/** Stop the HTTP MCP server (graceful). No-op if already stopped. */
export async function stopMcpServer(): Promise<void> {
  ensureTauri()
  await invoke<void>("mcp_server_stop")
}

/** Stop + start in one atomic call. Returns the new bound port. */
export async function restartMcpServer(args: StartArgs): Promise<number> {
  ensureTauri()
  return invoke<number>("mcp_server_restart", {
    port: args.port,
    token: args.token,
    settingsJson: JSON.stringify(args.settings),
    sidecarPath: args.sidecarPath,
  })
}

/**
 * Snapshot the current server status. Returns a stub `{ running: false }`
 * in web mode so UI code can still render "MCP server unavailable" without
 * special-casing the env check.
 */
export async function getMcpServerStatus(): Promise<McpServerStatus> {
  if (!isTauri()) {
    return { running: false, port: null, startedAt: null }
  }
  return invoke<McpServerStatus>("mcp_server_status")
}
