// Bridges the sidecar's per-MCP-server `mcp_log` events into the unified
// logging pipeline so the GUI can render them. The sidecar already produces
// structured per-server diagnostics (connect success/failure, `tools()`
// failures, captured child `stderr`) as `mcp_log` events — but on the GUI side
// `handleEvent` (hooks/chat/use-claude-chat.ts) has no `mcp_log` branch, so
// they were silently dropped. Only the CLI/TUI consumed them.
//
// By forwarding each event into `loggers.mcp.child(server)` tagged
// `runtime/origin: "mcp"`, the entry lands in the existing IndexedDB log store
// and `getLogSource()` (components/logging/log-panel.tsx) classifies it as the
// "mcp" source — so `<LogPanel sources={["mcp"]} />` and the per-server module
// filter (`mcp:<server>`) render them with zero new list UI.
//
// Mirrors the shape of `subscribeToUsageHeaders`
// (lib/subscription/anthropic/usage-collector.ts): a single `onClaudeMessage`
// subscription returning an async unsubscribe.

import { onClaudeMessage } from "@/lib/claude/ipc"
import { isMcpLogEvent, type McpLogEvent } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

/** Module suffix used when a log line can't be attributed to a named server. */
export const MCP_LOG_UNKNOWN_SERVER = "unknown"

/**
 * Cap on distinct `mcp:<server>` child-logger modules. Server names are parsed
 * from arbitrary stderr tokens (see `mcp-log.mjs:extractServerName`), so a
 * chatty / adversarial stream emitting unique tokens (e.g. `[req-a1b2]`) could
 * otherwise register unbounded logger modules — a slow leak in the long-lived
 * desktop process. Past the cap, novel names collapse to the unknown module for
 * routing while their real name still rides in `data.server`.
 */
const MAX_TRACKED_MODULES = 64
const trackedServers = new Set<string>()

function moduleServerName(server: string): string {
  if (server === MCP_LOG_UNKNOWN_SERVER || trackedServers.has(server)) return server
  if (trackedServers.size >= MAX_TRACKED_MODULES) return MCP_LOG_UNKNOWN_SERVER
  trackedServers.add(server)
  return server
}

/** Test-only: clear the process-global module-tracking set between cases. */
export function __resetMcpLogModuleTracking(): void {
  trackedServers.clear()
}

/**
 * Forward a single `mcp_log` event into the unified logger. The child module
 * is `mcp:<server>` so the log panel's module filter can scope to one server;
 * `runtime`/`origin` are set to `"mcp"` so the entry is classified as the "mcp"
 * source. `server`/`source` ride along in `data` for the detail sidebar.
 */
export function forwardMcpLog(evt: McpLogEvent): void {
  const server = evt.server?.trim() || MCP_LOG_UNKNOWN_SERVER
  const log = loggers.mcp.child(moduleServerName(server))
  const data = {
    runtime: "mcp",
    origin: "mcp",
    server,
    source: evt.source ?? "stderr",
    sessionId: evt.sessionId,
  }

  switch (evt.level) {
    case "error":
      // CoreLogger.error signature is (message, error, data).
      log.error(evt.message, undefined, data)
      return
    case "warn":
      log.warn(evt.message, data)
      return
    case "debug":
      log.debug(evt.message, data)
      return
    default:
      log.info(evt.message, data)
  }
}

/**
 * Subscribe to live `mcp_log` events from the sidecar and forward each into the
 * unified logger. Returns the same `Unlisten` shape Tauri uses elsewhere.
 *
 * Outside Tauri (plain browser), `onClaudeMessage` requires the IPC listener
 * which only exists inside the desktop / companion shell; callers should guard
 * with `isTauri()` upstream (see McpLogProvider).
 */
export async function subscribeToMcpLogs(): Promise<() => void> {
  const unlisten = await onClaudeMessage((evt) => {
    if (!isMcpLogEvent(evt)) return
    forwardMcpLog(evt)
  })
  return unlisten
}
