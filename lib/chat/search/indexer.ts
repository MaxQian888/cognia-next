/**
 * Idle search indexer (ADR-0099).
 *
 * Nothing here runs on the streaming path. `use-claude-chat.ts` persists the
 * streaming message every 250ms (`PERSIST_DEBOUNCE_MS`), rewriting the last row
 * each time; projecting on every one of those writes would re-scan the whole
 * growing message ~4 times a second, so a long answer would cost O(n²) in
 * tokenisation alone. Instead a turn marks its session dirty and the queue is
 * drained at idle — the same "no explicit session-ended event, so use an idle
 * tick after a turn completes" trade-off `lib/memory/lifecycle/maintenance.ts`
 * already makes.
 *
 * The gap that leaves — a message that exists but is not yet projected — is
 * covered on the read side, not here: `searchChatHistory` takes `pendingRows()`
 * and searches those in memory first. So "the thing I just said" is findable
 * immediately even though the index is behind.
 *
 * No leader election across Tauri's several WebViews. Projections are keyed by
 * `messageId`, so two windows indexing the same session overwrite rather than
 * duplicate, and there is no window whose closing stalls indexing.
 */

import {
  backfillChatSearchTextStep,
  deleteChatSearchTextForMessages,
  deleteChatSearchTextForSession,
  reprojectSession,
  type ChatSearchTextRow,
} from "@/lib/db/chat-search-text"
import { peekResidentCorpus } from "./engine"
import type { Corpus } from "./corpus"

export interface SearchIndexerDeps {
  reproject: (sessionId: string) => Promise<{ written: ChatSearchTextRow[]; removed: string[] }>
  deleteForSession: (sessionId: string) => Promise<void>
  deleteForMessages: (ids: readonly string[]) => Promise<void>
  backfillStep: () => Promise<{ projected: number; complete: boolean }>
  corpus: () => Corpus | null
  /** Defer work off the hot path. Tests pass a synchronous runner. */
  schedule: (run: () => void) => void
}

export interface DrainReport {
  sessions: number
  removedSessions: number
  removedMessages: number
  backfilled: number
  backfillComplete: boolean
}

const dirtySessions = new Set<string>()
const removedSessions = new Set<string>()
const removedMessages = new Set<string>()
let draining = false
let scheduled = false

function defaultSchedule(run: () => void): void {
  if (typeof window === "undefined") return
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (typeof idle === "function") idle(run)
  else setTimeout(run, 0)
}

function defaultDeps(): SearchIndexerDeps {
  return {
    reproject: reprojectSession,
    deleteForSession: deleteChatSearchTextForSession,
    deleteForMessages: deleteChatSearchTextForMessages,
    backfillStep: backfillChatSearchTextStep,
    corpus: peekResidentCorpus,
    schedule: defaultSchedule,
  }
}

/** Queue a session whose messages changed. Cheap and synchronous. */
export function markSessionDirty(sessionId: string): void {
  if (!sessionId) return
  dirtySessions.add(sessionId)
}

/** Queue a session whose rows are gone, so its projections go too. */
export function markSessionRemoved(sessionId: string): void {
  if (!sessionId) return
  dirtySessions.delete(sessionId)
  removedSessions.add(sessionId)
}

/**
 * Queue specific messages for removal.
 *
 * Separate from {@link markSessionDirty} because a bulk message delete may not
 * belong to a session that still exists, and because dropping the projections is
 * the urgent half: a stale projection produces a hit that jumps nowhere.
 */
export function markMessagesRemoved(ids: readonly string[]): void {
  for (const id of ids) {
    if (id) removedMessages.add(id)
  }
}

/** True while anything is waiting to be indexed. Drives the coverage note. */
export function hasPendingIndexWork(): boolean {
  return dirtySessions.size > 0 || removedSessions.size > 0 || removedMessages.size > 0
}

/** Sessions still waiting to be projected — the read-side fallback's scope. */
export function pendingDirtySessionIds(): string[] {
  return [...dirtySessions]
}

/**
 * Ask for a drain at the next idle moment. Coalesces: many turns landing in one
 * frame produce one drain.
 */
