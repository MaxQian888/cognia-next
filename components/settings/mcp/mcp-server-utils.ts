/**
 * Pure helpers shared across the MCP servers panel components — config
 * summarization, the structured ⇄ test-request transform, and the key/value
 * row model used by the editor. Extracted from the legacy
 * `mcp-servers-section.tsx` so the card / list-row / editor can share one
 * implementation instead of each re-deriving it.
 */

import type { McpServer, McpTransport } from "@cognia/agent-config-types"
import type { McpTestRequest } from "@/lib/claude/ipc"

export interface KvRow {
  key: string
  value: string
}

/** The minimal server shape the editor round-trips (no id/timestamps). */
export type McpEditorInitial = Pick<
  McpServer,
  "name" | "transport" | "config" | "enabled" | "appsEnabled"
>

export function objectToKvRows(obj: unknown): KvRow[] {
  if (!obj || typeof obj !== "object") return []
  return Object.entries(obj as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: String(v ?? ""),
  }))
}

export function kvRowsToObject(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.key.trim()
    if (k) out[k] = row.value
  }
  return out
}

/**
 * One-line config summary shown under the server name. Pure: returns the
 * technical command/url join, or `""` when nothing is configured — callers
 * supply their own (i18n) fallback for the empty case. Accepts the minimal
 * `transport`/`config` shape so unsaved import drafts can reuse it.
 */
export function summarizeServer(s: Pick<McpServer, "transport" | "config">): string {
  const c = s.config as { command?: string; url?: string; args?: string[] }
  if (s.transport === "stdio") {
    return [c.command, ...(c.args ?? [])].filter(Boolean).join(" ")
  }
  return c.url ?? ""
}

/** Project a stored server row into the IPC test-connection request shape. */
export function serverToTestRequest(s: McpServer): McpTestRequest {
  const c = s.config as Record<string, unknown>
  if (s.transport === "stdio") {
    return {
      transport: "stdio",
      command: typeof c.command === "string" ? c.command : "",
      args: Array.isArray(c.args) ? c.args.filter((x): x is string => typeof x === "string") : [],
      env:
        c.env && typeof c.env === "object"
          ? Object.fromEntries(
              Object.entries(c.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])
            )
          : undefined,
    }
  }
  return {
    transport: s.transport,
    url: typeof c.url === "string" ? c.url : "",
    headers:
      c.headers && typeof c.headers === "object"
        ? Object.fromEntries(
            Object.entries(c.headers as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v ?? ""),
            ])
          )
        : undefined,
  }
}

/**
 * Build a fresh "clone" draft from an existing server: deep-copies the config,
 * appends a " copy" suffix to the name, and carries over the per-agent
 * projection so the duplicate lands in the same agent files.
 */
export function cloneServerDraft(s: McpServer): McpEditorInitial {
  return {
    name: `${s.name} copy`,
    transport: s.transport,
    config: structuredClone(s.config),
    enabled: s.enabled,
    appsEnabled: { ...(s.appsEnabled ?? {}) },
  }
}

export const MCP_TRANSPORT_VALUES: McpTransport[] = ["stdio", "sse", "http"]

export type McpGroupBy = "none" | "transport" | "status"

export interface McpServerGroup {
  /** Stable key for React lists. */
  id: string
  /** How the section header should be rendered. */
  headerKind: "none" | "transport" | "status"
  /** The transport literal or status token; empty for `none`. */
  headerValue: string
  servers: McpServer[]
}

/**
 * Partition + order servers for the list view. Favorites always float to the
 * top *within* each group (preserving the incoming alphabetical order among
 * peers). `none` yields a single header-less group; `transport`/`status`
 * yield one section per bucket in a stable order.
 */
export function groupServers(
  servers: McpServer[],
  groupBy: McpGroupBy,
  isFavorite: (id: string) => boolean
): McpServerGroup[] {
  const floatFavorites = (list: McpServer[]): McpServer[] => {
    const favs = list.filter((s) => isFavorite(s.id))
    const rest = list.filter((s) => !isFavorite(s.id))
    return [...favs, ...rest]
  }

  if (groupBy === "none") {
    return [{ id: "all", headerKind: "none", headerValue: "", servers: floatFavorites(servers) }]
  }

  if (groupBy === "transport") {
    return MCP_TRANSPORT_VALUES.map((tr) => ({
      id: `transport:${tr}`,
      headerKind: "transport" as const,
      headerValue: tr,
      servers: floatFavorites(servers.filter((s) => s.transport === tr)),
    })).filter((g) => g.servers.length > 0)
  }

  // status
  return (["enabled", "disabled"] as const)
    .map((status) => ({
      id: `status:${status}`,
      headerKind: "status" as const,
      headerValue: status,
      servers: floatFavorites(
        servers.filter((s) => (status === "enabled" ? s.enabled : !s.enabled))
      ),
    }))
    .filter((g) => g.servers.length > 0)
}
