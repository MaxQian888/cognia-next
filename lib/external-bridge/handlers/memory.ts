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
import { listMemoriesExternal, type MemoryReadDenyReason } from "@/lib/memory/api/read-memory"
import { mcpCaller } from "@/lib/memory/api/caller"
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
  | {
      ok: false
      reason:
        | "disabled"
        | "temporary"
        | "policy_denied"
        | "backend_unavailable"
        | "unauthorized_namespace"
    }

export async function memorySearch(input: MemorySearchInput): Promise<MemorySearchResult> {
  const query = requireText(input.query, "query", MAX_MEMORY_TEXT_CHARS)
  const result = await searchMemoriesExternal(
    {
      query,
      topK: input.k,
      types: input.types,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      path: input.path,
    },
    mcpCaller()
  )
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
  { ok: true; memories: MemoryWireRow[] } | { ok: false; reason: MemoryReadDenyReason }

export async function memoryList(input: MemoryListInput): Promise<MemoryListResult> {
  const result = await listMemoriesExternal(input, mcpCaller())
  if (!result.ok) return result
  return { ok: true, memories: result.memories.map(toWireRow) }
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
  /** Idempotency key: a retried identical request replays its first result. */
  operationId?: string
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
      operationId: input.operationId,
    },
    { channel: "mcp" },
    mcpCaller()
  )
}

export interface MemoryUpdateInput {
  id: string
  text?: string
  importance?: number
  tags?: string[]
  key?: string
  pinned?: boolean
  /** Compare-and-swap guard: refuse to patch a row that moved past this version. */
  expectedVersion?: number
  /** Idempotency key: a retried identical patch replays its first result. */
  operationId?: string
}

export async function memoryUpdate(input: MemoryUpdateInput): Promise<MutateExternalMemoryResult> {
  const id = requireText(input.id, "id", 200)
  if (input.text !== undefined) requireText(input.text, "text", MAX_MEMORY_TEXT_CHARS)
  return updateExternalMemory(
    id,
    {
      text: input.text,
      importance: input.importance,
      tags: input.tags,
      key: input.key,
      pinned: input.pinned,
    },
    {
      caller: mcpCaller(),
      expectedVersion: input.expectedVersion,
      operationId: input.operationId,
    }
  )
}

export interface MemoryForgetInput {
  id: string
  expectedVersion?: number
  operationId?: string
}

export async function memoryForget(input: MemoryForgetInput): Promise<MutateExternalMemoryResult> {
  const id = requireText(input.id, "id", 200)
  return forgetExternalMemory(id, {
    caller: mcpCaller(),
    expectedVersion: input.expectedVersion,
    operationId: input.operationId,
  })
}
