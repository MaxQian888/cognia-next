/**
 * The auto-archive sweep: a scheduler maintenance task that archives
 * conversations idle for longer than `AppSettings.conversationArchive
 * .autoArchiveAfterDays` (see `./auto-archive.ts` for which ones qualify).
 *
 * Shaped like the provider-diagnostics refresh clock
 * (`lib/provider-diagnostics/refresh.ts`): the executor registration is
 * separate from the boot install, because the persisted task outlives the boot
 * that seeded it and the scheduler loads the executor on demand through
 * `lib/scheduler/executor-owners.ts`.
 *
 * The task is installed on every host and decides per fire, because what it
 * should do changes at runtime:
 * - off (no valid day count) → a no-op success;
 * - a paired client whose Host owns the session rows → skipped, successfully,
 *   with the reason in the output. The Host runs its own sweep over its own
 *   rows; a client archiving its mirror would hand the Host one archive intent
 *   per conversation under a policy the Host never chose;
 * - otherwise → archive the candidates through `setSessionsArchived`, the one
 *   routed archive write every surface shares.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { inFlightSessionIds } from "@/lib/chat/aggregate-run-state"
import { setSessionsArchived } from "@/lib/chat/session-archive-writes"
import { getSettings } from "@/lib/db/settings"
import { listSessions } from "@/lib/db/sessions"
import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import type { CreateScheduledTaskInput, ScheduledTaskType } from "@/types/scheduler"

import { resolveAutoArchiveAfterDays, selectAutoArchiveCandidates } from "./auto-archive"

const log = loggers.scheduler

export const CONVERSATION_AUTO_ARCHIVE_TASK_TYPE =
  "conversation-auto-archive" satisfies ScheduledTaskType

/**
 * How often the sweep runs. The shortest policy is a week, so a few hours of
 * lag is invisible, while a sweep per few minutes would rescan every session
 * row for nothing.
 */
export const CONVERSATION_AUTO_ARCHIVE_INTERVAL_MS = 6 * 60 * 60_000

export const CONVERSATION_AUTO_ARCHIVE_TASK_TAG = "system:conversation-archive"

/** What the conversation store knows about live conversations right now. */
export interface ConversationLiveState {
  activeSessionId: string | null
  runningIds: ReadonlySet<string>
  openIds: ReadonlySet<string>
}

export type ConversationAutoArchiveSkip = "off" | "host-owned"

// A type alias, not an interface: the run output is stored as a
// `Record<string, unknown>`, which only an alias satisfies structurally.
export type ConversationAutoArchiveOutcome = {
  scanned: number
  archived: number
  /** Present when the sweep did not look at the rows, and why. */
  skipped?: ConversationAutoArchiveSkip
  /** The effective threshold of a sweep that ran. */
  afterDays?: number
}

export interface ConversationAutoArchiveDependencies {
  now: () => number
  getSettings: () => Promise<Pick<AppSettings, "conversationArchive">>
  hostOwnsSessions: () => boolean
  listSessions: () => Promise<ChatSession[]>
  liveState: () => Promise<ConversationLiveState>
  archive: (ids: readonly string[]) => Promise<void>
}

/**
 * Read the live conversation state from the chat store. Loaded lazily so the
 * scheduler's executor chunk does not pull the store into every host that only
 * registers the task; on a headless brain with no conversation open the store
 * is simply empty, and the exclusions below are no-ops.
 */
async function readLiveState(): Promise<ConversationLiveState> {
  const { useChatStore } = await import("@/stores/chat/chat-store")
  const state = useChatStore.getState()
  const openIds = new Set<string>(state.openSessionIds)
  for (const [sessionId, panes] of Object.entries(state.paneIdsBySession ?? {})) {
    if (panes.length > 0) openIds.add(sessionId)
  }
  for (const [sessionId, holders] of Object.entries(state.backgroundHolds ?? {})) {
    if (holders.length > 0) openIds.add(sessionId)
  }
  if (state.splitSessionId) openIds.add(state.splitSessionId)
  // The focused session's top-level status mirror needs no read of its own:
  // the focused session is excluded as `activeSessionId` whatever it is doing.
  const runningIds = new Set(inFlightSessionIds(state.sessions))
  return { activeSessionId: state.activeSessionId, runningIds, openIds }
}

