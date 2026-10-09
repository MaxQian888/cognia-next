/**
 * The Host's half of a `session.workspace` intent: a paired client asked the
 * Host to move one of its conversations to another workspace.
 *
 * The client's own plan is never trusted, and never sent: it was made against
 * the client's copy of the rows, and the execution context it would rebuild
 * names directories on the client's disk. The Host re-runs the same planner a
 * desktop move runs (`planSessionMove` in `lib/chat/move-session-workspace.ts`)
 * against ITS session row, ITS workspace and ITS folder, so a phone and the
 * desktop refuse the same moves and write the same row.
 *
 * Three callers share this module:
 * - validation (`validateHostStateBusinessAction`) turns a refusal into a
 *   committed, broadcast rejection the client can read;
 * - the ledger applier (`persistBusinessProjection`) re-plans inside the
 *   ledger transaction, so a turn that started or a workspace that vanished
 *   between validation and commit still refuses the write;
 * - the service relinks the two workspace rosters once the move committed,
 *   through the project store, which is what a desktop move does too.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { HostStateTurnStatus } from "@cognia/agent-config-types/host-state"
import {
  planSessionMove,
  type MoveSessionPlan,
  type MoveSessionRefusal,
} from "@/lib/chat/move-session-workspace"
import type { getDb } from "@/lib/db/schema"
import { getExecutionBroker } from "@/lib/execution/broker"

type Db = ReturnType<typeof getDb>

/**
 * Turn states in which a turn still holds its lease against the old
 * workspace. A queued message counts: its dispatch may already have acquired
 * one, and moving underneath it would settle its patches into a directory
 * nobody is watching — the reason `planSessionMove` refuses a running session.
 */
const TURN_IN_FLIGHT: ReadonlySet<HostStateTurnStatus> = new Set<HostStateTurnStatus>([
  "queued",
  "running",
  "awaiting-decision",
  "stopping",
])

export interface PlanHostSessionMoveInput {
  session: Pick<
    ChatSession,
    "id" | "projectId" | "executionContext" | "handoffLock" | "archivedAt" | "folderId"
  >
  /** The destination the client named. */
  projectId: string
  /** The session channel's confirmed turn, when the Host holds one. */
  turn?: HostStateTurnStatus
  now: number
}

/**
 * Plan a client-requested move against the Host's own rows.
 *
 * An archived workspace is refused as `unknown-workspace`: no surface offers
 * one as a destination (`useSessionWorkspaceMoveMenu` filters them out), so a
 * client naming one is either stale or not one of ours, and the Host is the
 * last place that rule can hold. A session is running when the Host's
 * execution broker holds a leg for it (a desktop-started turn) or its channel
 * says a turn is in flight (a client-started one).
 *
 * Reads `projects` and `sessionFolders` — a caller inside a transaction must
 * include both tables.
 */
export async function planHostSessionMove(
  db: Db,
  input: PlanHostSessionMoveInput
): Promise<MoveSessionPlan> {
  const { session } = input
  const [target, folder] = await Promise.all([
    db.projects.get(input.projectId),
    session.folderId ? db.sessionFolders.get(session.folderId) : Promise.resolve(undefined),
  ])
  return planSessionMove({
    session,
    folder: folder ?? null,
    target: target && !target.isArchived ? target : null,
    running:
      getExecutionBroker().hasActiveSession(session.id) ||
      (input.turn !== undefined && TURN_IN_FLIGHT.has(input.turn)),
    now: input.now,
  })
}

const REFUSAL_MESSAGES: Record<MoveSessionRefusal, string> = {
  "same-workspace": "The conversation is already in that workspace.",
  "unknown-workspace": "The workspace does not exist on this Host.",
  "session-running": "The conversation has a turn in flight.",
  "session-locked": "The session is read-only during a handoff.",
  "session-archived": "An archived conversation stays in its workspace.",
}

/**
 * The receipt rejection for a refused move. One code per refusal
 * (`host_state_move_session_running`, …) so a client — and a log — can tell
 * why without parsing the message.
 */
export function hostSessionMoveRejection(reason: MoveSessionRefusal): {
  code: string
  message: string
} {
  return {
    code: `host_state_move_${reason.replace(/-/g, "_")}`,
    message: REFUSAL_MESSAGES[reason],
  }
}

/**
 * Relink both workspace rosters after a committed move, exactly as a desktop
 * move does: through the project store, so its in-memory list, its persisted
 * `projects` rows and the plugin `sessionLinked` / `sessionUnlinked` events all
 * agree. Writing the `projects` rows from the ledger transaction instead would
 * leave a hydrated store holding the old roster, and its next `persist()` of
 * either workspace would write that roster straight back.
 *
 * The store's `persist()` is gated on `loaded`, so it is hydrated first — a
 * headless Host may never have mounted the initializer that would.
 */
export async function relinkMovedSessionRoster(
  sessionId: string,
  previousProjectId: string | undefined,
  projectId: string
): Promise<void> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  await useProjectStore.getState().load()
  const store = useProjectStore.getState()
  if (previousProjectId && previousProjectId !== projectId) {
    store.removeSessionFromProject(previousProjectId, sessionId)
  }
  store.addSessionToProject(projectId, sessionId)
}
