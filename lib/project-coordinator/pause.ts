import type { ChatStatus } from "@/stores/chat/chat-store"
import { resolveCoordinatorConfig } from "./config"
import { projectAccess, type ProjectAccess } from "./project-access"
import {
  defaultThreadRuntimeDeps,
  resumeProjectThreads,
  stopThread,
  type ThreadRuntimeDeps,
} from "./thread-runtime"
import { getProjectPrWatch } from "./pr-watch"

/**
 * Pausing a project (ADR-0204) stops everything its coordination runs and
 * keeps it stopped until the person resumes it:
 * - every thread's turn is stopped (or its queued turn withdrawn) and the
 *   thread marked interrupted, which also drops its background hold;
 * - the coordinator's own turn is stopped the same way;
 * - pull-request watching stops, so no nudge lands in a paused thread.
 *
 * What keeps it stopped lives where each kind of turn starts: the chat
 * controller refuses any send into a coordinator or thread of a paused project
 * (`projectPaused`), thread admission refuses starts, `sendToThread` and the
 * reload reconciliation skip paused projects, and reports reach a paused
 * coordinator as notes rather than turns. Resuming delivers the briefs that
 * were started but held back.
 */

export interface PauseDeps extends ProjectAccess {
  runtime: ThreadRuntimeDeps
  stopThread: (threadId: string) => Promise<void>
  untrackPr: (threadId: string) => void
  resumeThreads: (coordinatorSessionId: string) => Promise<void>
}

export function defaultPauseDeps(): PauseDeps {
  const runtime = defaultThreadRuntimeDeps()
  return {
    ...projectAccess,
    runtime,
    stopThread: (threadId) => stopThread(threadId, runtime),
    untrackPr: (threadId) => getProjectPrWatch().untrack(threadId),
    resumeThreads: (coordinatorSessionId) => resumeProjectThreads(coordinatorSessionId, runtime),
  }
}

async function stopCoordinatorTurn(
  sessionId: string,
  runtime: Pick<ThreadRuntimeDeps, "cancelQueued" | "stopTurn" | "statusOf">
): Promise<void> {
  runtime.cancelQueued(sessionId)
  const status: ChatStatus = runtime.statusOf(sessionId)
  if (status !== "idle") await runtime.stopTurn(sessionId)
}

/** Pause a project and stop what is running in it. Idempotent. */
export async function pauseProject(
  projectId: string,
  options: { reason?: string } = {},
  deps: PauseDeps = defaultPauseDeps()
): Promise<void> {
  const project = deps.getProject(projectId)
  const config = resolveCoordinatorConfig(project)
  if (!project) throw new Error(`Workspace ${projectId} was not found`)
  if (!config.paused) {
    const reason = options.reason?.trim()
    deps.updateCoordinator(projectId, {
      paused: { at: deps.runtime.now(), ...(reason ? { reason } : {}) },
    })
  }
  const coordinatorSessionId = config.sessionId
  if (!coordinatorSessionId) return
  const threads = await deps.runtime.listThreads(coordinatorSessionId)
  for (const thread of threads) {
    deps.untrackPr(thread.id)
    // Only a thread with a turn in flight (or queued for one) is stopped. A staged one has nothing
    // to stop, and a started one whose brief has not reached the runtime yet
    // keeps it: resuming delivers it.
    const withdrew = deps.runtime.cancelQueued(thread.id)
    if (withdrew || deps.runtime.statusOf(thread.id) !== "idle") await deps.stopThread(thread.id)
  }
  await stopCoordinatorTurn(coordinatorSessionId, deps.runtime)
}

/** Resume a paused project and deliver the briefs that were held back. */
export async function resumeProject(
  projectId: string,
  deps: PauseDeps = defaultPauseDeps()
): Promise<void> {
  const project = deps.getProject(projectId)
  if (!project) throw new Error(`Workspace ${projectId} was not found`)
  const config = resolveCoordinatorConfig(project)
  if (!config.paused) return
  deps.updateCoordinator(projectId, { paused: undefined })
  if (config.sessionId) await deps.resumeThreads(config.sessionId)
}
