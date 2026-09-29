import type { ChatSession } from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { useChatStore } from "@/stores/chat"
import { getSession, listSessionBranches } from "@/lib/db/sessions"
import {
  consumeStagedPrompt,
  interruptAttachedSession,
  markAttachedSessionRunning,
} from "@/lib/chat/attached-session"
import { cancelQueuedChatTurn } from "@/lib/execution/chat-lease"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { stopChatTurn } from "@/hooks/chat/chat-control-bridge"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import {
  admitThreadCreation,
  admitThreadStart,
  startOfLocalDay,
  type ThreadAdmission,
  type ThreadRefusal,
} from "./admission"
import { resolveCoordinatorConfig } from "./config"
import { projectAccess, type ProjectAccess } from "./project-access"

/**
 * Runs project threads in the background (ADR-0204). A thread is an ordinary
 * conversation; what this module adds is keeping it live with no surface
 * mounted (a chat-store background hold, so its approvals wait for a person
 * and its events stream into its slice) and submitting its staged brief
 * through the same `send` a person's message takes — worktree, leases,
 * budget and every send-time gate included.
 *
 * Lifecycle, as recorded on `attachedChild.status`:
 *   staged  → created, waiting for admission or for the user to press Start
 *   running → started; while `spawnedTask.pendingPrompt` is still present the
 *             brief has not reached the runtime yet (redelivered on resume)
 *   completed / interrupted → a turn ended; a new message makes it running
 */

export const THREAD_HOLDER_ID = "project-thread"

export interface ThreadRuntimeDeps extends Pick<ProjectAccess, "getProject"> {
  getSession: (id: string) => Promise<ChatSession | undefined>
  listThreads: (coordinatorSessionId: string) => Promise<ChatSession[]>
  markRunning: (threadId: string) => Promise<void>
  interrupt: (threadId: string, ownerSessionId: string) => Promise<void>
  consumeStagedPrompt: (
    threadId: string,
    mode: NonNullable<ChatSession["spawnedTask"]>["mode"]
  ) => Promise<void>
  send: (sessionId: string, text: string) => boolean
  stopTurn: (sessionId: string) => Promise<boolean>
  cancelQueued: (sessionId: string) => boolean
  hold: (sessionId: string) => void
  release: (sessionId: string) => void
  statusOf: (sessionId: string) => ChatStatus
  now: () => number
}

export function defaultThreadRuntimeDeps(): ThreadRuntimeDeps {
  return {
    getProject: projectAccess.getProject,
    getSession,
    listThreads: async (coordinatorSessionId) =>
      (await listSessionBranches(coordinatorSessionId)).filter(isThreadOf(coordinatorSessionId)),
    markRunning: (threadId) => markAttachedSessionRunning(threadId),
    interrupt: (threadId, owner) => interruptAttachedSession(threadId, owner),
    consumeStagedPrompt: (threadId, mode) => consumeStagedPrompt(threadId, mode),
    send: sendChatMessage,
    stopTurn: stopChatTurn,
    cancelQueued: cancelQueuedChatTurn,
    hold: (sessionId) => useChatStore.getState().holdInBackground(sessionId, THREAD_HOLDER_ID),
    release: (sessionId) =>
      useChatStore.getState().releaseBackgroundHold(sessionId, THREAD_HOLDER_ID),
    statusOf: sessionStatusOf,
    now: Date.now,
  }
}

export function isThreadOf(coordinatorSessionId: string) {
  return (session: ChatSession): boolean =>
    session.projectRole === "thread" &&
    session.projectThread?.coordinatorSessionId === coordinatorSessionId &&
    session.archivedAt === undefined &&
    session.importTombstonedAt === undefined
}

/** Threads of a coordinator with a turn in flight or waiting on a person. */
export async function countActiveThreads(
  coordinatorSessionId: string,
  deps: Pick<ThreadRuntimeDeps, "listThreads" | "statusOf"> = defaultThreadRuntimeDeps()
): Promise<number> {
  const threads = await deps.listThreads(coordinatorSessionId)
  return threads.filter((thread) => deps.statusOf(thread.id) !== "idle").length
}

/** How many threads the coordinator created since local midnight. */
export async function countThreadsCreatedToday(
  coordinatorSessionId: string,
  deps: Pick<ThreadRuntimeDeps, "listThreads" | "now"> = defaultThreadRuntimeDeps()
): Promise<number> {
  const since = startOfLocalDay(deps.now())
  const threads = await deps.listThreads(coordinatorSessionId)
  return threads.filter((thread) => thread.createdAt >= since).length
}

/** Hard-limit check before creating a thread (paused, disabled, daily cap). */
export async function checkThreadCreation(
  projectId: string,
  coordinatorSessionId: string,
  deps: ThreadRuntimeDeps = defaultThreadRuntimeDeps()
): Promise<{ kind: "allow" } | { kind: "refuse"; reason: ThreadRefusal }> {
  const config = resolveCoordinatorConfig(deps.getProject(projectId))
  return admitThreadCreation({
    config,
    createdToday: await countThreadsCreatedToday(coordinatorSessionId, deps),
  })
}

