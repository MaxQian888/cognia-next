/**
 * Node CLI entry — used by the Tauri sidecar and (Phase 2) the bundled
 * Claude Code plugin. Spins up an MCP server on stdio against a settings
 * source determined by environment:
 *
 *   • `COGNIA_BRIDGED=1` (default in Tauri)  — IPC back to Cognia main proc
 *   • Otherwise — standalone mode reading a JSON snapshot at
 *     `${COGNIA_DATA_DIR}/external-bridge.json`
 *
 * The standalone mode is the fallback used by the npm-distributed plugin
 * when the Cognia desktop app is not running. For Phase 1 MVP the
 * Bridged mode talks via a tiny JSON-over-stdin protocol that the Tauri
 * Rust sidecar wires up (`src-tauri/src/mcp_server/ipc_to_main.rs`).
 *
 * This file intentionally does NOT depend on Dexie / fake-indexeddb at the
 * top level — both run only when handlers actually fire, and only in
 * Standalone mode. The Bridged mode forwards every Dexie call back to the
 * main process via the IPC bridge.
 */

import { buildMcpServer, type SettingsGetter } from "./server"
import { createStdioTransport } from "./transport-stdio"
import { DEFAULT_EXTERNAL_BRIDGE_SETTINGS } from "@/types/wiki"
import type { ExternalBridgeSettings } from "@/types/wiki"
import * as fs from "node:fs/promises"
import * as path from "node:path"
// static-export-exempt: Node-only MCP stdio entry bundled as a Tauri sidecar, never imported by UI
import { pathToFileURL } from "node:url"

/** Resolve the settings getter for the current runtime mode. */
export function resolveSettingsGetter(): SettingsGetter {
  const bridged = process.env.COGNIA_BRIDGED === "1" || process.env.COGNIA_BRIDGED === "true"
  if (bridged) return bridgedSettingsGetter()
  return standaloneSettingsGetter()
}

/**
 * Bridged mode: settings live in the Cognia main process. The Tauri side
 * pipes the current settings JSON in via the env var `COGNIA_BRIDGE_SETTINGS`
 * on each spawn — it's not live (changes require a server restart) which
 * matches the "stop and restart from Settings UI" flow.
 */
function bridgedSettingsGetter(): SettingsGetter {
  const raw = process.env.COGNIA_BRIDGE_SETTINGS
  let cached: ExternalBridgeSettings | undefined
  if (raw && raw.length > 0) {
    try {
      cached = JSON.parse(raw) as ExternalBridgeSettings
    } catch {
      cached = undefined
    }
  }
  return async () => cached
}

/**
 * Standalone mode: read settings from a JSON file. The Phase 2 plugin
 * packaging stamps this file at install time so the user can toggle scopes
 * without running the desktop app.
 */
function standaloneSettingsGetter(): SettingsGetter {
  return async () => {
    const dir = process.env.COGNIA_DATA_DIR
    if (!dir) return DEFAULT_EXTERNAL_BRIDGE_SETTINGS
    try {
      const filePath = path.join(dir, "external-bridge.json")
      const text = await fs.readFile(filePath, "utf-8")
      return JSON.parse(text) as ExternalBridgeSettings
    } catch {
      return DEFAULT_EXTERNAL_BRIDGE_SETTINGS
    }
  }
}

/**
 * Drive the MCP server until stdin closes. Exposed for tests so they can
 * await the connection lifecycle deterministically.
 */
export async function runMcpServerStdio(): Promise<void> {
  const server = buildMcpServer({ settingsGetter: resolveSettingsGetter() })
  const transport = createStdioTransport()
  await server.connect(transport)
}

// Auto-run when invoked as a CLI (node bin/cognia-mcp.js). Skipped when the
// module is `import`-ed by tests.
export function isEntrypoint(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return Boolean(argvPath && pathToFileURL(path.resolve(argvPath)).href === moduleUrl)
}

const isMainModule = isEntrypoint(import.meta.url)
if (isMainModule) {
  runMcpServerStdio().catch((err) => {
    console.error("[cognia-mcp] fatal:", err)
    process.exit(1)
  })
}

export const __TESTING__ = {
  resolveSettingsGetter,
  bridgedSettingsGetter,
  standaloneSettingsGetter,
}
