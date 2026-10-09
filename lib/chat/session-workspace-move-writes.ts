/**
 * The routed write for moving a conversation to another Workspace.
 *
 * Like archive and delete (`session-archive-writes.ts`), a move has two
 * carriers. On a paired client the Host owns the session rows, so the move
 * becomes a `session.workspace` HostState intent the Host re-plans against its
 * own rows and applies (`lib/sync/host-state-session-move.ts`); only a session
 * no Host takes is moved here. Writing it locally on a paired client would
 * rebuild the execution context against directories on the wrong machine and
 * leave the Host's row, the one every replica syncs from, where it was.
 *
 * The move is planned on this device first either way. The planner's refusals
 * (same or unknown workspace, archived, handed-off, running) need no round
 * trip to answer, and the Host re-checks every one of them against its own
 * rows, so a stale view here can only refuse early, never let a bad move
 * through.
 *
 * Plain async functions, not a hook: the refused-intent settlement
 * (`lib/sync/host-state-intent-settlement.ts`) replays a move locally against a
 * Host too old to know the intent, outside React.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  planSessionMove,
  type MoveSessionPlan,
  type MoveSessionRefusal,
} from "@/lib/chat/move-session-workspace"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { updateSession } from "@/lib/db/sessions"
import { getExecutionBroker } from "@/lib/execution/broker"
import { useProjectStore } from "@/stores/project/project-store"

export type MovableSession = Pick<
  ChatSession,
  "id" | "projectId" | "executionContext" | "handoffLock" | "archivedAt" | "folderId"
>

export type SessionWorkspaceMoveResult =
  /** Moved on this device: the row, its context and both rosters are written. */
  | { status: "moved" }
  /**
   * Handed to the Host, which applies the move and confirms it through
   * `sessions` table sync. A refusal there (a turn the Host is running, a
   * workspace it does not hold) is settled by the outbound queue, like every
   * other routed conversation write.
   */
  | { status: "sent-to-host" }
  /** Refused before anything was written or sent. */
  | { status: "refused"; reason: MoveSessionRefusal }

type ProjectStoreState = ReturnType<typeof useProjectStore.getState>

/**
 * Plan the move against this device's rows. The project store is hydrated
 * first: its `persist()` is gated on `loaded`, so a move issued before the boot
 * initializer hydrated it would write the column and reach no roster.
 */
async function planOnThisDevice(
  session: MovableSession,
  targetId: string
): Promise<{ plan: MoveSessionPlan; store: ProjectStoreState }> {
  await useProjectStore.getState().load()
  const store = useProjectStore.getState()
  const folder = session.folderId ? await getDb().sessionFolders.get(session.folderId) : undefined
  const plan = planSessionMove({
    session,
    folder,
    target: store.projects.find((project) => project.id === targetId) ?? null,
    // The broker rather than the store slice: a conversation with no open
    // pane keeps streaming into Dexie, so a store-only check would call a
    // running background turn idle and let the move land underneath it.
    running: getExecutionBroker().hasActiveSession(session.id),
    now: Date.now(),
  })
  return { plan, store }
}

/** The three writes a move is: the row, its rebuilt context, and both rosters. */
async function writePlannedMove(
  sessionId: string,
  plan: Extract<MoveSessionPlan, { ok: true }>,
  store: ProjectStoreState
): Promise<void> {
  await updateSession(sessionId, {
    projectId: plan.projectId,
    executionContext: plan.executionContext,
    // A folder of the old workspace cannot hold it any more.
    ...(plan.clearFolder ? { folderId: undefined } : {}),
  })
  if (plan.previousProjectId) store.removeSessionFromProject(plan.previousProjectId, sessionId)
  store.addSessionToProject(plan.projectId, sessionId)
}

/**
 * Move `session` to workspace `targetId`: refuse early, else hand it to the
 * Host when one takes it, else write it here. A failed local write throws.
 */
export async function moveSessionWorkspaceRouted(
  session: MovableSession,
  targetId: string
): Promise<SessionWorkspaceMoveResult> {
  const { plan, store } = await planOnThisDevice(session, targetId)
  if (!plan.ok) return { status: "refused", reason: plan.reason }
  const queued = await enqueueHostStateIntentIfAvailable({
    sessionId: session.id,
    action: { kind: "session.workspace", projectId: targetId },
  })
  if (queued) return { status: "sent-to-host" }
  await writePlannedMove(session.id, plan, store)
  return { status: "moved" }
}

/**
 * Move a session on this device only, reading its row from Dexie.
 *
 * For the outbound queue's settlement of a `session.workspace` intent a Host
 * too old to know it refused outright: on such a Host the conversation was
 * never Host-moved, so the honest fallback is the local move this client made
 * before routing existed. Throws when the row is gone.
 */
export async function moveSessionWorkspaceLocally(
  sessionId: string,
  targetId: string
): Promise<SessionWorkspaceMoveResult> {
  const session = await getDb().sessions.get(sessionId)
  if (!session) throw new Error(`session workspace move: session ${sessionId} not found`)
  const { plan, store } = await planOnThisDevice(session, targetId)
  if (!plan.ok) return { status: "refused", reason: plan.reason }
  await writePlannedMove(sessionId, plan, store)
  return { status: "moved" }
}