export type StartThreadResult =
  | { kind: "started" }
  | { kind: "pending-runtime" }
  | Exclude<ThreadAdmission, { kind: "start" }>
  | { kind: "not-startable"; reason: "missing" | "not-thread" | "already-started" }

/**
 * Admit and start a staged thread. `pending-runtime` means the chat runtime is
 * not mounted yet (app bootstrap): the thread is recorded as started and its
 * brief is delivered by {@link resumeProjectThreads} once it is.
 */
export async function startThread(
  threadId: string,
  requestedBy: "coordinator" | "user",
  deps: ThreadRuntimeDeps = defaultThreadRuntimeDeps()
): Promise<StartThreadResult> {
  const thread = await deps.getSession(threadId)
  if (!thread) return { kind: "not-startable", reason: "missing" }
  if (thread.projectRole !== "thread" || !thread.projectThread || !thread.projectId) {
    return { kind: "not-startable", reason: "not-thread" }
  }
  if (!thread.spawnedTask?.pendingPrompt || thread.attachedChild?.status !== "staged") {
    return { kind: "not-startable", reason: "already-started" }
  }
  const admission = admitThreadStart({
    config: resolveCoordinatorConfig(deps.getProject(thread.projectId)),
    running: await countActiveThreads(thread.projectThread.coordinatorSessionId, deps),
    requestedBy,
  })
  if (admission.kind !== "start") return admission
  await deps.markRunning(threadId)
  return (await deliverStagedPrompt(thread, deps))
    ? { kind: "started" }
    : { kind: "pending-runtime" }
}

async function deliverStagedPrompt(thread: ChatSession, deps: ThreadRuntimeDeps): Promise<boolean> {
  const prompt = thread.spawnedTask?.pendingPrompt
  if (!prompt) return false
  deps.hold(thread.id)
  if (!deps.send(thread.id, prompt)) {
    deps.release(thread.id)
    return false
  }
  await deps.consumeStagedPrompt(thread.id, thread.spawnedTask?.mode ?? "aside")
  return true
}

/**
 * Deliver a follow-up into a thread (coordinator routing, a PR nudge). Holds
 * it so the resulting turn runs — and can ask for approval — with no surface
 * open; a finished thread becomes running again.
 */
export async function sendToThread(
  threadId: string,
  text: string,
  deps: ThreadRuntimeDeps = defaultThreadRuntimeDeps()
): Promise<boolean> {
  const thread = await deps.getSession(threadId)
  if (thread?.projectRole !== "thread" || !thread.projectId) return false
  if (resolveCoordinatorConfig(deps.getProject(thread.projectId)).paused) return false
  deps.hold(threadId)
  if (!deps.send(threadId, text)) {
    deps.release(threadId)
    return false
  }
  if (thread.attachedChild?.status !== "running") await deps.markRunning(threadId)
  return true
}

const stopping = new Set<string>()

/**
 * True while {@link stopThread} is tearing a thread down — the turn-end that
 * the stop itself causes is not a result to report.
 */
export function isThreadStopping(threadId: string): boolean {
  return stopping.has(threadId)
}

/** Stop a thread's turn (or withdraw a queued one) and mark it interrupted. */
export async function stopThread(
  threadId: string,
  deps: ThreadRuntimeDeps = defaultThreadRuntimeDeps()
): Promise<void> {
  const thread = await deps.getSession(threadId)
  if (thread?.projectRole !== "thread" || !thread.projectThread) return
  stopping.add(threadId)
  try {
    deps.cancelQueued(threadId)
    if (deps.statusOf(threadId) !== "idle") await deps.stopTurn(threadId)
    await deps.interrupt(threadId, thread.projectThread.coordinatorSessionId)
    deps.release(threadId)
  } finally {
    stopping.delete(threadId)
  }
}

/**
 * A thread's turn ended: drop the hold unless the thread still needs its
 * slice (an ask waiting for a person keeps it; the store enforces that).
 */
export function releaseThreadHold(
  threadId: string,
  deps: Pick<ThreadRuntimeDeps, "release"> = defaultThreadRuntimeDeps()
): void {
  deps.release(threadId)
}

/**
 * Reconcile after a reload: deliver every brief that was started but never
 * reached the runtime, and mark threads whose turn died with the previous
 * process as interrupted — a turn does not survive a restart, and leaving
 * them `running` would show work that is not happening.
 */
export async function resumeProjectThreads(
  coordinatorSessionId: string,
  deps: ThreadRuntimeDeps = defaultThreadRuntimeDeps()
): Promise<void> {
  const threads = await deps.listThreads(coordinatorSessionId)
  for (const thread of threads) {
    if (thread.attachedChild?.status !== "running") continue
    if (thread.spawnedTask?.pendingPrompt) {
      if (thread.projectId && resolveCoordinatorConfig(deps.getProject(thread.projectId)).paused) {
        continue
      }
      await deliverStagedPrompt(thread, deps)
    } else if (deps.statusOf(thread.id) === "idle") {
      await deps.interrupt(thread.id, coordinatorSessionId)
    }
  }
}
