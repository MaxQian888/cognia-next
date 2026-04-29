// Sync orchestrator. Cognia's Dexie store is the source of truth. Whenever
// servers change (CRUD or appsEnabled toggle), `syncToAgent()` projects the
// active subset into that agent's config file. Imports go the other way:
// read an agent's file, merge into Dexie under CCSwitch's "existing wins"
// conflict policy.
//
// Sync calls are coalesced via a tiny per-agent debouncer so a flurry of
// CRUD ops (e.g. importing 10 servers in a loop) results in one file write
// per agent.

import type { AgentId } from "@/lib/claude/types"
import { isTauri } from "@/lib/tauri"
import {
  bulkImportMcpServers,
  listMcpServers,
  updateMcpServer,
  type McpBulkImportResult,
  type McpImportDraft,
  type McpImportStrategy,
} from "@/lib/db/mcp-servers"
import {
  readAgentConfig,
  writeAgentConfig,
  type AgentReadResult,
  type AgentWriteResult,
} from "./ipc"
import { getAgentAdapter, requireAgentAdapter } from "./agents"

// ---- Sync (Cognia → Agent) ----------------------------------------------

export interface SyncSkipped {
  ok: false
  skipped: true
  reason: "not-tauri" | "unknown-agent" | "read-only" | "no-path-on-os" | "agent-not-installed"
}

export interface SyncOk {
  ok: true
  result: AgentWriteResult
  /** How many servers ended up projected into the file. */
  count: number
}

export interface SyncErr {
  ok: false
  skipped: false
  error: string
}

export type SyncResult = SyncOk | SyncSkipped | SyncErr

/**
 * Project the current set of `appsEnabled[agent]=true` servers into the
 * agent's config file. Always re-reads the file first so any external
 * unmanaged keys survive. No-ops gracefully when:
 *   - not running in Tauri (web preview)
 *   - the agent isn't supported on this OS
 *   - the agent isn't installed (config dir missing)
 *   - the adapter is read-only (cline / roo-code)
 *
 * `tombstones` carries names of recently-deleted servers (gone from Dexie).
 * They're added to `managedNames` so this sync drops their entries from the
 * file too. The CRUD layer flushes these via `scheduleSync(id, name)`.
 */
export async function syncToAgent(
  agentId: AgentId,
  tombstones: ReadonlyArray<string> = []
): Promise<SyncResult> {
  if (!isTauri()) {
    return { ok: false, skipped: true, reason: "not-tauri" }
  }
  const adapter = getAgentAdapter(agentId)
  if (!adapter) return { ok: false, skipped: true, reason: "unknown-agent" }
  if (!adapter.writable) return { ok: false, skipped: true, reason: "read-only" }

  const all = await listMcpServers()
  const targets = all.filter((s) => s.appsEnabled?.[agentId] === true)
  const managedNames: ReadonlySet<string> = new Set([...all.map((s) => s.name), ...tombstones])

  let cfg: AgentReadResult
  try {
    cfg = await readAgentConfig(agentId)
  } catch (err) {
    return { ok: false, skipped: false, error: errMessage(err) }
  }
  if (cfg.path === null) {
    return { ok: false, skipped: true, reason: "no-path-on-os" }
  }
  // If the file's parent directory doesn't exist, `write_agent_config` will
  // refuse to create it (we don't want to manifest a fake `~/.codex/` for
  // someone who doesn't use Codex). We surface this as "agent not installed".
  if (!cfg.exists) {
    // Allow write IFF parent exists — but we can't tell from here. Try the
    // write; the Rust side returns a specific error if the parent is absent.
    // We simply treat any error as "not installed" rather than reporting a
    // hard failure that would scare the user.
  }

  const nextTree = adapter.project(cfg.parsed, targets, managedNames)

  try {
    const result = await writeAgentConfig(agentId, nextTree)
    return { ok: true, result, count: targets.length }
  } catch (err) {
    const msg = errMessage(err)
    // The Rust side surfaces "agent directory missing" in this exact phrase.
    if (msg.includes("agent directory missing")) {
      return { ok: false, skipped: true, reason: "agent-not-installed" }
    }
    return { ok: false, skipped: false, error: msg }
  }
}

