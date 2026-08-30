/**
 * One-time repair for `workspace`-scoped memories written without a
 * `projectId`.
 *
 * The explicit-capture path used to resolve a scope but not the id that scope
 * requires, so `/remember` and the composer's `#` picker both reported success
 * for rows `isVisibleToReader` (`lib/db/memories.ts`) can never return. The
 * write path is fixed, but the rows already on disk stay invisible until
 * something moves them.
 *
 * Idempotent by construction rather than by a marker: the query selects exactly
 * the broken shape, and a repaired row no longer matches it. That is why this
 * can run unconditionally on every worker start with no bookkeeping, on every
 * host that already runs the memory job worker.
 */

import { listWorkspaceMemoriesMissingProject, relocateMemoryNamespace } from "@/lib/db/memories"
import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"
import { getSession } from "@/lib/db/sessions"

/** Bounded per run so a pathological database cannot stall worker start. */
const DEFAULT_LIMIT = 200

export interface RepairWorkspaceScopeReport {
  /** Rows whose owning workspace was recovered from the source session. */
  repaired: number
  /** Rows with no recoverable workspace, moved to `global` so they are readable. */
  downgraded: number
}

/**
 * Recover the workspace for each unreadable row, or move it to `global`.
 *
 * The downgrade is deliberate. A user's saved fact being readable in the wrong
 * (wider) scope is recoverable by editing it. A fact that is silently
 * unreadable forever is not.
 */
export async function repairWorkspaceScopedMemories(
  limit: number = DEFAULT_LIMIT
): Promise<RepairWorkspaceScopeReport> {
  const report: RepairWorkspaceScopeReport = { repaired: 0, downgraded: 0 }
  const broken = await listWorkspaceMemoriesMissingProject(limit).catch(() => [])
  for (const memory of broken) {
    const projectId = memory.sourceSessionId
      ? (await getSession(memory.sourceSessionId).catch(() => undefined))?.projectId
      : undefined
    try {
      if (projectId) {
        await relocateMemoryNamespace(memory.id, {
          projectId,
          scopeRationale: "repaired_from_source_session",
        })
        report.repaired += 1
      } else {
        await relocateMemoryNamespace(memory.id, {
          scope: "global",
          scopeRationale: "repaired_scope_downgrade",
        })
        report.downgraded += 1
      }
      await appendMemoryAuditEvent({
        action: "revised",
        memoryId: memory.id,
        ...(memory.sourceSessionId ? { sessionId: memory.sourceSessionId } : {}),
        reason: "workspace_scope_repair",
        metadata: { recovered: Boolean(projectId) },
      }).catch(() => undefined)
    } catch {
      // A row that fails to move is retried on the next worker start, because
      // it still matches the broken shape.
    }
  }
  return report
}