export function scheduleSearchIndexDrain(overrides: Partial<SearchIndexerDeps> = {}): void {
  if (scheduled || draining) return
  scheduled = true
  const deps = { ...defaultDeps(), ...overrides }
  deps.schedule(() => {
    scheduled = false
    void drainSearchIndex(overrides)
  })
}

export interface DrainOptions {
  /**
   * Take a backfill step as part of this drain. Default true.
   *
   * `false` is for the READ path. `backfillChatSearchTextStep` reads 500 whole
   * `messages` rows — `parts` included, so tool outputs and media reference
   * sets — and both search surfaces call `drainSearchIndex()` in front of every
   * debounced query. Until the backfill completes, that made each keystroke pay
   * for a 500-row read it never needed: the query only requires the DIRTY
   * sessions to be flushed, so that a message the user just sent is findable.
   * Widening coverage into older history is the idle scheduler's job, and it
   * still runs — {@link scheduleSearchIndexDrain} re-arms below.
   */
  backfill?: boolean
}

/**
 * Process the queue, then take **one** backfill step.
 *
 * One step, not a loop: the backfill walks the whole account's history, and
 * finishing it inside a single idle callback is exactly the long task idle
 * callbacks exist to avoid. If history remains, another drain is scheduled, so
 * progress is incremental and always yields between batches.
 */
export async function drainSearchIndex(
  overrides: Partial<SearchIndexerDeps> = {},
  { backfill = true }: DrainOptions = {}
): Promise<DrainReport> {
  const deps = { ...defaultDeps(), ...overrides }
  const empty: DrainReport = {
    sessions: 0,
    removedSessions: 0,
    removedMessages: 0,
    backfilled: 0,
    backfillComplete: false,
  }
  // A second drain would re-read the same queue and double the work; the first
  // one already owns it.
  if (draining) return empty
  draining = true

  const report = { ...empty }
  try {
    // Removals first: a stale projection is a wrong answer, an un-projected
    // message is only a late one.
    const goneSessions = [...removedSessions]
    removedSessions.clear()
    for (const sessionId of goneSessions) {
      await deps.deleteForSession(sessionId)
      report.removedSessions++
    }

    const goneMessages = [...removedMessages]
    removedMessages.clear()
    if (goneMessages.length > 0) {
      await deps.deleteForMessages(goneMessages)
      deps.corpus()?.remove(goneMessages)
      report.removedMessages = goneMessages.length
    }

    const sessionIds = [...dirtySessions]
    dirtySessions.clear()
    // Accumulate across sessions and fold ONCE. `Corpus.fold` rebuilds every
    // chunk (it concatenates up to ~12M characters), so folding per session
    // turned a 500-session history import into 500 full corpus rebuilds.
    const foldRows: ChatSearchTextRow[] = []
    const foldRemoved: string[] = []
    for (const sessionId of sessionIds) {
      const { written, removed } = await deps.reproject(sessionId)
      foldRows.push(...written)
      foldRemoved.push(...removed)
      report.sessions++
    }
    const corpus = deps.corpus()
    if (corpus) {
      if (foldRemoved.length > 0) corpus.remove(foldRemoved)
      // `reprojectSession` returns ascending `createdAt`; `fold` re-sorts, so
      // the order handed over here no longer decides result ordering.
      if (foldRows.length > 0) corpus.fold(foldRows)
    }

    if (backfill) {
      const step = await deps.backfillStep()
      report.backfilled = step.projected
      report.backfillComplete = step.complete
    }
  } finally {
    draining = false
  }

  // More history, or work queued while we ran — come back at the next idle tick.
  // A skipped backfill leaves `backfillComplete` false, which is what re-arms
  // the idle drain that will actually take the step.
  if (!report.backfillComplete || hasPendingIndexWork()) {
    scheduleSearchIndexDrain(overrides)
  }

  return report
}

/** Test hook — clear the queues and the in-flight guard. */
export function __resetSearchIndexerForTesting(): void {
  dirtySessions.clear()
  removedSessions.clear()
  removedMessages.clear()
  draining = false
  scheduled = false
}
