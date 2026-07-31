/**
 * MCP tool handlers — long-term memory (ADR-0069).
 *
 *   • `memory_search` / `memory_list` — read what the assistant remembers
 *     about the user (scope `memory:read`, default OFF — distilled personal
 *     facts, same sensitivity tier as `rag:twin`).
 *   • `memory_store` / `memory_update` / `memory_forget` — write tools
 *     (scope `memory:write`, default OFF). Writes go through the shared
 *     external-write helpers: provenance `external` + `sourceChannel: "mcp"`,
 *     block-only PII gate, never `procedural`, and `forget` soft-invalidates
 *     (hard deletes stay user-panel-only).
 *
 * Pure handlers — validation + delegation to `lib/memory/api/*`. The MCP
 * server layer (`lib/external-bridge/mcp-server`) owns the permission gate +
 * audit log. Policy blocks (memory disabled, temporary mode, PII) return
 * structured `{ ok: false, reason }` results instead of throwing, so an
 * external agent can react without string-matching error text.
 */

import type { MemoryScope, MemoryType } from "@/types/memory/memory"
import { searchMemoriesExternal } from "@/lib/memory/api/search-memory"
import { storeExternalMemory, type StoreMemoryCoreResult } from "@/lib/memory/api/store-memory"
import {
  updateExternalMemory,
  forgetExternalMemory,
  type MutateExternalMemoryResult,
} from "@/lib/memory/api/mutate-memory"
import { toMemoryWireRow as toWireRow, type MemoryWireRow } from "@/lib/memory/api/wire"

export type { MemoryWireRow }

/** Max characters accepted for a stored memory text. */
export const MAX_MEMORY_TEXT_CHARS = 2000

function requireText(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim()
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`)
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters`)
  return trimmed
}

async function readsAllowed(): Promise<{ allowed: boolean; reason?: "disabled" | "temporary" }> {
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { allowed: false, reason: "disabled" }
  if (config.temporary) return { allowed: false, reason: "temporary" }
  return { allowed: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export interface MemorySearchInput {
  query: string
  k?: number
  types?: MemoryType[]
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
}

export type MemorySearchResult =
  | { ok: true; hits: Array<{ memory: MemoryWireRow; relevance: number; score: number }> }
  | { ok: false; reason: "disabled" | "temporary" | "backend_unavailable" }

export async function memorySearch(input: MemorySearchInput): Promise<MemorySearchResult> {
  const query = requireText(input.query, "query", MAX_MEMORY_TEXT_CHARS)
  const result = await searchMemoriesExternal({
    query,
    topK: input.k,
    types: input.types,
    characterId: input.characterId,
    projectId: input.projectId,
    agentId: input.agentId,
    branch: input.branch,
    path: input.path,
  })
  if (!result.ok) return result
  return {
    ok: true,
    hits: result.hits.map((h) => ({
      memory: toWireRow(h.memory),
      relevance: h.relevance,
      score: h.score,
    })),
  }
}

export interface MemoryListInput {
  type?: MemoryType
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  limit?: number
}

export type MemoryListResult =
  { ok: true; memories: MemoryWireRow[] } | { ok: false; reason: "disabled" | "temporary" }

export async function memoryList(input: MemoryListInput): Promise<MemoryListResult> {
  const gate = await readsAllowed()
  if (!gate.allowed) return { ok: false, reason: gate.reason! }
  const { listMemories } = await import("@/lib/db/memories")
  const rows = await listMemories({
    type: input.type,
    scope: input.scope,
    characterId: input.characterId,
    projectId: input.projectId,
    agentId: input.agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
    status: "active",
  })
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))
  return { ok: true, memories: rows.slice(0, limit).map(toWireRow) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryStoreInput {
  text: string
  type?: "semantic" | "episodic"
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  key?: string
  importance?: number
  tags?: string[]
}

export async function memoryStore(input: MemoryStoreInput): Promise<StoreMemoryCoreResult> {
  const text = requireText(input.text, "text", MAX_MEMORY_TEXT_CHARS)
  return storeExternalMemory(
    {
      text,
      type: input.type,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      key: input.key,
      importance: input.importance,
      tags: input.tags,
    },
    { channel: "mcp" }
  )
}

export interface MemoryUpdateInput {
  id: string
  text?: string
  importance?: number
  tags?: string[]
  key?: string
  pinned?: boolean
}

export async function memoryUpdate(input: MemoryUpdateInput): Promise<MutateExternalMemoryResult> {
  const id = requireText(input.id, "id", 200)
  if (input.text !== undefined) requireText(input.text, "text", MAX_MEMORY_TEXT_CHARS)
  return updateExternalMemory(id, {
    text: input.text,
    importance: input.importance,
    tags: input.tags,
    key: input.key,
    pinned: input.pinned,
  })
}

export async function memoryForget(input: { id: string }): Promise<MutateExternalMemoryResult> {
  const id = requireText(input.id, "id", 200)
  return forgetExternalMemory(id)
}
