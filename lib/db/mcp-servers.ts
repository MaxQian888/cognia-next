import type {
  AgentId,
  McpServer,
  McpServerConfig,
  McpServerOrigin,
  McpServerTrust,
  McpTransport,
} from "@cognia/agent-config-types"
import { CLAUDE_CODE_AGENT } from "@/lib/claude/agents/claude-code"
import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import { externalizeMcpSecrets, hasMcpSecretRefs, resolveMcpSecrets } from "@/lib/mcp/credentials"
import {
  assertUniqueMcpNamespace,
  fingerprintMcpDefinition,
  normalizeMcpNamespace,
  toMcpServerSummary,
  validateMcpDefinition,
} from "@/lib/mcp/server-definition"
import { validateMcpRemoteEgress } from "@/lib/mcp/policy"
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
    .mcpServers.filter(
      (s) => s.enabled && (!s.trust || s.trust.state === "legacy" || s.trust.state === "trusted")
    )
    .toArray()
}

export async function getMcpServer(id: string): Promise<McpServer | undefined> {
  return getDb().mcpServers.get(id)
}

export async function createMcpServer(
  partial: Pick<McpServer, "name" | "transport" | "config"> & {
    enabled?: boolean
    appsEnabled?: McpServer["appsEnabled"]
    displayName?: string
    origin?: McpServerOrigin
    trust?: McpServerTrust
    /** Optional plugin origin tag (§A-6). Set by the plugin manager only. */
    pluginId?: string
    /** Bare MCP tool names denied whenever this server is selected. */
    disallowedTools?: string[]
  }
): Promise<McpServer> {
  const now = Date.now()
  const origin = partial.origin ?? (partial.pluginId ? "plugin" : "manual")
  const trust = partial.trust ?? { state: "pending" as const }
  const reviewed = trust.state === "trusted" || trust.state === "legacy"
  let server: McpServer = {
    id: newId(),
    name: partial.name.trim(),
    displayName: partial.displayName?.trim() || partial.name.trim(),
    schemaVersion: 1,
    revision: 1,
    credentialVersion: 0,
    origin,
    trust,
    transport: partial.transport,
    config: partial.config,
    enabled: reviewed ? (partial.enabled ?? true) : false,
    appsEnabled: reviewed ? (partial.appsEnabled ?? {}) : {},
    // Tag the row only when explicitly provided so user-created rows stay
    // structurally identical to pre-port serialized data.
    ...(partial.pluginId !== undefined ? { pluginId: partial.pluginId } : {}),
    ...(partial.disallowedTools !== undefined
      ? { disallowedTools: normalizeDisallowedTools(partial.disallowedTools) }
      : {}),
    createdAt: now,
    updatedAt: now,
  }
  validateMcpDefinition(server)
  assertUniqueMcpNamespace(server.name, await listMcpServers())
  server = (await externalizeMcpSecrets(server)).server

  const db = getDb()
  await db.transaction("rw", db.mcpServers, db.mcpServerSummaries, db.mcpSyncJobs, async () => {
    assertUniqueMcpNamespace(server.name, await db.mcpServers.toArray())
    await db.mcpServers.add(server)
    await db.mcpServerSummaries.put(toMcpServerSummary(server))
    await enqueueSyncJobs(server.appsEnabled, server.revision ?? 1)
  })
  wakeSyncCoordinator()
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
  patch: Partial<
    Pick<
      McpServer,
      | "name"
      | "displayName"
      | "transport"
      | "config"
      | "enabled"
      | "appsEnabled"
      | "disallowedTools"
    >
  >
): Promise<void> {
  const db = getDb()
  const prev = await db.mcpServers.get(id)
  if (!prev) return

  const now = Date.now()
  const nextName = patch.name?.trim() ?? prev.name
  let next: McpServer = {
    ...prev,
    ...patch,
    name: nextName,
    displayName: patch.displayName?.trim() || prev.displayName || nextName,
    schemaVersion: 1,
    revision: prev.revision ?? 1,
    credentialVersion: prev.credentialVersion ?? 0,
    origin: prev.origin ?? "manual",
    trust: prev.trust ?? { state: "legacy" },
    updatedAt: now,
  }
  if (patch.disallowedTools !== undefined) {
    next.disallowedTools = normalizeDisallowedTools(patch.disallowedTools)
  }
  validateMcpDefinition(next)
  assertUniqueMcpNamespace(next.name, await db.mcpServers.toArray(), id)

  const beforeFingerprint = fingerprintMcpDefinition(prev)
  const afterFingerprint = fingerprintMcpDefinition(next)
  const materialChange = beforeFingerprint !== afterFingerprint
  if (materialChange) {
    next.revision = (prev.revision ?? 1) + 1
    next.trust = { state: "pending" }
    next.enabled = false
  }
  next = (await externalizeMcpSecrets(next)).server

  const affectedApps = mergeAffectedApps(prev.appsEnabled, next.appsEnabled)
  const renamed = normalizeMcpNamespace(prev.name) !== normalizeMcpNamespace(next.name)
  await db.transaction(
    "rw",
    db.mcpServers,
    db.mcpServerSummaries,
    db.mcpSyncJobs,
    db.mcpCapabilityCache,
    async () => {
      assertUniqueMcpNamespace(next.name, await db.mcpServers.toArray(), id)
      await db.mcpServers.put(next)
      await db.mcpServerSummaries.put(toMcpServerSummary(next))
      if (materialChange || next.credentialVersion !== prev.credentialVersion) {
        await db.mcpCapabilityCache.where("serverId").equals(id).delete()
      }
      await enqueueSyncJobs(affectedApps, next.revision ?? 1, renamed ? [prev.name] : [])
    }
  )
  wakeSyncCoordinator()
}

