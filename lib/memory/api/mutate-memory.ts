/**
 * Shared mutation path for external memory surfaces (plugin `ctx.memory`
 * update/forget, MCP `memory_update`/`memory_forget`, companion RPC).
 *
 * - `updateExternalMemory`: patch text / importance / tags / key on an existing
 *   row. Text patches are PII-gated (block-only) and bump `version`; the vector
 *   doc is re-upserted best-effort so semantic search stays in sync.
 * - `forgetExternalMemory`: soft-invalidate (the consolidation-path contract —
 *   hard deletes stay user-panel-only). No PII risk, so it only requires
 *   `memory.enabled` (allowed even in temporary mode: forgetting reduces data).
 *
 * Both go through `runMemoryMutation`: one Dexie transaction that replays an
 * `operationId` receipt, compares `expectedVersion`, re-verifies the row's
 * namespace against the read the caller based its request on, and commits the
 * patch + audit + receipt atomically. Long-running work (PII scan, policy
 * resolution, vector upsert) stays outside that transaction by construction.
 */

import type { TrustedMemoryCaller } from "@cognia/memory/types/caller"
import { memoryRowWithinNamespaces } from "@cognia/memory/types/caller"
import { clampImportance } from "./store-memory"

export interface UpdateExternalMemoryPatch {
  text?: string
  importance?: number
  tags?: string[]
  key?: string
  pinned?: boolean
}

export type MutateExternalMemoryResult =
  | { ok: true; version: number }
  | {
      ok: false
      reason:
        | "disabled"
        | "temporary"
        | "pii_blocked"
        | "not_found"
        | "policy_denied"
        | "scope_denied"
        | "unauthorized_namespace"
        | "version_conflict"
        | "idempotency_key_reused"
      /** Present on `version_conflict` — the row's version at commit time. */
      currentVersion?: number
    }

export interface ExternalMutationContext {
  /**
   * Host-bound caller identity (`lib/memory/api/caller.ts`). Its
   * `policyCharacterId` / `sessionId` resolve the governing policy; its
   * `namespaces` set bounds which rows it may touch; its `principalId`
   * namespaces the idempotency ledger. Absent = an in-process caller acting
   * as the account owner (`local-user`), the pre-caller-contract behavior.
   */
  caller?: TrustedMemoryCaller
  /** Compare-and-swap guard: the row's `version` must still equal this. */
  expectedVersion?: number
  /**
   * Idempotency key, unique per caller principal. A replay with the same
   * request returns the recorded outcome; a replay with a DIFFERENT request
   * is refused (`idempotency_key_reused`).
   */
  operationId?: string
}