const DEFAULT_DEPENDENCIES: ConversationAutoArchiveDependencies = {
  now: Date.now,
  getSettings,
  hostOwnsSessions: () => hostOwnsSessionState(getRuntimeSnapshot()),
  listSessions,
  liveState: readLiveState,
  archive: (ids) => setSessionsArchived(ids, true),
}

/** One sweep. Throws when the archive write fails, so the run is recorded as failed. */
export async function runConversationAutoArchive(
  dependencies: Partial<ConversationAutoArchiveDependencies> = {}
): Promise<ConversationAutoArchiveOutcome> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const afterDays = resolveAutoArchiveAfterDays((await deps.getSettings()).conversationArchive)
  if (afterDays === null) return { scanned: 0, archived: 0, skipped: "off" }
  if (deps.hostOwnsSessions()) {
    log.info("[ConversationAutoArchive] skipped: the paired Host owns the conversations")
    return { scanned: 0, archived: 0, skipped: "host-owned" }
  }

  const [sessions, live] = await Promise.all([deps.listSessions(), deps.liveState()])
  const ids = selectAutoArchiveCandidates(sessions, {
    now: deps.now(),
    afterDays,
    activeSessionId: live.activeSessionId,
    runningIds: live.runningIds,
    openIds: live.openIds,
  })
  if (ids.length > 0) {
    await deps.archive(ids)
    log.info(
      `[ConversationAutoArchive] archived ${ids.length} of ${sessions.length} conversations idle for more than ${afterDays} days`
    )
  }
  return { scanned: sessions.length, archived: ids.length, afterDays }
}

/**
 * Register the scheduler executor for the sweep. Separate from
 * {@link installConversationAutoArchiveSchedule} for the same reason the
 * provider-diagnostics clock is: see `lib/scheduler/executor-owners.ts`.
 */
export function registerConversationAutoArchiveExecutor(): void {
  registerTaskExecutor(CONVERSATION_AUTO_ARCHIVE_TASK_TYPE, async () => {
    try {
      return { success: true, output: await runConversationAutoArchive() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`[ConversationAutoArchive] sweep failed: ${message}`)
      return { success: false, error: message }
    }
  })
}

/** Register the executor and make sure exactly one sweep task exists. */
export async function installConversationAutoArchiveSchedule(): Promise<void> {
  registerConversationAutoArchiveExecutor()
  const scheduler = getTaskScheduler()
  const existing = (await scheduler.getAllTasks()).filter(
    (task) => task.type === CONVERSATION_AUTO_ARCHIVE_TASK_TYPE
  )
  if (existing.length > 0) return
  const task: CreateScheduledTaskInput = {
    name: "Conversation auto-archive",
    type: CONVERSATION_AUTO_ARCHIVE_TASK_TYPE,
    trigger: { type: "interval", intervalMs: CONVERSATION_AUTO_ARCHIVE_INTERVAL_MS },
    // A missed sweep loses nothing (the next one sees the same rows), but one
    // catch-up run after a long offline stretch archives promptly instead of
    // up to six hours later.
    config: { runMissedOnStartup: true, catchupWindowMs: 24 * 60 * 60_000, maxMissedRuns: 1 },
    notification: {
      dueReminder: false,
      onStart: false,
      onComplete: false,
      onError: true,
      onProgress: false,
      channels: ["none"],
    },
    createdBy: { kind: "user" },
    tags: [CONVERSATION_AUTO_ARCHIVE_TASK_TAG],
  }
  await scheduler.createTask(task)
}