/** Run `syncToAgent` for every writable agent in parallel. */
export async function syncAll(): Promise<Record<string, SyncResult>> {
  const out: Record<string, SyncResult> = {}
  const writable: AgentId[] = [
    "claude-code",
    "claude-desktop",
    "cursor",
    "vscode",
    "codex",
    "gemini",
    "windsurf",
  ]
  const results = await Promise.all(writable.map((id) => syncToAgent(id)))
  writable.forEach((id, i) => {
    out[id] = results[i]
  })
  return out
}

// ---- Debounced sync (used by CRUD hooks) ---------------------------------

interface PendingSync {
  handle: ReturnType<typeof setTimeout>
  tombstones: Set<string>
}

const pendingSyncs = new Map<AgentId, PendingSync>()
const SYNC_DEBOUNCE_MS = 250

/**
 * Schedule a sync for the given agent in the near future, coalescing
 * back-to-back calls. Use this from the CRUD layer where a loop of writes
 * shouldn't trigger a write per iteration.
 *
 * Pass `tombstone` when the trigger is a delete: that name is added to the
 * managedNames set on flush so the eventual `project()` drops the entry.
 * Tombstones accumulate across calls within the debounce window.
 */
export function scheduleSync(agentId: AgentId, tombstone?: string): void {
  const existing = pendingSyncs.get(agentId)
  if (existing) clearTimeout(existing.handle)
  const tombstones = existing?.tombstones ?? new Set<string>()
  if (tombstone) tombstones.add(tombstone)

  const handle = setTimeout(() => {
    const entry = pendingSyncs.get(agentId)
    pendingSyncs.delete(agentId)
    const list = entry ? Array.from(entry.tombstones) : []
    void syncToAgent(agentId, list).catch((err) => {
      console.error(`syncToAgent(${agentId}) failed`, err)
    })
  }, SYNC_DEBOUNCE_MS)
  pendingSyncs.set(agentId, { handle, tombstones })
}

/**
 * Schedule a sync for every agent that has at least one currently-projected
 * server (or once-projected; we always sync agents the user has touched).
 * Called from the CRUD layer after each create/update/delete.
 */
export async function scheduleSyncForAffectedAgents(): Promise<void> {
  // Cheap: just ask Dexie which agents anyone has flipped on.
  const all = await listMcpServers()
  const touched = new Set<AgentId>()
  for (const s of all) {
    const apps = s.appsEnabled ?? {}
    for (const [agentId, enabled] of Object.entries(apps)) {
      if (enabled) touched.add(agentId as AgentId)
    }
  }
  for (const id of touched) scheduleSync(id)
}

// ---- Import (Agent → Cognia) --------------------------------------------

export interface AgentImportPreview {
  agent: AgentId
  exists: boolean
  parseError?: string
  drafts: McpImportDraft[]
}

/**
 * Read an agent's config file and return the drafts it would import. UI
 * uses this to render the "preview" step of the import dialog.
 */
export async function previewAgentImport(agentId: AgentId): Promise<AgentImportPreview> {
  const adapter = requireAgentAdapter(agentId)
  if (!isTauri()) {
    return { agent: agentId, exists: false, drafts: [] }
  }
  const cfg = await readAgentConfig(agentId)
  return {
    agent: agentId,
    exists: cfg.exists,
    parseError: cfg.parseError,
    drafts: cfg.parsed != null ? adapter.parse(cfg.parsed) : [],
  }
}

/**
 * Import drafts from `agentId` into Dexie under the chosen strategy.
 *
 * CCSwitch-aligned default behavior on collisions: existing entries WIN —
 * we only flip `appsEnabled[agentId]=true` so the same server can be shared
 * across agents without losing the user's local config tweaks. Pass
 * `strategy: "overwrite"` to force a write of the imported config.
 */
export async function importFromAgent(
  agentId: AgentId,
  strategy: McpImportStrategy = "skip"
): Promise<McpBulkImportResult & { previewed: number }> {
  const preview = await previewAgentImport(agentId)
  const result = await bulkImportMcpServers(preview.drafts, strategy)

  // After import, flip `appsEnabled[agentId]=true` for every successfully
  // imported / matched name. This is the "is in this agent" pivot.
  const all = await listMcpServers()
  const importedNames = new Set(preview.drafts.map((d) => d.name))
  for (const server of all) {
    if (!importedNames.has(server.name)) continue
    const apps = { ...(server.appsEnabled ?? {}) }
    if (apps[agentId] === true) continue
    apps[agentId] = true
    await updateMcpServer(server.id, { appsEnabled: apps })
  }

  return { ...result, previewed: preview.drafts.length }
}

// ---- Misc ----------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
