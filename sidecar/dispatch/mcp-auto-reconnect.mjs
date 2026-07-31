// First-connection self-healing for the Anthropic dispatch path.
//
// The Claude Agent SDK connects the configured MCP servers once at session
// start and reports their status in the `system/init` event. A server that is
// cold on first hit (an npx-installed stdio server still downloading, a remote
// endpoint waking up) lands as `failed` and STAYS failed until the user finds
// the reconnect button. This module watches the session's event stream for
// that init report and drives `q.reconnectMcpServer(name)` automatically for
// every failed server — once per server per session, with a short delay so a
// crashing child isn't respawned in a tight loop. `needs-auth` is NOT retried
// (reconnecting can't mint a token; it needs the user's `/mcp auth` flow).
//
// Shared by the desktop GUI and the CLI TUI — both drive this same sidecar.

/**
 * Extract the failed MCP server names from an SDK event, or `[]` when the
 * event isn't an init-style status report. Handles both the `system/init`
 * event (`mcp_servers: [{ name, status }]`) and any later event carrying the
 * same field shape.
 *
 * @param {any} evt
 * @returns {string[]}
 */
export function extractFailedMcpServers(evt) {
  if (!evt || evt.type !== "system" || evt.subtype !== "init") return []
  const servers = Array.isArray(evt.mcp_servers) ? evt.mcp_servers : []
  return servers
    .filter((s) => s && typeof s.name === "string" && s.status === "failed")
    .map((s) => s.name)
}

/**
 * Create the per-session auto-reconnector. Feed every SDK event through
 * `onEvent(evt)`; when the init report names failed servers, each is
 * reconnected once (fire-and-forget — the reconnect result surfaces through
 * the SDK's own status, the live-session card, and the mcp_log panel).
 *
 * @param {{
 *   reconnect: (name: string) => Promise<unknown>,   // q.reconnectMcpServer
 *   log?: (level: "info"|"warn"|"error", message: string) => void,
 *   emitMcpLog?: (entry: { level: "error"|"warn"|"info"|"debug", message: string, server?: string, source?: "stderr"|"diagnostic" }) => void,
 *   delayMs?: number,        // pause before reconnecting (default 750ms)
 *   maxPerServer?: number,   // auto-reconnect budget per server (default 1)
 * }} params
 * @returns {{ onEvent: (evt: any) => void, attempted: () => string[] }}
 */
export function createMcpAutoReconnector({
  reconnect,
  log,
  emitMcpLog,
  delayMs = 750,
  maxPerServer = 1,
}) {
  /** @type {Map<string, number>} attempts per server this session */
  const attempts = new Map()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const diag = (server, level, message) =>
    emitMcpLog?.({ level, message, server, source: "diagnostic" })

  const reconnectOne = async (name) => {
    const used = attempts.get(name) ?? 0
    if (used >= maxPerServer) return
    attempts.set(name, used + 1)
    if (delayMs > 0) await sleep(delayMs)
    diag(name, "info", "failed on first connect — auto-reconnecting")
    try {
      await reconnect(name)
      log?.("info", `mcp "${name}": auto-reconnect issued after failed first connect`)
      diag(name, "info", "auto-reconnect issued")
    } catch (err) {
      const reason = err?.message ?? String(err)
      log?.("warn", `mcp "${name}": auto-reconnect failed: ${reason}`)
      diag(name, "warn", `auto-reconnect failed: ${reason}`)
    }
  }

  return {
    onEvent(evt) {
      for (const name of extractFailedMcpServers(evt)) {
        // Fire-and-forget: the reconnect must never stall the event pipe.
        void reconnectOne(name)
      }
    },
    attempted: () => [...attempts.keys()],
  }
}
