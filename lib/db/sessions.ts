import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { getDb } from "./schema"
import { getDefaultPreset, recordPresetUsage } from "./prompt-presets"
import { buildAutoApplySessionPatch } from "@/lib/presets/apply-to-session"
import { invalidatePersistSnapshot } from "./messages"
import { recordTombstones } from "@/lib/sync/tombstones"
import { deleteLoopsForSession } from "./loops"
import { deleteGoalsForSession } from "./goals"
import { resolveScopeProjectId } from "./project-scope"

function newId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * **Unscoped** — every session across all workspaces. This is the explicit
 * cross-workspace escape hatch: keep using it for data backup/export, desktop
 * "export all chats", and subscription usage aggregation (billing is
 * profile-level, not per-workspace). Working-set surfaces (the chat sidebar,
 * `/sessions`) must use {@link listScopedSessions} instead so a workspace can't
 * see another's chats.
 */
export async function listSessions(): Promise<ChatSession[]> {
  return getDb().sessions.orderBy("updatedAt").reverse().toArray()
}

/**
 * Sessions for one workspace, newest-first. Defaults to the active project via
 * the central scope helper. The chat sidebar and other working-set surfaces
 * read through here so workspaces stay isolated. Uses the `[projectId+updatedAt]`
 * compound index (Dexie v86).
 */
export async function listScopedSessions(projectId?: string): Promise<ChatSession[]> {
  // liveQuery zone-safety: when the caller already knows the workspace (the
  // chat sidebar always passes it), the Dexie read below must start *before*
  // any `await` — awaiting a native promise (resolveScopeProjectId is a plain
  // async fn) drops Dexie's liveQuery dependency-tracking zone, so writes such
  // as `setSessionOrder` would never re-emit and the sidebar would keep the
  // stale order (the drag-reorder "snap back" bug).
  const pid = projectId || (await resolveScopeProjectId())
  return getDb()
    .sessions.where("[projectId+updatedAt]")
    .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
    .reverse()
    .toArray()
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  return getDb().sessions.get(id)
}

/**
 * Create a fresh chat session row. When the caller provides no character or
 * team and no override fields, the user's default preset (if any) is auto-
 * applied — its `content` becomes the session's `systemPrompt`, and any of
 * `model` / `permissionMode` / `workingDir` the preset carries are copied
 * across. The preset's `usageCount` / `lastUsedAt` are updated as well.
 *
 * Auto-apply only touches fields that are still empty on `partial`; any
 * caller-provided value wins. Failures looking up the default preset are
 * swallowed — auto-apply is a convenience, not a load-bearing invariant.
 *
 * Auto-apply intentionally only fills the four ChatSession-row fields above.
 * Tool / MCP / skill / agent-mode preset overrides require explicit user
 * action via the chat-header config sheet; rolling them into session
 * creation would couple this helper to the agent-mode store and several
 * stores at once with no UI surface to undo it.
 */
export async function createSession(
  partial?: Partial<Omit<ChatSession, "id" | "createdAt" | "updatedAt">>
): Promise<ChatSession> {
  const now = Date.now()

  let autoApplied: {
    systemPrompt?: string
    model?: string
    permissionMode?: ChatSession["permissionMode"]
    workingDir?: string
  } = {}
  let autoAppliedPresetId: string | undefined

  const shouldAutoApply =
    !partial?.characterId &&
    !partial?.teamId &&
    !partial?.systemPrompt &&
    !partial?.model &&
    !partial?.permissionMode &&
    !partial?.workingDir

  if (shouldAutoApply) {
    try {
      const def = await getDefaultPreset()
      if (def) {
        autoApplied = buildAutoApplySessionPatch(def, partial ?? {})
        autoAppliedPresetId = def.id
      }
    } catch (err) {
      // Non-fatal — log via console.warn so test runs surface unexpected errors
      // but production flows continue without a default applied.
      console.warn("createSession: default preset auto-apply failed", err)
    }
  }

  // Stamp the owning workspace (Workspace isolation, Dexie v86). An explicit
  // `partial.projectId` wins (e.g. a connector inbound that resolved the
  // conversation's workspace); otherwise the active project — never null.
  const projectId = await resolveScopeProjectId(partial?.projectId)

  const session: ChatSession = {
    id: newId(),
    projectId,
    title: partial?.title ?? "New chat",
    kind: partial?.kind ?? "direct",
    characterId: partial?.characterId,
    teamId: partial?.teamId,
    disabledSkillIds: partial?.disabledSkillIds,
    pinned: partial?.pinned,
    model: partial?.model ?? autoApplied.model,
    systemPrompt: partial?.systemPrompt ?? autoApplied.systemPrompt,
    workingDir: partial?.workingDir ?? autoApplied.workingDir,
    permissionMode: partial?.permissionMode ?? autoApplied.permissionMode,
    activePresetId: partial?.activePresetId ?? autoAppliedPresetId,
    bareMode: partial?.bareMode,
    debugMode: partial?.debugMode,
    briefMode: partial?.briefMode,
    forkedFromSdkSessionId: partial?.forkedFromSdkSessionId,
    scratchpad: partial?.scratchpad,
    integrationBinding: partial?.integrationBinding,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.put(session)
  if (autoAppliedPresetId) {
    // Wait for the usage bump so the "Recent" filter in the section reflects
    // this session immediately. The cost is one extra Dexie update per
    // creation; it's bounded and not on the chat hot path.
    await recordPresetUsage(autoAppliedPresetId).catch(() => undefined)
  }
  return session
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<ChatSession, "id" | "createdAt">>
): Promise<void> {
  await getDb().sessions.update(id, { ...patch, updatedAt: Date.now() })
}

/**
 * Drop the SDK-side session id from the row. Used by the workflow-editor
 * chat-tab's "Clear conversation" action so the next send starts a fresh
 * SDK query (no resume, no carried-over context). Implemented via
 * Dexie's `modify` so we can `delete` the field outright; passing
 * `undefined` through `update()` would leave the value intact.
 */
export async function clearSessionSdkLink(id: string): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((s) => {
      delete s.sdkSessionId
      delete s.forkedFromSdkSessionId
      s.updatedAt = Date.now()
    })
}

