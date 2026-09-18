/**
 * Host-side constructors for `TrustedMemoryCaller` — one per transport.
 *
 * Each constructor takes ONLY context the host controls: the plugin id the
 * plugin manager bound, the `callerDeviceId` the Rust RPC layer injected
 * (which overwrites whatever the client sent), or nothing at all for the
 * in-process account owner. Nothing here reads request payload fields — that
 * is the whole point of the type.
 *
 * `namespaces` stays `undefined` on every transport today: the documented
 * `memory:read`/`memory:write` scope is the account's own data plane, and the
 * per-principal grant store that would populate the sets has not landed yet.
 * The sets exist so grants slot in at these constructors without another
 * signature change on the api/* functions.
 */

import type { TrustedMemoryCaller } from "@cognia/memory/types/caller"

/** The interactive account owner — `/memory` surfaces, slash commands. */
export function localUserCaller(): TrustedMemoryCaller {
  return { principalId: "local-user", transport: "local-ui" }
}

/** The TUI memory controller — same authority as the local UI. */
export function cliCaller(): TrustedMemoryCaller {
  return { principalId: "cli:tui", transport: "cli" }
}

/** The local MCP bridge process serving configured clients. */
export function mcpCaller(): TrustedMemoryCaller {
  return { principalId: "mcp:bridge", transport: "mcp" }
}

/**
 * A plugin acting through `ctx.memory`. `pluginId` is injected by the plugin
 * manager at API-factory time — a plugin cannot assert another plugin's id.
 */
export function pluginCaller(pluginId: string): TrustedMemoryCaller {
  return { principalId: `plugin:${pluginId}`, transport: "plugin" }
}

/**
 * A remote companion client. `callerDeviceId` is the value the Rust RPC layer
 * stamps over the client's self-asserted id; absent on routes that do not
 * inject it, where the principal degrades to the transport-level one.
 */
export function companionCaller(callerDeviceId?: string): TrustedMemoryCaller {
  return {
    principalId: callerDeviceId ? `companion:${callerDeviceId}` : "companion:device",
    transport: "companion",
  }
}

/** A workflow node performing a memory operation inside an execution run. */
export function workflowCaller(runId?: string): TrustedMemoryCaller {
  return { principalId: runId ? `workflow:${runId}` : "workflow", transport: "workflow" }
}

/** An internal maintenance/extraction worker. */
export function internalJobCaller(workerId: string): TrustedMemoryCaller {
  return { principalId: `job:${workerId}`, transport: "internal-job" }
}
