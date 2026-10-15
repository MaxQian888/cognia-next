/**
 * The routed conversation writes that more than one surface makes without a
 * list of its own: archive / unarchive and delete.
 *
 * Every one of them has two carriers. On a paired client the Host owns the
 * session rows, so the write becomes a HostState intent the Host applies and
 * confirms (`enqueueHostStateIntentIfAvailable`); only an id no Host takes is
 * written here. `useSessions` used to hold this logic inline, which left every
 * other caller — the chat banner, the send path, the conversation manager's
 * empty archive, the auto-archive sweep — to either duplicate it or write the
 * local rows directly and silently skip the Host. One module, so none can.
 *
 * Plain async functions, not a hook: the scheduler's auto-archive executor
 * runs outside React.
 */

import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"
import { getDb } from "@/lib/db/schema"
import { deleteSessionsWithTeardown } from "@/lib/chat/session-deletion"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import { announceFileSpaceSessionsChanged } from "@/lib/filespace/lifecycle"
import { archiveSessionScratchWorkspace } from "@/lib/task-workspace/managed-workspace"
import {
  type SessionPersistenceScope,
  archiveSession,
  bulkArchiveSessions,
  bulkUnarchiveSessions,
  unarchiveSession,
} from "@/lib/db/sessions"

function captureWriteScope(): SessionPersistenceScope {
  const db = getDb()
  const key = getRuntimeTargetScopeKey()
  return {
    db,
    assertActive() {
      if (key !== getRuntimeTargetScopeKey() || db.name !== getDb().name) {
        throw new Error("Session database scope changed")
      }
    },
  }
}

/** The ids no Host took, in the order given. */
async function idsLeftForThisDevice(
  ids: readonly string[],
  route: (sessionId: string) => Promise<unknown>
): Promise<string[]> {
  const queued = await Promise.all(ids.map((sessionId) => route(sessionId)))
  return ids.filter((_, index) => !queued[index])
}

/**
 * Archive (`archived: true`) or restore (`false`) conversations. Duplicate ids
 * are written once. A single local id goes through the single-row writer, which
 * is what the rows' own tests and the attached-child close expect; more go
 * through the one-transaction bulk writer.
 */
export async function setSessionsArchived(
  ids: readonly string[],
  archived: boolean
): Promise<void> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return
  const scope = captureWriteScope()
  const local = await idsLeftForThisDevice(uniqueIds, (sessionId) =>
    enqueueHostStateIntentIfAvailable({
      sessionId,
      action: { kind: "session.archive", archived },
    })
  )
  scope.assertActive()
  if (local.length === 0) return
  if (archived) {
    for (const sessionId of local) {
      scope.assertActive()
      await archiveSessionScratchWorkspace(sessionId, scope.assertActive)
      scope.assertActive()
    }
  }
  if (local.length === 1) {
    await (archived ? archiveSession(local[0]!, scope) : unarchiveSession(local[0]!, scope))
  } else {
    await (archived ? bulkArchiveSessions(local, scope) : bulkUnarchiveSessions(local, scope))
  }
  // Live file shares are suspended while archived and resumed on restore
  // (ADR-0222 §10); a Host that took the write announces it itself.
  scope.assertActive()
  announceFileSpaceSessionsChanged(local)
}

/**
 * Delete conversations. A paired client hands each delete to its Host, which
 * runs the cascade and the sidecar teardown there; the rest are deleted here
 * with the full teardown (`deleteSessionsWithTeardown`).
 */
export async function deleteSessionsRouted(ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return
  const scope = captureWriteScope()
  const local = await idsLeftForThisDevice(uniqueIds, (sessionId) =>
    enqueueHostStateIntentIfAvailable({ sessionId, action: { kind: "session.delete" } })
  )
  scope.assertActive()
  if (local.length > 0) {
    for (const sessionId of local) {
      scope.assertActive()
      await archiveSessionScratchWorkspace(sessionId, scope.assertActive)
      scope.assertActive()
    }
    await deleteSessionsWithTeardown(local, scope)
  }
}