/**
 * Drop a freshly-branched session's one-shot context seed. Called by
 * `resolveSendOptions` once the seed has been injected as `appendSystemPrompt`
 * on the first send, so it is never re-injected on later turns. Uses Dexie's
 * `modify` so the field is `delete`d outright (passing `undefined` through
 * `update()` would leave it intact). See `lib/chat/branch-session.ts`.
 */
export async function clearBranchSeed(id: string): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((s) => {
      delete s.branchSeed
      s.updatedAt = Date.now()
    })
}

/**
 * Mark an imported (`import:*`) session as owned by Cognia (ADR-0062 fidelity
 * upgrade). Called once, on the user's first continuation of an imported
 * session, so the fs-watch re-import guard (`applyImportedMerged`) stops
 * mirroring source-side edits and can never clobber the continued thread.
 * Idempotent — re-freezing a frozen row is a no-op write.
 */
export async function freezeImportedSession(id: string): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((s) => {
      s.importFrozen = true
    })
}

/**
 * Archive a session (conversation-list overhaul). Sets `archivedAt` so the
 * conversation-list model drops it from the active list; it remains visible in
 * the Archived view. `updatedAt` is intentionally left untouched so the row
 * keeps its real recency for the archived-view sort and on restore.
 */
export async function archiveSession(id: string): Promise<void> {
  await getDb().sessions.update(id, { archivedAt: Date.now() })
}

/**
 * Un-archive a session — clears `archivedAt` so it returns to the active list
 * in its original date bucket (and to Pinned if still pinned). Uses `modify`
 * to `delete` the field outright (passing `undefined` through `update()` would
 * leave it intact — see {@link clearSessionSdkLink}).
 */
export async function unarchiveSession(id: string): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((s) => {
      delete s.archivedAt
    })
}

/** Archive many sessions in a single transaction. Missing ids are skipped. */
export async function bulkArchiveSessions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const now = Date.now()
  const db = getDb()
  await db.transaction("rw", db.sessions, async () => {
    for (const id of ids) await db.sessions.update(id, { archivedAt: now })
  })
}

/**
 * Un-archive many sessions atomically — the symmetric counterpart to
 * {@link bulkArchiveSessions}. Like {@link unarchiveSession} it uses `modify`
 * to `delete` the non-indexed `archivedAt` field (an `update()` with
 * `undefined` would leave it intact). A single `anyOf` `modify` runs in one
 * implicit transaction, so a mid-batch failure can't leave the selection
 * half-restored. Missing ids are skipped.
 */
export async function bulkUnarchiveSessions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await getDb()
    .sessions.where("id")
    .anyOf(ids as string[])
    .modify((s) => {
      delete s.archivedAt
    })
}

/**
 * Move a session into a folder, or back to loose (`folderId = null`). Folder
 * membership is organizational, so `updatedAt` is intentionally left untouched
 * — the session keeps its real recency for the date-bucket fallback on removal.
 * `folderId` is non-indexed; clearing it requires `modify` + `delete` (passing
 * `undefined` through `update()` would leave it intact — see
 * {@link clearSessionSdkLink}).
 */
