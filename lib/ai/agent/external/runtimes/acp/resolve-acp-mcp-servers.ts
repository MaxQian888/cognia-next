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
 * Selection and credentials follow the chat send path exactly:
 * - only servers live for the run's workspace pass (`listEnabledMcpServers`:
 *   enabled, trusted or legacy, not switched off by the workspace overlay), so
 *   a pending or blocked server is never handed to a foreign process;
 * - keyring SecretRefs and desktop OAuth bearer headers are resolved through
 *   the shared run map (`buildRunMcpServerMap`), so a credentialed server
 *   arrives connectable instead of with its secrets silently stripped;
 * - an ACP session config has no field for per-tool restrictions, so a server
 *   carrying deny or ask rules is refused rather than forwarded unrestricted.
 *
 * The store's transport `config` is a superset of each ACP shape, so the mapping
 * is a straight projection: stdio → {name,command,args,env}; http/sse →
 * {type,name,url,headers}. `env`/`headers` are converted from the store's
 * `Record<string,string>` to the ACP `Array<{name,value}>` form. Servers missing
 * a required field (a stdio server with no `command`, a remote server with no
 * `url`) are dropped rather than shipped malformed.
 */

import type { McpServer } from "@cognia/agent-config-types"
import type { McpServerWireConfig } from "@cognia/agent-config-types/claude-agent-sdk-options"

import type { WorkspaceCapabilityScope } from "@/lib/db/workspace-capabilities"
import { normalizeToolPermissionRules, normalizeToolRuleList } from "@/lib/mcp/tool-rules"
import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

function toNameValuePairs(record: unknown): Array<{ name: string; value: string }> | undefined {
  if (!record || typeof record !== "object") return undefined
  const pairs = Object.entries(record as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, value: v as string }))
  return pairs.length > 0 ? pairs : undefined
}

/** Project one enabled MCP server into an ACP config, or `null` if malformed. */
export function mcpServerToAcpConfig(
  server: Pick<McpServer, "name" | "config" | "transport">
): AcpMcpServerConfig | null {
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

export interface ResolveAcpMcpServersOptions {
  /** The run's workspace; omitted means the active one. */
  scope?: WorkspaceCapabilityScope
  listServers?: (scope?: WorkspaceCapabilityScope) => Promise<McpServer[]>
  buildServerMap?: (servers: McpServer[]) => Promise<Record<string, McpServerWireConfig>>
}

/** True when the server has any per-tool deny or ask rule an ACP child cannot enforce. */
function hasToolRestrictions(server: McpServer): boolean {
  return (
    normalizeToolRuleList(server.disallowedTools).length > 0 ||
    normalizeToolRuleList(server.disallowedToolPatterns).length > 0 ||
    normalizeToolPermissionRules(server.toolPermissionRules).length > 0
  )
}

/**
 * Resolve the given MCP-server ids (or names, as a fallback) to `AcpMcpServerConfig[]`.
 * Returns `[]` for an empty id list. Ids that are unknown, disabled, untrusted
 * or off in the run's workspace resolve to nothing. Throws when an assigned
 * server carries tool restrictions the external runtime cannot enforce.
 */
export async function resolveAcpMcpServers(
  ids: string[],
  options: ResolveAcpMcpServersOptions = {}
): Promise<AcpMcpServerConfig[]> {
  if (!ids || ids.length === 0) return []
  const listServers =
    options.listServers ?? (await import("@/lib/db/mcp-servers")).listEnabledMcpServers
  const live = await listServers(options.scope)
  const wanted = new Set(ids)
  const chosen: McpServer[] = []
  const seen = new Set<string>()
  for (const server of live) {
    if (!wanted.has(server.id) && !wanted.has(server.name)) continue
    if (seen.has(server.name)) continue // ACP keys by name; keep the first.
    seen.add(server.name)
    chosen.push(server)
  }
  const restricted = chosen.filter(hasToolRestrictions).map((server) => server.name)
  if (restricted.length > 0) {
    throw new Error(
      `External runtime cannot enforce the tool restrictions of MCP server ${restricted.join(", ")}`
    )
  }
  if (chosen.length === 0) return []
  const buildServerMap =
    options.buildServerMap ?? (await import("@/lib/mcp/run-server-map")).buildRunMcpServerMap
  const map = await buildServerMap(chosen)
  const out: AcpMcpServerConfig[] = []
  for (const [name, config] of Object.entries(map)) {
    const acp = mcpServerToAcpConfig({
      name,
      transport: config.type ?? "stdio",
      config: config as McpServer["config"],
    })
    if (acp) out.push(acp)
  }
  return out
}

/** The per-tool restrictions a turn's SendOptions carry for its MCP servers. */
export interface ResolvedMcpRestrictions {
  disallowedTools?: readonly string[]
  toolPermissionRules?: ReadonlyArray<{ tool: string }>
  mcpToolAllowlist?: Record<string, readonly string[]>
}

/** Names of forwarded servers the turn restricts per tool. */
function restrictedServerNames(names: string[], restrictions: ResolvedMcpRestrictions): string[] {
  const governed = (tool: string, name: string) =>
    tool === `mcp__${name}` || tool.startsWith(`mcp__${name}__`)
  return names.filter(
    (name) =>
      Object.hasOwn(restrictions.mcpToolAllowlist ?? {}, name) ||
      (restrictions.disallowedTools ?? []).some((tool) => governed(tool, name)) ||
      (restrictions.toolPermissionRules ?? []).some((rule) => governed(rule.tool, name))
  )
}

/** Project the already-authorized, credential-resolved map from SendOptions.
 * This preserves the canonical turn subset instead of rereading the MCP registry.
 * An ACP session config cannot carry per-tool restrictions, so a server the
 * turn restricts (deny rules, ask rules, a mode's tool selection) is refused
 * rather than forwarded with all of its tools.
 */
export function resolvedMcpServerMapToAcpConfigs(
  servers?: Record<string, Record<string, unknown>>,
  restrictions: ResolvedMcpRestrictions = {}
): AcpMcpServerConfig[] {
  const restricted = restrictedServerNames(Object.keys(servers ?? {}), restrictions)
  if (restricted.length > 0) {
    throw new Error(
      `External runtime cannot enforce the tool restrictions of MCP server ${restricted.join(", ")}`
    )
  }
  return Object.entries(servers ?? {}).map(([name, config]) => {
    const transport = config.type ?? (typeof config.command === "string" ? "stdio" : "http")
    if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
      throw new Error(`MCP server ${name} cannot be forwarded to an external runtime`)
    }
    const projected = mcpServerToAcpConfig({ name, transport, config })
    if (!projected) throw new Error(`MCP server ${name} has incomplete connection settings`)
    return projected
  })
}
