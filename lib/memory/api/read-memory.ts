/**
 * Authorized read boundary for external memory surfaces.
 *
 * Every external read — list, get, count, and (via `search-memory.ts`) recall —
 * funnels through `authorizeMemoryRead`, so the surfaces can never drift on
 * what a caller may see. Two facts are enforced here that the raw Dexie
 * helpers cannot express:
 *
 *   - the POLICY SUBJECT comes from the caller's host binding
 *     (`caller.policyCharacterId` / `caller.sessionId`), not from request
 *     fields — a request can no longer pick which `memoryPolicy` governs it;
 *   - request-supplied `projectId` / `characterId` / `agentId` are NARROWING
 *     filters intersected with `caller.namespaces`, never a grant.
 *
 * List/get/count are the INSPECT-class read: they share the recall gate
 * (`canRecall` + `readableScopes`) because there is no separate inspect grant
 * for external callers — an Agent that may not recall a scope may not
 * enumerate it either.
 */

import type { Memory, MemoryScope, MemoryStatus, MemoryType } from "@/types/memory/memory"
import type { MemoryReaderContext } from "@cognia/memory/types/memory"
import {
  memoryRowWithinNamespaces,
  narrowNamespaceValue,
  type TrustedMemoryCaller,
} from "@cognia/memory/types/caller"
import type { ResolvedAgentMemoryPolicy } from "@/lib/memory/agent-policy"

export interface AuthorizedMemoryRead {
  policy: ResolvedAgentMemoryPolicy
  /**
   * Row-level authorization: the row's scope is readable by this caller AND
   * every namespace field it carries sits inside the caller's authorized set.
   */
  isAuthorized: (memory: Memory) => boolean
}

export type MemoryReadDenyReason = "disabled" | "temporary" | "policy_denied"

export type AuthorizeMemoryReadResult =
  | { ok: true; config: import("@/types/memory/memory").MemoryConfig; read: AuthorizedMemoryRead }
  | { ok: false; reason: MemoryReadDenyReason }

export async function authorizeMemoryRead(
  caller: TrustedMemoryCaller
): Promise<AuthorizeMemoryReadResult> {
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }

  const { resolvePersistedAgentMemoryPolicy } = await import("@/lib/memory/agent-policy")
  const policy = await resolvePersistedAgentMemoryPolicy({
    config,
    characterId: caller.policyCharacterId,
    sessionId: caller.sessionId,
  })
  if (!policy.canRecall) return { ok: false, reason: "policy_denied" }

  const readableScopes = new Set(policy.readableScopes)
  return {
    ok: true,
    config,
    read: {
      policy,
      isAuthorized: (memory) =>
        readableScopes.has(memory.scope) && memoryRowWithinNamespaces(memory, caller.namespaces),
    },
  }
}

/**
 * Intersect request-supplied reader filters with the caller's authorized
 * namespaces. Returns `null` when the request names a namespace the caller is
 * not bound to — the caller-facing failure is an empty result set (fail
 * closed), never an error that confirms the namespace exists.
 */
export function narrowReaderToCaller(
  input: MemoryReaderContext,
  caller: TrustedMemoryCaller
): MemoryReaderContext | null {
  const namespaces = caller.namespaces
  if (!namespaces) return { ...input }
  const characterId = narrowNamespaceValue(input.characterId, namespaces.characterIds)
  const projectId = narrowNamespaceValue(input.projectId, namespaces.projects)
  const agentId = narrowNamespaceValue(input.agentId, namespaces.agentIds)
  if (characterId === null || projectId === null || agentId === null) return null
  return { ...input, characterId, projectId, agentId }
}

export interface ListMemoriesExternalInput {
  type?: MemoryType
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  status?: MemoryStatus
  limit?: number
}

export type ListMemoriesExternalResult =
  { ok: true; memories: Memory[] } | { ok: false; reason: MemoryReadDenyReason }

/**
 * Policy- and namespace-authorized listing — the external counterpart of the
 * raw `listMemories` the local panel uses.
 */
export async function listMemoriesExternal(
  input: ListMemoriesExternalInput,
  caller: TrustedMemoryCaller
): Promise<ListMemoriesExternalResult> {
  const authorized = await authorizeMemoryRead(caller)
  if (!authorized.ok) return authorized
  const reader = narrowReaderToCaller(input, caller)
  if (!reader) return { ok: true, memories: [] }

  const { listMemories } = await import("@/lib/db/memories")
  const rows = await listMemories({
    type: input.type,
    scope: input.scope,
    characterId: reader.characterId,
    projectId: reader.projectId,
    agentId: reader.agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
    status: input.status ?? "active",
  })
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))
  return {
    ok: true,
    memories: rows.filter((row) => authorized.read.isAuthorized(row)).slice(0, limit),
  }
}

/** Fetch one row by id under the caller's authorization; invisible → undefined. */
export async function getMemoryExternal(
  id: string,
  caller: TrustedMemoryCaller
): Promise<Memory | undefined> {
  const authorized = await authorizeMemoryRead(caller)
  if (!authorized.ok) return undefined
  const { getMemory } = await import("@/lib/db/memories")
  const row = await getMemory(id)
  return row && authorized.read.isAuthorized(row) ? row : undefined
}

/** Active-row count for a scope; a scope outside the caller's reads as 0. */
export async function countMemoriesExternal(
  scope: MemoryScope,
  caller: TrustedMemoryCaller,
  characterId?: string
): Promise<number> {
  const authorized = await authorizeMemoryRead(caller)
  if (!authorized.ok) return 0
  if (!authorized.read.policy.readableScopes.includes(scope)) return 0
  if (
    characterId !== undefined &&
    caller.namespaces?.characterIds !== undefined &&
    !caller.namespaces.characterIds.includes(characterId)
  ) {
    return 0
  }
  const { listMemories } = await import("@/lib/db/memories")
  const rows = await listMemories({ scope, characterId, status: "active" })
  return rows.filter((row) => authorized.read.isAuthorized(row)).length
}
