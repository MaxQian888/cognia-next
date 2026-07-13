import type { AgentId, McpServer, McpTransport } from "@cognia/agent-config-types"
import { CLAUDE_CODE_AGENT } from "@/lib/claude/agents/claude-code"
import { getDb } from "./schema"

function newId() {
  return "mcp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listMcpServers(): Promise<McpServer[]> {
  return getDb().mcpServers.orderBy("name").toArray()
}

export async function listEnabledMcpServers(): Promise<McpServer[]> {
  // `enabled` is indexed but we treat the boolean stored value as 1/0 via
  // Dexie's filtering — equality on booleans is supported.
  return getDb()
    .mcpServers.filter((s) => s.enabled)
    .toArray()
}

export async function getMcpServer(id: string): Promise<McpServer | undefined> {
  return getDb().mcpServers.get(id)
}

export async function createMcpServer(
  partial: Pick<McpServer, "name" | "transport" | "config"> & {
    enabled?: boolean
    appsEnabled?: McpServer["appsEnabled"]
    /** Optional plugin origin tag (§A-6). Set by the plugin manager only. */
    pluginId?: string
  }
): Promise<McpServer> {
  const now = Date.now()
  const server: McpServer = {
    id: newId(),
    name: partial.name.trim() || "unnamed",
    transport: partial.transport,
    config: partial.config,
    enabled: partial.enabled ?? true,
    appsEnabled: partial.appsEnabled ?? {},
    // Tag the row only when explicitly provided so user-created rows stay
    // structurally identical to pre-port serialized data.
    ...(partial.pluginId !== undefined ? { pluginId: partial.pluginId } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await getDb().mcpServers.put(server)
  scheduleSyncFor(server.appsEnabled)
  return server
}

/**
 * List MCP server rows owned by a single plugin. Used by the plugin manager
 * during disable / uninstall to enumerate rows for soft-disable / deletion.
 */
export async function listMcpServersByPlugin(pluginId: string): Promise<McpServer[]> {
  // `pluginId` is non-indexed (sparsely populated); the in-memory filter
  // matches the existing pattern used by `listEnabledMcpServers`.
  return getDb()
    .mcpServers.filter((s) => s.pluginId === pluginId)
    .toArray()
}

export async function updateMcpServer(
  id: string,
  patch: Partial<Pick<McpServer, "name" | "transport" | "config" | "enabled" | "appsEnabled">>
): Promise<void> {
  // Capture the row's pre-patch apps map so we sync agents the toggle was
  // *removed* from (otherwise we'd never delete from those files).
  const prev = await getDb().mcpServers.get(id)
  await getDb().mcpServers.update(id, { ...patch, updatedAt: Date.now() })
  const merged = { ...(prev?.appsEnabled ?? {}), ...(patch.appsEnabled ?? {}) }
  scheduleSyncFor(merged)
}

export async function deleteMcpServer(id: string): Promise<void> {
  // Capture the deleted row's name + apps so the sync for those agents drops
  // the server out of their files (otherwise the entry would survive — after
  // delete, the name is no longer in `managedNames`, so the next project()
  // wouldn't know to remove it).
  const prev = await getDb().mcpServers.get(id)
  await getDb().mcpServers.delete(id)
  if (prev) scheduleSyncFor(prev.appsEnabled, prev.name)
}

/**
 * Fire-and-forget: lazily import the sync orchestrator so the DB module
 * stays self-contained (and the import doesn't bring Tauri IPC into web /
 * SSR contexts where it would error). `tombstone` is the name of a deleted
 * server that should be removed from the target agents' files.
 */
function scheduleSyncFor(apps: McpServer["appsEnabled"], tombstone?: string): void {
  if (!apps) return
  const ids: AgentId[] = []
  for (const [agentId, enabled] of Object.entries(apps)) {
    if (enabled) ids.push(agentId as AgentId)
  }
  if (ids.length === 0) return
  void import("@/lib/claude/sync")
    .then(({ scheduleSync }) => {
      for (const id of ids) scheduleSync(id, tombstone)
    })
    .catch(() => {
      // Sync is best-effort; failure shouldn't block CRUD success.
    })
}

/**
 * Build the `mcpServers` map the SDK expects, keyed by server name. Entries
 * are inserted in sorted-name order so the map serializes identically across
 * turns — unstable key order silently breaks provider prompt-cache prefix
 * matching.
 */
export function buildMcpServerMap(servers: McpServer[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name))
  for (const s of sorted) {
    if (!s.enabled) continue
    out[s.name] = { type: s.transport, ...s.config }
  }
  return out
}

/** A remote MCP server's stored OAuth state, projected for header injection. */
export interface McpAuthInjection {
  accessToken?: string
  /** Absolute expiry (epoch ms), when the provider returned one. */
  expiresAtMs?: number
}

export interface BuildMcpAuthDeps {
  /** Load a server's stored OAuth entry by server NAME (keyring-backed on desktop). */
  loadEntry: (serverName: string) => Promise<McpAuthInjection | undefined>
  /** Optionally refresh a near-expiry token; returns the refreshed entry. */
  refresh?: (serverName: string) => Promise<McpAuthInjection | undefined>
  /** Refresh when the token expires within this many ms. Default 60s. */
  refreshSkewMs?: number
  now?: () => number
}

/**
 * Like {@link buildMcpServerMap}, but injects `Authorization: Bearer <token>`
 * into each remote (sse/http) server's `headers` from its stored OAuth entry —
 * the desktop's send-time auth for OAuth-protected MCP servers. The Claude
 * Agent SDK's `mcpServers` config has no `authProvider` hook, so a static
 * header (refreshed just-in-time) is the only auth lever on the Anthropic path;
 * the ai-sdk path consumes the same `requestInit.headers`.
 *
 * Pure given its injected deps so it unit-tests without the keyring. stdio
 * servers and servers with no stored token pass through unchanged.
 */
export async function buildMcpServerMapWithAuth(
  servers: McpServer[],
  deps: BuildMcpAuthDeps
): Promise<Record<string, Record<string, unknown>>> {
  const base = buildMcpServerMap(servers)
  const now = deps.now ?? (() => Date.now())
  const skew = deps.refreshSkewMs ?? 60_000
  const byName = new Map(servers.filter((s) => s.enabled).map((s) => [s.name, s]))
  const out: Record<string, Record<string, unknown>> = {}

  for (const [name, cfg] of Object.entries(base)) {
    const server = byName.get(name)
    if (!server || server.transport === "stdio") {
      out[name] = cfg
      continue
    }
    let entry: McpAuthInjection | undefined
    try {
      entry = await deps.loadEntry(name)
      if (entry?.expiresAtMs && deps.refresh && entry.expiresAtMs - now() < skew) {
        entry = (await deps.refresh(name)) ?? entry
      }
    } catch {
      // Auth lookup is best-effort — fall back to the un-authed config.
      entry = undefined
    }
    if (entry?.accessToken) {
      const existing = (cfg.headers as Record<string, string> | undefined) ?? {}
      out[name] = { ...cfg, headers: { ...existing, Authorization: `Bearer ${entry.accessToken}` } }
    } else {
      out[name] = cfg
    }
  }
  return out
}

export const MCP_TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"]

export type McpImportStrategy = "skip" | "duplicate" | "overwrite"

export interface McpImportDraft {
  name: string
  transport: McpTransport
  config: Record<string, unknown>
}

export interface McpBulkImportResult {
  created: number
  updated: number
  skipped: number
  errored: Array<{ name: string; error: string }>
}

/**
 * Bulk-create MCP servers from drafts. On name collision (case-insensitive),
 * behavior depends on `strategy`:
 *   - skip: leave the existing record alone; counted as `skipped`.
 *   - duplicate: create with " (imported)" suffix on the name.
 *   - overwrite: update the existing record.
 */
export async function bulkImportMcpServers(
  drafts: McpImportDraft[],
  strategy: McpImportStrategy = "skip"
): Promise<McpBulkImportResult> {
  const result: McpBulkImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errored: [],
  }
  const existing = await listMcpServers()
  const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]))

  for (const draft of drafts) {
    try {
      if (!draft.name?.trim()) {
        throw new Error("Server is missing a name.")
      }
      const collision = byName.get(draft.name.trim().toLowerCase())
      if (!collision) {
        const created = await createMcpServer({
          name: draft.name.trim(),
          transport: draft.transport,
          config: draft.config,
        })
        byName.set(created.name.toLowerCase(), created)
        result.created += 1
        continue
      }
      if (strategy === "skip") {
        result.skipped += 1
        continue
      }
      if (strategy === "overwrite") {
        await updateMcpServer(collision.id, {
          transport: draft.transport,
          config: draft.config,
        })
        result.updated += 1
        continue
      }
      // duplicate path
      const renamed = `${draft.name} (imported)`
      const created = await createMcpServer({
        name: renamed,
        transport: draft.transport,
        config: draft.config,
      })
      byName.set(created.name.toLowerCase(), created)
      result.created += 1
    } catch (err) {
      result.errored.push({
        name: draft.name ?? "(unnamed)",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/**
 * Parse the `mcpServers` block from a Claude Code user config (`~/.claude.json`)
 * into our import-ready draft shape. Forgiving — skips malformed entries.
 *
 * Delegates to {@link CLAUDE_CODE_AGENT}, which also folds in
 * `projects[].mcpServers`.
 */
export function parseClaudeMcpConfig(raw: unknown): McpImportDraft[] {
  return CLAUDE_CODE_AGENT.parse(raw)
}
