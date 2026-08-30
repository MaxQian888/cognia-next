import Dexie from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { getDb, withDbReopenRetry } from "./schema"
import { getDefaultPreset, recordPresetUsage } from "./prompt-presets"
import { buildAutoApplySessionPatch } from "@/lib/presets/apply-to-session"
import { invalidatePersistSnapshot } from "./messages"
import { recordTombstones } from "@/lib/sync/tombstones"
import { resolveScopeProjectId } from "./project-scope"
import { getSettings } from "./settings"
import { thinkingLevelPatch } from "@/lib/ai/thinking-level"
import { markSessionRemoved } from "@/lib/chat/search/indexer"
import { revokeClaimsForDeletedSession } from "@/lib/memory/lifecycle/claim-deletion-closure"
import { publishTranscriptRevision } from "@/lib/chat/transcript/revision-events"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import { assertSessionWritable, type SessionWriteOperation } from "@/lib/chat/session-write-guard"

function newId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

async function assertSessionsWritable(
  db: ReturnType<typeof getDb>,
  ids: readonly string[],
  operation: SessionWriteOperation
): Promise<void> {
  for (const session of await db.sessions.bulkGet([...new Set(ids)])) {
    assertSessionWritable(session, operation)
  }
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
 * **Unscoped** — every hidden subagent session plus the parent each one hangs
 * off, across all workspaces. This is the read behind the global agent thread
 * browser (ADR-0108, `lib/agent/thread-browser.ts:buildAgentThreadForest`),
 * which by design spans projects: opening a child navigates to its project.
 *
 * Reads only the `kind` index plus a `bulkGet` of the parents rather than the
 * whole table, because the browser is a status-bar segment mounted on every
 * desktop route and its live query re-runs on each session write. Both reads
 * are Dexie promises, so the `await` between them keeps the liveQuery zone.
 */
export async function listAgentThreadSessions(): Promise<ChatSession[]> {
  const db = getDb()
  const children = await db.sessions.where("kind").equals("subagent").toArray()
  if (children.length === 0) return []
  const parentIds = Array.from(
    new Set(
      children
        .map((child) => child.parentSessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  )
  const parents = parentIds.length > 0 ? await db.sessions.bulkGet(parentIds) : []
  return [
    ...children,
    ...parents.filter((row): row is ChatSession => row !== undefined && row.kind !== "subagent"),
  ]
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

/**
 * How many chat sessions exist on this device, across every workspace.
 *
 * Exists for the onboarding gate (ADR-0122), which asks only "has this person
 * ever had a conversation here?" — a long-time user whose settings row predates
 * the structured onboarding record is identified by having chats, not by any
 * stored flag. Counting in Dexie rather than materializing {@link listSessions}
 * keeps that question off the boot path's allocation budget.
 *
 * Deliberately unscoped: a session in *any* workspace proves the user is not
 * on their first run.
 */
export async function countSessions(): Promise<number> {
  return getDb().sessions.count()
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
 *
 * Every other field of `partial` is written through verbatim. This used to be
 * a hand-maintained whitelist that dropped anything absent from it — see the
 * note on the row literal below for what that cost.
 */
export async function createSession(
  partial?: Partial<Omit<ChatSession, "id" | "createdAt" | "updatedAt" | "workingSet">>
): Promise<ChatSession> {
  if (partial && Object.prototype.hasOwnProperty.call(partial, "workingSet")) {
    throw new Error("Working set changes must use mutateSessionWorkingSet")
  }
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

  // The app-wide default thinking tier (`AppSettings.defaultThinkingLevel`),
  // stamped onto the row rather than consulted at send time.
  //
  // Stamping is what makes the composer's control able to SHOW the default: a
  // send-time fallback never reaches the session row, so the chip would read
  // "Auto" while turns quietly ran at another depth. Owning the value also
  // makes editing it an ordinary per-session write instead of a fight with a
  // fallback, and keeps `ultracode`'s workflow-tool coupling — which keys on
  // `session.thinkingLevel` — working from the first turn.
  //
  // An explicit `partial` always wins (branch/fork/import carry their source's
  // tier), and the read is best-effort: a settings failure must not stop a
  // conversation from being created.
  let defaultTier: ReturnType<typeof thinkingLevelPatch> | undefined
  if (partial?.thinkingLevel === undefined && partial?.effort === undefined) {
    try {
      const level = (await getSettings())?.defaultThinkingLevel
      if (level) defaultTier = thinkingLevelPatch(level)
    } catch (err) {
      console.warn("createSession: default thinking level lookup failed", err)
    }
  }

  const session: ChatSession = {
    // Everything the caller seeded. The signature promises
    // `Partial<Omit<ChatSession, …>>`, but it used to be honoured by a
    // hand-maintained whitelist that silently dropped every column nobody had
    // remembered to add to it — `squadId`, `providerOverride`, `accountId`,
    // `toolFilter`, `outputStyle`, `executionPolicy`, `sandboxTier` and the
    // rest. That is what made `forkSessionFromParent` reset a conversation
    // bound to a non-default provider back to the app default: it passes
    // `providerOverride`, and the row simply never received it.
    //
    // Spreading is what stops the signature from lying again — a column added
    // to `ChatSession` is seedable the day it exists, with no second list to
    // keep in step. `buildChildRow` in `lib/chat/branch-session.ts` remains the
    // reference for which columns constitute a session's configuration.
    ...(partial ?? {}),
    // Owned by this function, so they always win over the spread above.
    id: newId(),
    projectId,
    title: partial?.title ?? "New chat",
    kind: partial?.kind ?? "direct",
    model: partial?.model ?? autoApplied.model,
    systemPrompt: partial?.systemPrompt ?? autoApplied.systemPrompt,
    workingDir: partial?.workingDir ?? autoApplied.workingDir,
    permissionMode: partial?.permissionMode ?? autoApplied.permissionMode,
    activePresetId: partial?.activePresetId ?? autoAppliedPresetId,
    // Both halves always move together — see `thinkingLevelPatch`, the only
    // supported writer of the pair.
    effort: partial?.effort ?? defaultTier?.effort,
    thinkingLevel: partial?.thinkingLevel ?? defaultTier?.thinkingLevel,
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
  patch: Partial<Omit<ChatSession, "id" | "createdAt" | "workingSet">>
): Promise<void> {
  if (Object.prototype.hasOwnProperty.call(patch, "workingSet")) {
    throw new Error("Working set changes must use mutateSessionWorkingSet")
  }
  await withDbReopenRetry(async () => {
    const db = getDb()
    await db.transaction("rw", db.sessions, async () => {
      assertSessionWritable(await db.sessions.get(id), "metadata")
      await db.sessions.update(id, { ...patch, updatedAt: Date.now() })
    })
  })
}

/**
 * Set the pinned state for a session batch in one transaction.
 *
 * `updatedAt` remains the sync cursor, so the metadata change must advance it.
 * Before doing that, preserve the row's current display-recency timestamp in
 * `lastMessageAt` when no message boundary has populated it yet. Conversation
 * lists use that activity timestamp, preventing pin/unpin from making an old
 * conversation look newly active while still allowing companion sync to see
 * the write. A single collection `modify` makes the batch all-or-nothing.
 */
export async function bulkSetSessionsPinned(
  ids: readonly string[],
  pinned: boolean
): Promise<void> {
  if (ids.length === 0) return
  const uniqueIds = [...new Set(ids)]
  const now = Date.now()
  await withDbReopenRetry(async () => {
    const db = getDb()
    await db.transaction("rw", db.sessions, async () => {
      await assertSessionsWritable(db, uniqueIds, "metadata")
      await db.sessions
        .where("id")
        .anyOf(uniqueIds)
        .modify((session) => {
          session.lastMessageAt ??= session.updatedAt
          session.pinned = pinned
          session.updatedAt = now
        })
    })
  })
}

/** Persist the selected sibling for one branch group and invalidate summaries. */
export async function setSessionActiveBranchSelection(
  sessionId: string,
  branchGroupId: string,
  messageId: string
): Promise<void> {
  if (!sessionId || !branchGroupId || !messageId) return
  const db = getDb()
  let revision: number | null = null
  await withDbReopenRetry(() =>
    db.transaction("rw", db.sessions, async () => {
      const session = await db.sessions.get(sessionId)
      if (!session) return
      assertSessionWritable(session, "metadata")
      if (session.activeBranchByGroup?.[branchGroupId] === messageId) return
      const nextRevision = (session.transcriptRevision ?? 0) + 1
      await db.sessions.update(sessionId, {
        activeBranchByGroup: {
          ...(session.activeBranchByGroup ?? {}),
          [branchGroupId]: messageId,
        },
        transcriptRevision: nextRevision,
        updatedAt: Date.now(),
      })
      revision = nextRevision
    })
  )
  if (revision !== null) await publishTranscriptRevision(sessionId, revision)
}

/**
 * Drop the SDK-side session id from the row. Used by the workflow-editor
 * chat-tab's "Clear conversation" action so the next send starts a fresh
 * SDK query (no resume, no carried-over context). Implemented via
 * Dexie's `modify` so we can `delete` the field outright; passing
 * `undefined` through `update()` would leave the value intact.
 */
export async function clearSessionSdkLink(id: string): Promise<void> {
  assertSessionWritable(await getDb().sessions.get(id), "continue-run")
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
  assertSessionWritable(await getDb().sessions.get(id), "continue-run")
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
      s.importOwnership = "cognia-owned"
    })
}

/**
 * Transfer continuation of an imported mirror to its original runtime after a
 * successful, capability-gated resume handshake.
 */
export async function bindImportedSessionToNativeRuntime(
  id: string,
  binding: NonNullable<ChatSession["importRuntimeBinding"]>
): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((session) => {
      session.importRuntimeBinding = binding
      session.importOwnership = "native-bound"
      session.importFrozen = false
      if (binding.nativeSessionId) session.sdkSessionId = binding.nativeSessionId
      if (binding.cwd) session.workingDir = binding.cwd
      session.updatedAt = Date.now()
    })
}

/**
 * Clear the "the source moved after we froze this" flag (ADR-0062), once the
 * user has seen the badge in the chat header. Idempotent.
 *
 * `importSourceDigest` is deliberately NOT cleared: it records what the source
 * looked like when we last observed it, so a LATER change re-raises the flag
 * while this same, already-acknowledged one does not.
 */
export async function acknowledgeImportDivergence(id: string): Promise<void> {
  await getDb()
    .sessions.where("id")
    .equals(id)
    .modify((s) => {
      delete s.importDiverged
      delete s.importDivergedAt
    })
}

async function listOwnedAttachedDescendantIds(
  db: ReturnType<typeof getDb>,
  rootIds: readonly string[]
): Promise<string[]> {
  const uniqueRootIds = [...new Set(rootIds)]
  const existingRoots = (await db.sessions.bulkGet(uniqueRootIds)).flatMap((row) =>
    row ? [row.id] : []
  )
  const seen = new Set(existingRoots)
  const descendants: string[] = []
  let frontier = existingRoots

  while (frontier.length > 0) {
    const children = await db.sessions.where("parentSessionId").anyOf(frontier).toArray()
    const next: string[] = []
    for (const child of children) {
      if (
        seen.has(child.id) ||
        !child.parentSessionId ||
        child.attachedChild?.parentSessionId !== child.parentSessionId ||
        child.attachedChild?.lifecycleOwnerSessionId !== child.parentSessionId
      ) {
        continue
      }
      seen.add(child.id)
      descendants.push(child.id)
      next.push(child.id)
    }
    frontier = next
  }

  return descendants
}

async function closeOwnedAttachedDescendants(
  db: ReturnType<typeof getDb>,
  rootIds: readonly string[],
  now: number
): Promise<void> {
  const descendantIds = await listOwnedAttachedDescendantIds(db, rootIds)
  if (descendantIds.length === 0) return
  await db.sessions
    .where("id")
    .anyOf(descendantIds)
    .modify((child) => {
      if (!child.attachedChild) return
      child.attachedChild = {
        ...child.attachedChild,
        status: "closed",
        updatedAt: now,
      }
      child.updatedAt = now
    })
}

/**
 * Archive a session (conversation-list overhaul). Sets `archivedAt` so the
 * conversation-list model drops it from the active list; it remains visible in
 * the Archived view. `updatedAt` is intentionally left untouched so the row
 * keeps its real recency for the archived-view sort and on restore.
 */
export async function archiveSession(id: string): Promise<void> {
  const db = getDb()
  const now = Date.now()
  await db.transaction("rw", db.sessions, async () => {
    await assertSessionsWritable(db, [id], "metadata")
    await db.sessions.update(id, { archivedAt: now })
    await closeOwnedAttachedDescendants(db, [id], now)
  })
}

/**
 * Un-archive a session — clears `archivedAt` so it returns to the active list
 * in its original date bucket (and to Pinned if still pinned). Uses `modify`
 * to `delete` the field outright (passing `undefined` through `update()` would
 * leave it intact — see {@link clearSessionSdkLink}).
 */
export async function unarchiveSession(id: string): Promise<void> {
  assertSessionWritable(await getDb().sessions.get(id), "metadata")
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
    await assertSessionsWritable(db, ids, "metadata")
    for (const id of ids) await db.sessions.update(id, { archivedAt: now })
    await closeOwnedAttachedDescendants(db, ids, now)
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
  await assertSessionsWritable(getDb(), ids, "metadata")
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
  assertSessionWritable(await db.sessions.get(sessionId), "metadata")
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
    await assertSessionsWritable(db, ids, "metadata")
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
 * The inherited field list mirrors `buildChildRow` in
 * `lib/chat/branch-session.ts`, which is the reference for what constitutes a
 * session's configuration — a fork that runs on a different provider, account,
 * executor or tool filter than its parent is not a fork of that conversation.
 *
 * Throws when the parent has no `sdkSessionId` yet (the SDK has nothing to
 * fork from until at least one turn has completed).
 */
export async function forkSessionFromParent(parentId: string): Promise<ChatSession> {
  const parent = await getDb().sessions.get(parentId)
  if (!parent) throw new Error(`Session ${parentId} not found`)
  assertSessionWritable(parent, "branch")
  if (!parent.sdkSessionId) {
    throw new Error("Cannot fork: the session hasn't started a SDK conversation yet")
  }
  return createSession({
    title: `${parent.title} (fork)`,
    // Load-bearing, and it was missing: `listScopedSessions` reads through the
    // `[projectId+updatedAt]` index, so a fork stamped with the UI-active
    // workspace instead of the parent's is filed under the wrong conversation
    // list. Same rule as `buildChildRow` — lineage follows the parent, not the
    // pointer.
    projectId: parent.projectId,
    kind: parent.kind,
    characterId: parent.characterId,
    teamId: parent.teamId,
    // A fork continues the same conversation, so it continues to run on the
    // same executor — the identity trio moves together (see `buildChildRow`).
    squadId: parent.squadId,
    disabledSkillIds: parent.disabledSkillIds,
    model: parent.model,
    providerOverride: parent.providerOverride,
    accountId: parent.accountId,
    systemPrompt: parent.systemPrompt,
    activePresetId: parent.activePresetId,
    workingDir: parent.workingDir,
    permissionMode: parent.permissionMode,
    messageDisplayOverride: parent.messageDisplayOverride,
    bareMode: parent.bareMode,
    debugMode: parent.debugMode,
    briefMode: parent.briefMode,
    outputStyle: parent.outputStyle,
    customOutputStyle: parent.customOutputStyle,
    sandboxEnabled: parent.sandboxEnabled,
    computerUseTarget: parent.computerUseTarget,
    maxThinkingTokens: parent.maxThinkingTokens,
    toolFilter: parent.toolFilter,
    // `createSession` only stamps the app-wide default tier when BOTH halves
    // are absent, and its own note says branch/fork/import carry their
    // source's tier. Fork never did — this comment sat here for two rounds
    // above the line it was written for, which is why the column kept leaking.
    sandboxTier: parent.sandboxTier,
    sandboxTierFollowsDefault: parent.sandboxTierFollowsDefault,
    effort: parent.effort,
    thinkingLevel: parent.thinkingLevel,
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
  await bulkDeleteSessions([id])
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
 * Tear down scheduler tasks after their loop rows were removed atomically
 * with the session subtree. Scheduler IPC cannot participate in the Dexie
 * transaction, so this final external cleanup is best-effort. The dynamic
 * import avoids a module cycle (scheduler executors import this module).
 */
async function cleanupScheduledLoopTasks(taskIds: readonly string[]): Promise<void> {
  if (taskIds.length === 0) return
  try {
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

async function releaseSandboxSessionWithRetry(sessionId: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sandboxSessionRuntime.releaseSession(sessionId)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Bulk variant of `deleteSession` for the channel-list batch toolbar.
 * Expands parent-owned attached descendants, then removes their session,
 * message, peer-message, goal and loop rows in one Dexie `rw` transaction so
 * a mid-cascade failure rolls back atomically. Missing ids are silently
 * skipped. Scheduler tasks and persisted UI stores are external systems and
 * are cleaned up best-effort after the database commit.
 */
export async function bulkDeleteSessions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const requestedIds = [...new Set(ids)]
  let deletedIds: string[] = []
  let scheduledTaskIds: string[] = []
  await db.transaction(
    "rw",
    [
      db.sessions,
      db.messages,
      db.sessionUsage,
      db.sessionPeerMessages,
      db.chatGoals,
      db.chatGoalEvents,
      db.loops,
      db.loopEvents,
      db.syncTombstones,
    ],
    async () => {
      const at = Date.now()
      deletedIds = (await db.sessions.bulkGet(requestedIds)).flatMap((row) => (row ? [row.id] : []))
      if (deletedIds.length === 0) return
      await assertSessionsWritable(db, deletedIds, "delete")
      const attachedDescendants = await listOwnedAttachedDescendantIds(db, deletedIds)
      deletedIds = [...new Set([...deletedIds, ...attachedDescendants])]
      const doomedIds = new Set(deletedIds)
      const doomedRows = await db.sessions.where("id").anyOf(deletedIds).toArray()
      const doomedById = new Map(doomedRows.map((row) => [row.id, row]))

      const goalIds = (await db.chatGoals
        .where("sessionId")
        .anyOf(deletedIds)
        .primaryKeys()) as string[]
      if (goalIds.length > 0) {
        await db.chatGoalEvents.where("goalId").anyOf(goalIds).delete()
        await db.chatGoals.bulkDelete(goalIds)
      }

      const loopRows = await db.loops.where("sessionId").anyOf(deletedIds).toArray()
      const loopIds = loopRows.map((row) => row.id)
      scheduledTaskIds = loopRows.flatMap((row) =>
        row.scheduledTaskId ? [row.scheduledTaskId] : []
      )
      if (loopIds.length > 0) {
        await db.loopEvents.where("loopId").anyOf(loopIds).delete()
        await db.loops.bulkDelete(loopIds)
      }

      const survivingParentOf = (sessionId: string): string | undefined => {
        let parentId = doomedById.get(sessionId)?.parentSessionId
        const visited = new Set<string>()
        while (parentId && doomedIds.has(parentId) && !visited.has(parentId)) {
          visited.add(parentId)
          parentId = doomedById.get(parentId)?.parentSessionId
        }
        return parentId
      }

      // Preserve ordinary branches while attached children remain owned by
      // the deletion set. A surviving branch is connected to the nearest
      // surviving ancestor, matching the single-delete contract.
      for (const id of deletedIds) {
        const childIds = (await db.sessions
          .where("parentSessionId")
          .equals(id)
          .primaryKeys()) as string[]
        const fallbackParentId = survivingParentOf(id)
        for (const childId of childIds) {
          if (!doomedIds.has(childId)) {
            await db.sessions.update(childId, { parentSessionId: fallbackParentId })
          }
        }
      }

      const allMessageIds: string[] = []
      for (const id of deletedIds) {
        const msgIds = (await db.messages.where("sessionId").equals(id).primaryKeys()) as string[]
        allMessageIds.push(...msgIds)
        await db.messages.where("sessionId").equals(id).delete()
        await db.sessionUsage.where("sessionId").equals(id).delete()
        await db.sessions.delete(id)
      }
      await db.sessionPeerMessages
        .filter((row) => doomedIds.has(row.senderSessionId) || doomedIds.has(row.receiverSessionId))
        .delete()
      await recordTombstones("sessions", deletedIds, at)
      await recordTombstones("messages", allMessageIds, at)
    }
  )
  await cleanupScheduledLoopTasks(scheduledTaskIds)
  const sandboxReleaseErrors: unknown[] = []
  for (const id of deletedIds) {
    try {
      await releaseSandboxSessionWithRetry(id)
    } catch (error) {
      sandboxReleaseErrors.push(error)
    }
    invalidatePersistSnapshot(id)
    markSessionRemoved(id)
    // Post-commit, alongside the other derived-view cleanups. Every citation
    // captured in this conversation now points at nothing, so the claims that
    // rested on it must stop being injected; the arithmetic that follows runs
    // on the job worker.
    await revokeClaimsForDeletedSession(id)
    await purgeSessionStoreBuckets(id)
  }
  if (sandboxReleaseErrors.length > 0) {
    // The transaction already committed — the sessions ARE deleted. Rejecting
    // here would report a completed deletion as failed and let an optimistic
    // caller roll rows back into a list they no longer exist in. A provider
    // resource that outlived its session is a cleanup problem, not a delete
    // failure, and the runtime retries the release on the next bind.
    loggers.store.warn("sandbox runtime release failed after session delete", {
      sessionIds: deletedIds,
      errors: sandboxReleaseErrors.map((error) => String(error)),
    })
  }
}

export async function touchSession(id: string): Promise<void> {
  assertSessionWritable(await getDb().sessions.get(id), "continue-run")
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
  assertSessionWritable(row, "continue-run")
  await getDb().sessions.update(id, { sdkSessionId })
}