export async function reviewMcpServer(id: string, trusted: boolean): Promise<void> {
  const db = getDb()
  const server = await db.mcpServers.get(id)
  if (!server) return
  const now = Date.now()
  const next: McpServer = {
    ...server,
    trust: trusted
      ? {
          state: "trusted",
          reviewedFingerprint: fingerprintMcpDefinition(server),
          reviewedAt: now,
        }
      : { state: "blocked" },
    enabled: trusted ? server.enabled : false,
    updatedAt: now,
  }
  await db.transaction("rw", db.mcpServers, db.mcpServerSummaries, db.mcpSyncJobs, async () => {
    await db.mcpServers.put(next)
    await db.mcpServerSummaries.put(toMcpServerSummary(next))
    await enqueueSyncJobs(next.appsEnabled, next.revision ?? 1)
  })
  wakeSyncCoordinator()
}

export async function deleteMcpServer(id: string): Promise<void> {
  // Capture the deleted row's name + apps so the sync for those agents drops
  // the server out of their files (otherwise the entry would survive — after
  // delete, the name is no longer in `managedNames`, so the next project()
  // wouldn't know to remove it).
  const db = getDb()
  const prev = await db.mcpServers.get(id)
  if (!prev) return
  await db.transaction(
    "rw",
    db.mcpServers,
    db.mcpServerSummaries,
    db.mcpSyncJobs,
    db.mcpCapabilityCache,
    async () => {
      await db.mcpServers.delete(id)
      await db.mcpServerSummaries.delete(id)
      await db.mcpCapabilityCache.where("serverId").equals(id).delete()
      await enqueueSyncJobs(prev.appsEnabled, prev.revision ?? 1, [prev.name])
    }
  )
  wakeSyncCoordinator()
}

const WRITABLE_AGENT_IDS = new Set(
  MCP_AGENT_ADAPTERS.filter((adapter) => adapter.writable).map((adapter) => adapter.id)
)

function mergeAffectedApps(
  before: McpServer["appsEnabled"],
  after: McpServer["appsEnabled"]
): McpServer["appsEnabled"] {
  const affected: McpServer["appsEnabled"] = {}
  for (const [agentId, selected] of [
    ...Object.entries(before ?? {}),
    ...Object.entries(after ?? {}),
  ]) {
    if (selected) affected[agentId as AgentId] = true
  }
  return affected
}

