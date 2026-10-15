/**
 * Side chats left behind by conversations deleted before the delete cascade
 * learned about them.
 *
 * A side chat is bound to its conversation only through `surfaceBindingKey`
 * (`session:<id>`), so `bulkDeleteSessions` used to drop the conversation and
 * leave every side chat — with its messages — in the database, reachable from
 * no surface. The cascade now covers them; this sweep collects the ones that
 * predate it, and any a crash between two writes might still leave.
 */
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"

import { getDb } from "./schema"
import { bulkDeleteSessions } from "./sessions"

/** Every `surfaceBindingKey` of a session-bound side chat starts with this. */
const SESSION_BINDING_KEY_PREFIX = "session:"

function boundSessionId(row: ChatSession): string | undefined {
  const binding: SessionSurfaceBinding | undefined = row.surfaceBinding
  return binding?.kind === "session" ? binding.sessionId : undefined
}

/**
 * Delete side chats whose conversation no longer exists. Returns how many were
 * removed. Reads only the `surfaceBindingKey` index range of session bindings,
 * so the cost scales with the number of side chats, not with every session.
 */
export async function purgeOrphanedSessionSideChats(): Promise<number> {
  const db = getDb()
  const sideChats = (await db.sessions
    .where("surfaceBindingKey")
    .startsWith(SESSION_BINDING_KEY_PREFIX)
    .toArray()) as ChatSession[]
  if (sideChats.length === 0) return 0

  const parentIds = [...new Set(sideChats.flatMap((row) => boundSessionId(row) ?? []))]
  const parents = await db.sessions.bulkGet(parentIds)
  const living = new Set(parents.flatMap((row) => (row ? [row.id] : [])))

  const orphanIds = sideChats.flatMap((row) => {
    const parentId = boundSessionId(row)
    return parentId !== undefined && !living.has(parentId) ? [row.id] : []
  })
  if (orphanIds.length === 0) return 0
  await bulkDeleteSessions(orphanIds)
  return orphanIds.length
}
