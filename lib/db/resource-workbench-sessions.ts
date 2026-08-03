// Lifecycle for workbench asides (sidechats).
//
// An aside is an ordinary `resource-workbench` session row bound to a resource —
// most often the conversation it hangs beside, so the user can check something
// adjacent without spending turns in, or adding noise to, the main thread.
//
// Until now exactly one existed per resource, forever: the id was a pure
// function of the binding, and nothing could create, rename, clear or delete
// one. `ensureResourceWorkbenchSession` still owns the primary aside (the one
// auto-created on first open); everything here is the rest of the lifecycle.
//
// All reads go through the `surfaceBindingKey` index (Dexie v131). Before that
// column existed the only way to find an aside by binding was a full scan of
// every session in the profile.

import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb, withDbReopenRetry } from "./schema"
import { deleteSession, updateSession } from "./sessions"
import { invalidatePersistSnapshot } from "./messages"
import { resolveScopeProjectId } from "./project-scope"
import {
  newResourceWorkbenchSessionId,
  promoteEmbeddedSessionPatch,
  surfaceBindingKey,
  type ResourceSessionRepository,
} from "@/lib/context-workbench/resource-session"

/** Shared Dexie repository for ensuring and migrating resource sidechats. */
export function createResourceSessionRepository(): ResourceSessionRepository {
  const db = getDb()
  return {
    get: (id) => db.sessions.get(id),
    findByBinding: (target) =>
      db.sessions.where("surfaceBindingKey").equals(surfaceBindingKey(target)).first(),
    put: (row) => db.sessions.put(row).then(() => undefined),
    update: (id, patch) => db.sessions.update(id, patch),
    resolveProjectId: async (target) =>
      target.kind === "session"
        ? ((await db.sessions.get(target.sessionId))?.projectId ?? (await resolveScopeProjectId()))
        : resolveScopeProjectId(),
  }
}

/**
 * Every aside bound to `binding`, oldest first.
 *
 * Order is by creation, not recency: these render as a stable list the user
 * picks from, and re-sorting on every send would move the entry under the
 * cursor. The primary aside — created by `ensureResourceWorkbenchSession` —
 * always sorts first because it necessarily existed before any extra one.
 */
export async function listResourceWorkbenchSessions(
  binding: SessionSurfaceBinding
): Promise<ChatSession[]> {
  const rows = await getDb()
    .sessions.where("surfaceBindingKey")
    .equals(surfaceBindingKey(binding))
    .toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Create an additional aside on the same resource.
 *
 * Inherits the workspace from the conversation it is an aside to (falling back
 * to the active scope for non-session bindings). A row written without a
 * `projectId` is absent from `[projectId+updatedAt]` entirely — invisible to
 * scoped reads AND outside `deleteProjectCascade`, so it would outlive the
 * workspace it belongs to along with its messages.
 */
export async function createResourceWorkbenchSession(
  binding: SessionSurfaceBinding,
  title: string
): Promise<ChatSession> {
  const db = getDb()
  const projectId =
    binding.kind === "session"
      ? ((await db.sessions.get(binding.sessionId))?.projectId ?? (await resolveScopeProjectId()))
      : await resolveScopeProjectId()

  // Strictly after every existing aside, not merely `Date.now()`. Two asides
  // created inside the same millisecond — one double-click on "+" — would
  // otherwise share a `createdAt`, and the list they sort into would reorder
  // arbitrarily between reads. The ordering is user-visible and has to be a
  // real total order, not one that happens to hold when the clock cooperates.
  const siblings = await listResourceWorkbenchSessions(binding)
  const newest = siblings.reduce((max, s) => Math.max(max, s.createdAt), 0)
  const now = Math.max(Date.now(), newest + 1)

  const session: ChatSession = {
    id: newResourceWorkbenchSessionId(binding),
    projectId,
    title,
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    surfaceBindingKey: surfaceBindingKey(binding),
    createdAt: now,
    updatedAt: now,
  }
  await db.sessions.put(session)
  // Fresh row — make sure no stale persist snapshot lingers under a recycled id.
  invalidatePersistSnapshot(session.id)
  return session
}

/** Rename an aside. Trimmed; an empty name is rejected rather than persisted. */
export async function renameResourceWorkbenchSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error("An aside needs a name")
  await updateSession(id, { title: trimmed })
}

/**
 * Drop an aside's messages, keeping the aside itself.
 *
 * Also clears the SDK linkage: the provider-side conversation still holds the
 * turns we just deleted, so resuming it would reintroduce the context the user
 * asked to be rid of. Mirrors what "Clear conversation" does for a main thread.
 */
export async function clearResourceWorkbenchSession(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.messages, db.sessions, async () => {
    await db.messages.where("sessionId").equals(id).delete()
    await db.sessions.update(id, {
      sdkSessionId: undefined,
      forkedFromSdkSessionId: undefined,
      lastMessagePreview: undefined,
      lastMessageAt: undefined,
      updatedAt: Date.now(),
    })
  })
  invalidatePersistSnapshot(id)
}

/**
 * Delete an aside and its messages.
 *
 * Routed through `deleteSession` rather than a local delete so the aside gets
 * the same cascade as any other conversation — usage rows and sync tombstones
 * included. An aside that skipped tombstoning would resurrect on the next pull.
 */
export async function deleteResourceWorkbenchSession(id: string): Promise<void> {
  await deleteSession(id)
}

/**
 * Turn an aside into an ordinary conversation, in place.
 *
 * The messages, the id and the workspace all stay put; only the markers that
 * kept it out of the conversation rail are cleared. Keeping the id means
 * permalinks into the aside survive being promoted.
 */
export async function promoteResourceWorkbenchSession(id: string): Promise<ChatSession> {
  const db = getDb()
  const existing = await db.sessions.get(id)
  if (!existing) throw new Error(`Cannot promote: session ${id} not found`)
  if (existing.kind !== "resource-workbench") {
    throw new Error(`Cannot promote: session ${id} is not an aside`)
  }

  const patch = promoteEmbeddedSessionPatch()
  // A promoted aside must land in a workspace or it is unreachable from the
  // sidebar — the exact failure the v131 backfill exists to repair.
  const projectId = existing.projectId ?? (await resolveScopeProjectId())
  try {
    await withDbReopenRetry(() =>
      getDb()
        .sessions.where("id")
        .equals(id)
        .modify((session) => {
          session.kind = "direct"
          session.projectId = projectId
          session.updatedAt = Date.now()
          delete session.visibility
          delete session.surfaceBinding
          delete session.surfaceBindingKey
        })
        .then(() => undefined)
    )
  } catch (error) {
    const durable = await getDb().sessions.get(id)
    const promotedDurably =
      durable?.kind === "direct" &&
      durable.projectId === projectId &&
      durable.visibility === undefined &&
      durable.surfaceBinding === undefined &&
      durable.surfaceBindingKey === undefined
    if (!promotedDurably) throw error
  }
  return { ...existing, ...patch, projectId }
}