async function enqueueSyncJobs(
  apps: McpServer["appsEnabled"],
  desiredRevision: number,
  tombstones: ReadonlyArray<string> = []
): Promise<void> {
  if (!apps) return
  const db = getDb()
  const now = Date.now()
  for (const [rawAgentId, selected] of Object.entries(apps)) {
    if (!selected || !WRITABLE_AGENT_IDS.has(rawAgentId as AgentId)) continue
    const agentId = rawAgentId as AgentId
    const prior = await db.mcpSyncJobs.get(agentId)
    await db.mcpSyncJobs.put({
      id: agentId,
      desiredRevision: Math.max(desiredRevision, prior?.desiredRevision ?? 0),
      tombstones: [...new Set([...(prior?.tombstones ?? []), ...tombstones])],
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    })
  }
}

function wakeSyncCoordinator(): void {
  void import("@/lib/mcp/sync-coordinator")
    .then(({ scheduleMcpSyncDrain }) => scheduleMcpSyncDrain())
    .catch(() => {
      // The durable row is the source of truth; startup will retry the drain.
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
  const namespaces = new Set<string>()
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name))
  for (const s of sorted) {
    if (!s.enabled) continue
    const normalized = normalizeMcpNamespace(s.name)
    if (namespaces.has(normalized)) {
      throw new Error(`Duplicate MCP namespace: ${s.name}`)
    }
    namespaces.add(normalized)
    if (s.transport !== "stdio") {
      const config = s.config as Record<string, unknown>
      validateMcpRemoteEgress(String(config.url ?? ""), config.allowPrivateNetwork === true)
    }
    out[s.name] = { type: s.transport, ...s.config }
  }
  return out
}

function normalizeDisallowedTools(tools: readonly string[]): string[] {
  return [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))].sort()
}

/** Convert selected servers' bare deny rules into Claude SDK MCP tool names. */
export function buildMcpDisallowedToolNames(
  servers: ReadonlyArray<Pick<McpServer, "name" | "disallowedTools">>
): string[] {
  const denied = new Set<string>()
  for (const server of servers) {
    // Claude SDK prefixes MCP tools with the exact key used in the server map.
    // Preserve that runtime namespace; lower-casing here would make deny rules
    // miss servers whose valid configured name contains upper-case letters.
    const namespace = server.name.trim()
    for (const tool of normalizeDisallowedTools(server.disallowedTools ?? [])) {
      denied.add(`mcp__${namespace}__${tool}`)
    }
  }
  return [...denied].sort()
}

async function resolveMcpServerDefinitions(
  servers: McpServer[],
  resolveConfig: (config: McpServer["config"]) => Promise<Record<string, unknown>>
): Promise<McpServer[]> {
  return Promise.all(
    servers.map(async (server) =>
      hasMcpSecretRefs(server.config)
        ? { ...server, config: (await resolveConfig(server.config)) as never }
        : server
    )
  )
}

/** Resolve keyring-backed values before projecting an SDK-compatible map. */
export async function buildMcpServerMapResolved(
  servers: McpServer[],
  resolveConfig: (config: McpServer["config"]) => Promise<Record<string, unknown>> =
    resolveMcpSecrets
): Promise<Record<string, Record<string, unknown>>> {
  return buildMcpServerMap(await resolveMcpServerDefinitions(servers, resolveConfig))
}

/** A remote MCP server's stored OAuth state, projected for header injection. */
export interface McpAuthInjection {
  accessToken?: string
  /** Absolute expiry (epoch ms), when the provider returned one. */
  expiresAtMs?: number
}

export interface BuildMcpAuthDeps {
  /** Load by stable server ID, with the namespace available for legacy fallback. */
  loadEntry: (serverId: string, legacyName: string) => Promise<McpAuthInjection | undefined>
  /** Optionally refresh a near-expiry token; returns the refreshed entry. */
  refresh?: (serverName: string) => Promise<McpAuthInjection | undefined>
  /** Refresh when the token expires within this many ms. Default 60s. */
  refreshSkewMs?: number
  now?: () => number
  resolveConfig?: (config: McpServer["config"]) => Promise<Record<string, unknown>>
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
  const resolvedServers = await resolveMcpServerDefinitions(
    servers,
    deps.resolveConfig ?? resolveMcpSecrets
  )
  const base = buildMcpServerMap(resolvedServers)
  const now = deps.now ?? (() => Date.now())
  const skew = deps.refreshSkewMs ?? 60_000
  const byName = new Map(resolvedServers.filter((s) => s.enabled).map((s) => [s.name, s]))
  const entries = await Promise.all(
    Object.entries(base).map(async ([name, cfg]) => {
      const server = byName.get(name)
      if (!server || server.transport === "stdio") {
        return [name, cfg] as const
      }
      let entry: McpAuthInjection | undefined
      try {
        entry = await deps.loadEntry(server.id, name)
        if (entry?.expiresAtMs && deps.refresh && entry.expiresAtMs - now() < skew) {
          entry = (await deps.refresh(name)) ?? entry
        }
      } catch {
        // Auth lookup is best-effort — fall back to the un-authed config.
        entry = undefined
      }
      if (entry?.accessToken) {
        const existing = (cfg.headers as Record<string, string> | undefined) ?? {}
        return [
          name,
          { ...cfg, headers: { ...existing, Authorization: `Bearer ${entry.accessToken}` } },
        ] as const
      } else {
        return [name, cfg] as const
      }
    })
  )
  return Object.fromEntries(entries)
}

