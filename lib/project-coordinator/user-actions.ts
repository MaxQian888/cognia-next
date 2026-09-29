import type { ChatSession } from "@cognia/agent-config-types"
import type { SpawnedTaskBrief } from "@/lib/tasks/spawn-task-core"
import type { ThreadRefusal } from "./admission"
import { ensureCoordinatorSession } from "./coordinator-session"
import { updateCoordinator } from "./project-access"
import { createThreadSession } from "./thread-session"
import { checkThreadCreation, startThread, type StartThreadResult } from "./thread-runtime"

/**
 * The actions a person takes from the project UI (ADR-0204), so components
 * stay presentational and every entry point runs the same sequence.
 */

/** Turn coordination on and make sure the coordinator conversation exists. */
export async function enableProjectCoordination(
  projectId: string,
  coordinatorTitle: string,
  deps: {
    update: typeof updateCoordinator
    ensure: typeof ensureCoordinatorSession
  } = { update: updateCoordinator, ensure: ensureCoordinatorSession }
): Promise<ChatSession> {
  deps.update(projectId, { enabled: true })
  return deps.ensure({ projectId, title: coordinatorTitle })
}

/** Turn coordination off. Rows keep their roles; they behave as plain chats until re-enabled. */
export function disableProjectCoordination(
  projectId: string,
  update: typeof updateCoordinator = updateCoordinator
): void {
  update(projectId, { enabled: false })
}

export type StartProposalResult =
  | { kind: "refused"; reason: ThreadRefusal }
  | { kind: "created"; thread: ChatSession; start: StartThreadResult }

/** Start a thread the coordinator proposed — the user's click is the go-ahead. */
export async function startProposedThread(
  input: {
    projectId: string
    coordinatorSessionId: string
    brief: SpawnedTaskBrief
    rootId?: string
  },
  deps: {
    check: typeof checkThreadCreation
    create: typeof createThreadSession
    start: typeof startThread
  } = { check: checkThreadCreation, create: createThreadSession, start: startThread }
): Promise<StartProposalResult> {
  const admission = await deps.check(input.projectId, input.coordinatorSessionId)
  if (admission.kind === "refuse") return { kind: "refused", reason: admission.reason }
  const thread = await deps.create({ ...input, proposedBy: "user" })
  return { kind: "created", thread, start: await deps.start(thread.id, "user") }
}
