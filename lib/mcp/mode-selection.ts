/**
 * A custom agent mode's MCP tool selection, applied to one run.
 *
 * The mode editor stores the picked tools as `{ serverId, toolName }` pairs
 * (`CustomModeConfig.mcpTools`). A non-empty selection narrows the run twice:
 * only the servers it names stay attached, and on those servers every other
 * known tool is denied. An absent or empty selection does not restrict MCP at
 * all: the editor saves `[]` for every mode whose author never opened the MCP
 * picker, so reading it as "no MCP" would silently strip MCP from them.
 *
 * Tool narrowing is enforced by the runtime as an allowlist
 * (`SendOptions.mcpToolAllowlist`, checked by the sidecar's permission ladder,
 * its Claude PreToolUse hook and its AI SDK MCP bridge), so a tool the server
 * adds after its last discovery is refused too. The known unselected tools are
 * also put on the deny list, so the model is not offered them in the first
 * place.
 */

import type { McpServer } from "@cognia/agent-config-types"

export interface ModeMcpToolReference {
  serverId: string
  toolName: string
}

/** The selection a mode carries, or `undefined` when it does not restrict MCP. */
export function modeMcpSelection(mode: unknown): ModeMcpToolReference[] | undefined {
  const raw = (mode as { mcpTools?: unknown } | undefined)?.mcpTools
  if (!Array.isArray(raw)) return undefined
  const selection = raw.filter(
    (entry): entry is ModeMcpToolReference =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as ModeMcpToolReference).serverId === "string" &&
      typeof (entry as ModeMcpToolReference).toolName === "string" &&
      (entry as ModeMcpToolReference).toolName.trim().length > 0
  )
  return selection.length > 0 ? selection : undefined
}

/** Keep only the servers the selection names. */
export function filterServersByModeSelection<T extends Pick<McpServer, "id">>(
  servers: readonly T[],
  selection: readonly ModeMcpToolReference[]
): T[] {
  const wanted = new Set(selection.map((entry) => entry.serverId))
  return servers.filter((server) => wanted.has(server.id))
}

/** The runtime allowlist: each attached server's key → the tools the mode picked on it. */
export function buildModeMcpToolAllowlist(
  servers: ReadonlyArray<Pick<McpServer, "id" | "name">>,
  selection: readonly ModeMcpToolReference[]
): Record<string, string[]> {
  const allowlist: Record<string, string[]> = {}
  for (const server of servers) {
    const tools = selection
      .filter((entry) => entry.serverId === server.id)
      .map((entry) => entry.toolName.trim())
    if (tools.length > 0) allowlist[server.name] = [...new Set(tools)].sort()
  }
  return allowlist
}

/**
 * SDK-namespaced names (`mcp__<server>__<tool>`) of every known tool on the
 * attached servers that the selection did not pick.
 */
export async function resolveModeMcpDeniedToolNames(
  servers: ReadonlyArray<Pick<McpServer, "id" | "name">>,
  selection: readonly ModeMcpToolReference[],
  loadToolNames: (serverId: string) => Promise<string[]>
): Promise<string[]> {
  const picked = new Map<string, Set<string>>()
  for (const entry of selection) {
    const tools = picked.get(entry.serverId) ?? new Set<string>()
    tools.add(entry.toolName.trim())
    picked.set(entry.serverId, tools)
  }
  const denied = new Set<string>()
  await Promise.all(
    servers.map(async (server) => {
      const keep = picked.get(server.id)
      if (!keep) return
      const namespace = server.name.trim()
      for (const tool of await loadToolNames(server.id)) {
        if (!keep.has(tool)) denied.add(`mcp__${namespace}__${tool}`)
      }
    })
  )
  return [...denied].sort()
}