export async function assignSessionToFolder(
  sessionId: string,
  folderId: string | null
): Promise<void> {
  const db = getDb()
  if (folderId === null) {
    await db.sessions
      .where("id")
      .equals(sessionId)
      .modify((s) => {
        delete s.folderId
      })
  } else {
    await db.sessions.update(sessionId, { folderId })
  }
}

/**
 * Persist manual ordering of one ChannelList section (drag-reorder). `ids` are
 * the section's rows in their new order — the Pinned block, a date bucket, a
 * folder, or the flat "recent" list. Writes each id's array index into its
 * non-indexed `manualOrder`, tagged with `sectionKey`
 * (`conversationSectionKey` of the section the drag happened in) so the order
 * only applies inside that section — otherwise a rank set in one date bucket
 * would follow the session into every bucket it later migrates to. Ordering is
 * organizational, so `updatedAt` is left untouched (like folder assignment).
 * Runs in one `rw` transaction so a mid-batch failure rolls back atomically;
 * missing ids are skipped (Dexie `update` is a no-op on a stale id).
 */
export async function setSessionOrder(ids: readonly string[], sectionKey: string): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.sessions, async () => {
    for (let i = 0; i < ids.length; i++) {
      await db.sessions.update(ids[i], { manualOrder: i, manualOrderSection: sectionKey })
    }
  })
}

/**
 * Fork an existing chat session: creates a new ChatSession that inherits the
 * parent's character / team / per-session overrides, with `forkedFromSdkSessionId`
 * set to the parent's `sdkSessionId`. The next send on the new session will
 * tell the SDK to branch from that id (see `lib/claude/build-options.ts` and
 * `sidecar/dispatch/anthropic.mjs`).
 *
 * Throws when the parent has no `sdkSessionId` yet (the SDK has nothing to
 * fork from until at least one turn has completed).
 */
export async function forkSessionFromParent(parentId: string): Promise<ChatSession> {
  const parent = await getDb().sessions.get(parentId)
  if (!parent) throw new Error(`Session ${parentId} not found`)
  if (!parent.sdkSessionId) {
    throw new Error("Cannot fork: the session hasn't started a SDK conversation yet")
  }
  return createSession({
    title: `${parent.title} (fork)`,
    kind: parent.kind,
    characterId: parent.characterId,
    teamId: parent.teamId,
    disabledSkillIds: parent.disabledSkillIds,
    model: parent.model,
    providerOverride: parent.providerOverride,
    systemPrompt: parent.systemPrompt,
    workingDir: parent.workingDir,
    permissionMode: parent.permissionMode,
    bareMode: parent.bareMode,
    debugMode: parent.debugMode,
    briefMode: parent.briefMode,
    forkedFromSdkSessionId: parent.sdkSessionId,
  })
}

/**
 * Branches derived from `parentId`, newest first.
 *
 * The reverse of `ChatSession.parentSessionId`, which the v81 index exists for
 * and which nothing queried until now: lineage was visible only from a child
 * looking up. A parent had no idea it had been branched, so a conversation you
 * had explored three ways looked identical to one you had never touched.
 */
