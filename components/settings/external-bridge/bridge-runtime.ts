/**
 * Runtime helpers shared by the External Bridge panels.
 *
 * Both live here because the two former call sites disagreed. `httpPort` had a
 * default of `0` where the server was started (let the OS assign) and `3001`
 * where the setup snippet was rendered, so a snippet copied before the first
 * successful start pointed at a port nothing was listening on. And the setup
 * snippet's stdio variant hard-coded `/path/to/cognia-mcp.js` even though
 * `resolveSidecarPath` — which returns the real location — was defined in the
 * very same file.
 *
 * Replacing that placeholder with a *synthesised* `~/.cognia/cognia-mcp.js`
 * only traded one unverified string for another: no build step, installer or
 * first-run task has ever written that file, so the stdio snippet still could
 * not be pasted and `startMcpServer` still spawned `node` against a path that
 * was not there. The sidecar is now bundled into the app resources by
 * `scripts/build/build-mcp-sidecar.mjs`, and the path is resolved by Rust
 * (`mcp_server_sidecar_path`) against what is actually on disk — which is also
 * what the spawn path uses, so the two cannot drift again.
 */

import { isTauri, transport } from "@/lib/tauri"

/**
 * Port the bridge's HTTP transport listens on by default.
 *
 * Not `0`: an OS-assigned port cannot be written into a client config file
 * ahead of time, and this surface's whole job is producing a config the user
 * pastes into Claude Desktop / Cursor / Goose before anything is running.
 */
export const DEFAULT_BRIDGE_HTTP_PORT = 3001

/**
 * Where the MCP sidecar actually is, or `null` when it is not installed.
 *
 * `null` is a real answer the caller must render — printing a plausible path
 * that does not exist is the defect this replaced.
 */
export async function resolveSidecarPath(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    return await transport.call<string | null>("mcp_server_sidecar_path")
  } catch {
    return null
  }
}