export const MCP_TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"]

export type McpImportStrategy = "skip" | "duplicate" | "overwrite"

export interface McpImportDraft {
  name: string
  transport: McpTransport
  config: McpServerConfig
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
  strategy: McpImportStrategy = "skip",
  origin: Extract<
    McpServerOrigin,
    "agent-import" | "project-import" | "plugin" | "preset"
  > = "agent-import"
): Promise<McpBulkImportResult> {
  const result: McpBulkImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errored: [],
  }
  const db = getDb()
  const existing = await listMcpServers()
  const byName = new Map(existing.map((s) => [normalizeMcpNamespace(s.name), s]))
  const creates: McpServer[] = []
  const updates: McpServer[] = []

  for (const draft of drafts) {
    try {
      const baseName = draft.name?.trim()
      if (!baseName) throw new Error("Server is missing a name.")
      let name = baseName
      let collision = byName.get(normalizeMcpNamespace(name))
      if (collision && strategy === "skip") {
        result.skipped += 1
        continue
      }
      if (collision && strategy === "duplicate") {
        let suffix = 1
        do {
          name = `${baseName}-imported${suffix === 1 ? "" : `-${suffix}`}`
          suffix += 1
          collision = byName.get(normalizeMcpNamespace(name))
        } while (collision)
      }

      const now = Date.now()
      if (collision && strategy === "overwrite") {
        let next: McpServer = {
          ...collision,
          transport: draft.transport,
          config: draft.config,
          revision: (collision.revision ?? 1) + 1,
          trust: { state: "pending" },
          enabled: false,
          updatedAt: now,
        }
        validateMcpDefinition(next)
        next = (await externalizeMcpSecrets(next)).server
        updates.push(next)
        byName.set(normalizeMcpNamespace(next.name), next)
        result.updated += 1
        continue
      }

      let next: McpServer = {
        id: newId(),
        name,
        displayName: name,
        schemaVersion: 1,
        revision: 1,
        credentialVersion: 0,
        origin,
        trust: { state: "pending" },
        transport: draft.transport,
        config: draft.config,
        enabled: false,
        appsEnabled: {},
        createdAt: now,
        updatedAt: now,
      }
      validateMcpDefinition(next)
      assertUniqueMcpNamespace(next.name, [...byName.values()])
      next = (await externalizeMcpSecrets(next)).server
      creates.push(next)
      byName.set(normalizeMcpNamespace(next.name), next)
      result.created += 1
    } catch (err) {
      result.errored.push({
        name: draft.name ?? "(unnamed)",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (creates.length || updates.length) {
    await db.transaction(
      "rw",
      db.mcpServers,
      db.mcpServerSummaries,
      db.mcpSyncJobs,
      db.mcpCapabilityCache,
      async () => {
        const current = await db.mcpServers.toArray()
        for (const server of creates) {
          assertUniqueMcpNamespace(server.name, current)
          current.push(server)
        }
        if (creates.length) await db.mcpServers.bulkAdd(creates)
        if (updates.length) await db.mcpServers.bulkPut(updates)
        await db.mcpServerSummaries.bulkPut([...creates, ...updates].map(toMcpServerSummary))
        for (const server of updates) {
          await db.mcpCapabilityCache.where("serverId").equals(server.id).delete()
          await enqueueSyncJobs(server.appsEnabled, server.revision ?? 1)
        }
      }
    )
    wakeSyncCoordinator()
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
