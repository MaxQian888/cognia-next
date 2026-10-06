/**
 * Host-side constructors for `TrustedMemoryCaller` — one per transport.
 *
 * Each constructor takes ONLY context the host controls: the plugin id the
 * plugin manager bound, the `callerDeviceId` the Rust RPC layer injected
 * (which overwrites whatever the client sent), or nothing at all for the
 * in-process account owner. Nothing here reads request payload fields — that
 * is the whole point of the type.
 *
 * Constructors bind identity only. Persisted namespace restrictions are
 * intersected at each operation, so revocation also affects cached callers.
 */

import type { MemoryCallerNamespaces, TrustedMemoryCaller } from "@cognia/memory/types/caller"
import type { MemoryConfig } from "@/types/memory/memory"

/** Stored restrictions can narrow a host binding, never widen it. */
export function resolveMemoryCaller(
  caller: TrustedMemoryCaller,
  config: Pick<MemoryConfig, "principalGrants">
): TrustedMemoryCaller {
  const grants = config.principalGrants
  if (!grants) return caller
  const keys = [`transport:${caller.transport}`, caller.principalId]
  let namespaces = caller.namespaces
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(grants, key)) continue
    const grant = grants[key]
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      namespaces = { scopes: [] }
      continue
    }
    const merged: MemoryCallerNamespaces = { ...namespaces }
    for (const dimension of ["scopes", "projects", "characterIds", "agentIds"] as const) {
      if (!Object.prototype.hasOwnProperty.call(grant, dimension)) continue
      const value = grant[dimension]
      const allowed =
        Array.isArray(value) && value.every((id) => typeof id === "string") ? value : []
      merged[dimension] = namespaces?.[dimension]?.filter((id) => allowed.includes(id)) ?? allowed
    }
    namespaces = merged
  }
  return { ...caller, namespaces }
}

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