export async function listSessionBranches(parentId: string): Promise<ChatSession[]> {
  const rows = await getDb().sessions.where("parentSessionId").equals(parentId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/** How many branches were taken at `messageId` within `parentId`. */
export async function countBranchesAtMessage(parentId: string, messageId: string): Promise<number> {
  const rows = await listSessionBranches(parentId)
  return rows.filter((s) => s.branchedFromMessageId === messageId).length
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    db.sessions,
    db.messages,
    db.sessionUsage,
    db.syncTombstones,
    async () => {
      // Capture message ids before the cascade so we can tombstone each one —
      // the companion sync mirrors these deletions to paired phones (v61).
      const msgIds = (await db.messages.where("sessionId").equals(id).primaryKeys()) as string[]

      // Re-point this session's branches at their grandparent before the row
      // goes. A branch is a standalone conversation — `direct` mode copies the
      // messages outright, so it does not depend on its parent for anything —
      // and deleting the parent must not take it down or strand it. Left alone,
      // each child kept a `parentSessionId` pointing at a row that no longer
      // exists, so its lineage chip degraded to "a deleted conversation" and
      // the trail up the chain was cut. Uses the v81 `parentSessionId` index.
      const doomed = await db.sessions.get(id)
      const children = (await db.sessions
        .where("parentSessionId")
        .equals(id)
        .primaryKeys()) as string[]
      for (const childId of children) {
        // `undefined` deletes the field, which is what a branch of a top-level
        // conversation should end up with — not a pointer to nothing.
        await db.sessions.update(childId, { parentSessionId: doomed?.parentSessionId })
      }

      await db.messages.where("sessionId").equals(id).delete()
      await db.sessionUsage.where("sessionId").equals(id).delete()
      await db.sessions.delete(id)
      const at = Date.now()
      await recordTombstones("sessions", [id], at)
      await recordTombstones("messages", msgIds, at)
    }
  )
  invalidatePersistSnapshot(id)
  await cleanupSessionScopedLoops(id)
  await deleteGoalsForSession(id).catch(() => {})
  await purgeSessionStoreBuckets(id)
}

/**
 * Best-effort purge of localStorage-backed per-session store state.
 *
 * The cascade above drops the session's Dexie rows, but artifacts live in a
 * persisted Zustand store rather than in Dexie — so deleting a conversation
 * left its artifacts, versions and open tabs resident until the 200-artifact
 * LRU cap happened to evict them. `clearSessionData` was written and tested for
 * exactly this and had no caller on any path.
 *
 * Mirrors `purgeStoreBuckets` in `lib/db/project-scope.ts`, which wires the
 * sibling `purgeProject` the same way: a dynamic import so `lib/db` keeps no
 * static dependency on the store layer, an optional call, and never throws — a
 * store that is absent (SSR / tests) must not block session deletion.
 *
 * Placed here rather than at the call sites because deletion arrives by three
 * routes — the chat UI (`hooks/chat/use-sessions.ts`), the plugin API
 * (`lib/plugin/api/session-api.ts` via `stores/chat/session-store.ts`), and
 * direct callers — and all three converge on this module.
 */
async function purgeSessionStoreBuckets(sessionId: string): Promise<void> {
  let useArtifactStore:
    typeof import("@/stores/artifact/artifact-store").useArtifactStore | undefined
  try {
    const artifactStoreModule = await import("@/stores/artifact/artifact-store")
    useArtifactStore = artifactStoreModule.useArtifactStore
  } catch {
    // Store module absent in SSR/minimal test runtimes — non-fatal.
    return
  }
  try {
    useArtifactStore.getState().clearSessionData?.(sessionId)
  } catch (error) {
    loggers.store.warn("session artifact cleanup failed", {
      sessionId,
      error: String(error),
    })
  }
}

/**
 * /loop cascade (v79): drop the session's loop rows and tear down the
 * scheduler tasks behind any interval loops. Runs OUTSIDE the Dexie
 * transaction (the scheduler call is async IPC) and best-effort — a
 * scheduler hiccup must not block the session delete. The scheduler import
 * is dynamic to dodge a module cycle (scheduler executors import this
 * module).
 */
async function cleanupSessionScopedLoops(sessionId: string): Promise<void> {
  try {
    const loops = await deleteLoopsForSession(sessionId)
    const taskIds = loops.flatMap((l) => (l.scheduledTaskId ? [l.scheduledTaskId] : []))
    if (taskIds.length === 0) return
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    for (const taskId of taskIds) {
      await getTaskScheduler()
        .deleteTask(taskId)
        .catch(() => {})
    }
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Bulk variant of `deleteSession` for the channel-list batch toolbar.
 * Runs every per-id removal inside a single Dexie `rw` transaction so a
 * mid-loop failure rolls back atomically. Missing ids are silently skipped
 * (matches the per-id contract — `dexie.delete()` is a no-op on a stale id).
 */
export async function bulkDeleteSessions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  await db.transaction(
    "rw",
    db.sessions,
    db.messages,
    db.sessionUsage,
    db.syncTombstones,
    async () => {
      const at = Date.now()
      for (const id of ids) {
        const msgIds = (await db.messages.where("sessionId").equals(id).primaryKeys()) as string[]
        await db.messages.where("sessionId").equals(id).delete()
        await db.sessionUsage.where("sessionId").equals(id).delete()
        await db.sessions.delete(id)
        await recordTombstones("sessions", [id], at)
        await recordTombstones("messages", msgIds, at)
      }
    }
  )
  for (const id of ids) {
    invalidatePersistSnapshot(id)
    await cleanupSessionScopedLoops(id)
    await deleteGoalsForSession(id).catch(() => {})
    await purgeSessionStoreBuckets(id)
  }
}

export async function touchSession(id: string): Promise<void> {
  await getDb().sessions.update(id, { updatedAt: Date.now() })
}

/**
 * Persist the SDK-issued session id (so we can resume after a sidecar restart).
 * No-op when the row is missing or already carries the same id; we don't bump
 * `updatedAt` because this isn't user-visible state.
 */
export async function setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
  const row = await getDb().sessions.get(id)
  if (!row || row.sdkSessionId === sdkSessionId) return
  await getDb().sessions.update(id, { sdkSessionId })
}
