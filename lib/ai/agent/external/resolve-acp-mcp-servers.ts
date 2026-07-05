/**
 * Resolve Cognia MCP-server ids → the ACP `mcpServers` array an external agent
 * session accepts (`AcpMcpServerConfig[]`).
 *
 * When a teammate/subagent is backed by an external CLI, its explicitly-assigned
 * MCP servers should be handed to that CLI's ACP session (`session/new`
 * `mcpServers`) so the external agent can call the SAME tools a built-in
 * `runtime:"claude"` teammate would get. The manager already forwards
 * `options.context.custom.mcpServers` into `buildSessionOptions`
 * (`manager.ts:1489`), so this resolver only has to produce the array.
 *
 * Deliberately conservative: it resolves ONLY the ids passed in (a teammate's
 * resolved capability set), never "all enabled" — forwarding the host's entire
 * MCP registry into a foreign agent process by default would be surprising and
 * leak servers the teammate was never granted. External agents keep their own
 * MCP config (e.g. `~/.codex/config.toml`) regardless, so an empty result simply
 * means "no host-forwarded servers", not "no tools".
 *
 * The store's transport `config` is a superset of each ACP shape, so the mapping
 * is a straight projection: stdio → {name,command,args,env}; http/sse →
 * {type,name,url,headers}. `env`/`headers` are converted from the store's
 * `Record<string,string>` to the ACP `Array<{name,value}>` form. Servers missing
 * a required field (a stdio server with no `command`, a remote server with no
 * `url`) are dropped rather than shipped malformed.
 */

import type { McpServer } from "@/lib/claude/types"
import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

function toNameValuePairs(record: unknown): Array<{ name: string; value: string }> | undefined {
  if (!record || typeof record !== "object") return undefined
  const pairs = Object.entries(record as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, value: v as string }))
  return pairs.length > 0 ? pairs : undefined
}

/** Project one enabled MCP server into an ACP config, or `null` if malformed. */
export function mcpServerToAcpConfig(server: McpServer): AcpMcpServerConfig | null {
  const cfg = (server.config ?? {}) as Record<string, unknown>
  if (server.transport === "stdio") {
    const command = typeof cfg.command === "string" ? cfg.command : undefined
    if (!command) return null
    const args = Array.isArray(cfg.args)
      ? (cfg.args.filter((a) => typeof a === "string") as string[])
      : []
    const env = toNameValuePairs(cfg.env)
    return { name: server.name, command, args, ...(env ? { env } : {}) }
  }
  if (server.transport === "http" || server.transport === "sse") {
    const url = typeof cfg.url === "string" ? cfg.url : undefined
    if (!url) return null
    const headers = toNameValuePairs(cfg.headers)
    return { type: server.transport, name: server.name, url, ...(headers ? { headers } : {}) }
  }
  // Unknown / unsupported transport (e.g. an in-process bridge) — nothing an
  // external CLI process can dial into.
  return null
}

/**
 * Resolve the given MCP-server ids (or names, as a fallback) to `AcpMcpServerConfig[]`.
 * Returns `[]` for an empty id list, an unknown id, or any disabled server.
 */
export async function resolveAcpMcpServers(ids: string[]): Promise<AcpMcpServerConfig[]> {
  if (!ids || ids.length === 0) return []
  const { listMcpServers } = await import("@/lib/db/mcp-servers")
  const all = await listMcpServers()
  const wanted = new Set(ids)
  const out: AcpMcpServerConfig[] = []
  const seen = new Set<string>()
  for (const server of all) {
    if (!server.enabled) continue
    if (!wanted.has(server.id) && !wanted.has(server.name)) continue
    if (seen.has(server.name)) continue // ACP keys by name; keep the first.
    const acp = mcpServerToAcpConfig(server)
    if (acp) {
      out.push(acp)
      seen.add(server.name)
    }
  }
  return out
}