export async function updateExternalMemory(
  id: string,
  patch: UpdateExternalMemoryPatch,
  context: ExternalMutationContext = {}
): Promise<MutateExternalMemoryResult> {
  const text = patch.text?.trim()
  if (text === "") throw new Error("memory update: 'text' must be non-empty when provided")
  if (
    text === undefined &&
    patch.importance === undefined &&
    !patch.tags &&
    patch.key === undefined &&
    patch.pinned === undefined
  ) {
    throw new Error("memory update requires at least one field to change")
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }

  if (text !== undefined) {
    const { hasNoLeakingPii } = await import("@cognia/redact")
    if (!hasNoLeakingPii(text)) return { ok: false, reason: "pii_blocked" }
  }

  const memDb = await import("@/lib/db/memories")
  const existing = await memDb.getMemory(id)
  if (!existing) return { ok: false, reason: "not_found" }

  const caller = context.caller
  if (caller?.namespaces && !memoryRowWithinNamespaces(existing, caller.namespaces)) {
    return { ok: false, reason: "unauthorized_namespace" }
  }

  const { resolvePersistedAgentMemoryPolicy, scopeAllowedByAgentMemoryPolicy } =
    await import("@/lib/memory/agent-policy")
  const policy = await resolvePersistedAgentMemoryPolicy({
    config,
    characterId: caller?.policyCharacterId ?? existing.agentId ?? existing.characterId,
    sessionId: caller?.sessionId,
  })
  if (!policy.canUpdate) return { ok: false, reason: "policy_denied" }
  if (!scopeAllowedByAgentMemoryPolicy(policy, "update", existing.scope)) {
    return { ok: false, reason: "scope_denied" }
  }

  const principalId = caller?.principalId ?? "local-user"
  const { runMemoryMutation, memoryOperationRequestHash } =
    await import("@/lib/db/memory-operations")
  const outcome = await runMemoryMutation({
    memoryId: id,
    seen: existing,
    expectedVersion: context.expectedVersion,
    ...(context.operationId
      ? {
          operation: {
            principalId,
            operationId: context.operationId,
            // Hash the EFFECTIVE request, not the raw payload — `" x"`/`"x"`
            // and `importance: 42`/`99` apply identically, so they are the
            // same operation, not an `idempotency_key_reused` false positive.
            requestHash: await memoryOperationRequestHash("update", {
              id,
              patch: {
                ...patch,
                text,
                ...(patch.importance !== undefined
                  ? { importance: clampImportance(patch.importance) }
                  : {}),
                ...(patch.tags ? { tags: patch.tags.map((t) => t.trim()).filter(Boolean) } : {}),
              },
            }),
            kind: "update" as const,
          },
        }
      : {}),
    apply: (row) => {
      const contentChanged =
        text !== undefined ||
        patch.importance !== undefined ||
        patch.tags !== undefined ||
        patch.key !== undefined
      const audits: { action: "revised" | "pinned" | "unpinned"; reason: string }[] = []
      if (contentChanged) audits.push({ action: "revised", reason: "external_update" })
      if (patch.pinned !== undefined && patch.pinned !== row.pinned) {
        audits.push({ action: patch.pinned ? "pinned" : "unpinned", reason: "external_update" })
      }
      return {
        patch: {
          ...(text !== undefined ? { text } : {}),
          ...(patch.importance !== undefined
            ? { importance: clampImportance(patch.importance) }
            : {}),
          ...(patch.tags ? { tags: patch.tags.map((t) => t.trim()).filter(Boolean) } : {}),
          ...(patch.key !== undefined ? { key: patch.key } : {}),
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        },
        audits,
      }
    },
  })
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      ...(outcome.currentVersion !== undefined ? { currentVersion: outcome.currentVersion } : {}),
    }
  }

  // Keep the vector doc in sync with a text change — best-effort, the Dexie
  // update is authoritative and BM25 recall works without the vector.
  if (text !== undefined && existing.vectorDocId) {
    try {
      const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.upsert(existing.vectorDocId, text)
    } catch {
      // ignore — keep the Dexie update
      const { noteMemoryVectorFailure } = await import("@/lib/memory/lifecycle/enqueue-reconcile")
      noteMemoryVectorFailure()
    }
  }
  return { ok: true, version: outcome.version }
}

export async function forgetExternalMemory(
  id: string,
  context: ExternalMutationContext = {}
): Promise<MutateExternalMemoryResult> {
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }

  const memDb = await import("@/lib/db/memories")
  const existing = await memDb.getMemory(id)
  if (!existing) return { ok: false, reason: "not_found" }

  const caller = context.caller
  if (caller?.namespaces && !memoryRowWithinNamespaces(existing, caller.namespaces)) {
    return { ok: false, reason: "unauthorized_namespace" }
  }

  const { resolvePersistedAgentMemoryPolicy, scopeAllowedByAgentMemoryPolicy } =
    await import("@/lib/memory/agent-policy")
  const policy = await resolvePersistedAgentMemoryPolicy({
    config,
    characterId: caller?.policyCharacterId ?? existing.agentId ?? existing.characterId,
    sessionId: caller?.sessionId,
  })
  if (!policy.canForget) return { ok: false, reason: "policy_denied" }
  if (!scopeAllowedByAgentMemoryPolicy(policy, "forget", existing.scope)) {
    return { ok: false, reason: "scope_denied" }
  }

  const principalId = caller?.principalId ?? "local-user"
  const { runMemoryMutation, memoryOperationRequestHash } =
    await import("@/lib/db/memory-operations")
  const outcome = await runMemoryMutation({
    memoryId: id,
    seen: existing,
    expectedVersion: context.expectedVersion,
    ...(context.operationId
      ? {
          operation: {
            principalId,
            operationId: context.operationId,
            requestHash: await memoryOperationRequestHash("forget", { id }),
            kind: "forget" as const,
          },
        }
      : {}),
    apply: (row) => {
      if (row.status === "invalidated") {
        // Already forgotten — the mutation is a no-op but still applied, so
        // the receipt records the settled state.
        return { patch: {}, audits: [] }
      }
      return {
        patch: { status: "invalidated" as const, invalidatedAt: Date.now() },
        audits: [{ action: "invalidated" as const, reason: "external_forget" }],
      }
    },
  })
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      ...(outcome.currentVersion !== undefined ? { currentVersion: outcome.currentVersion } : {}),
    }
  }

  if (existing.vectorDocId) {
    try {
      const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.delete([existing.vectorDocId])
    } catch {
      // Canonical invalidation is authoritative; vector cleanup is best-effort.
      const { noteMemoryVectorFailure } = await import("@/lib/memory/lifecycle/enqueue-reconcile")
      noteMemoryVectorFailure()
    }
  }
  return { ok: true, version: outcome.version }
}
