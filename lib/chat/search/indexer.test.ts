import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { buildCorpus, type Corpus } from "./corpus"
import {
  __resetSearchIndexerForTesting,
  drainSearchIndex,
  hasPendingIndexWork,
  markMessagesRemoved,
  markSessionDirty,
  markSessionRemoved,
  pendingDirtySessionIds,
  scheduleSearchIndexDrain,
  type SearchIndexerDeps,
} from "./indexer"

function row(text: string, over: Partial<ChatSearchTextRow> = {}): ChatSearchTextRow {
  return {
    messageId: over.messageId ?? "m1",
    sessionId: over.sessionId ?? "s1",
    projectId: over.projectId ?? "p1",
    role: over.role ?? "user",
    createdAt: over.createdAt ?? 1_000,
    text,
  }
}

/** Deps that never touch Dexie, so this suite runs in the fast node env. */
function deps(over: Partial<SearchIndexerDeps> = {}): Partial<SearchIndexerDeps> {
  return {
    reproject: async () => ({ written: [], removed: [] }),
    deleteForSession: async () => {},
    deleteForMessages: async () => {},
    backfillStep: async () => ({ projected: 0, complete: true }),
    corpus: () => null,
    // Synchronous so a scheduled drain is observable without timers.
    schedule: (run) => run(),
    ...over,
  }
}

beforeEach(() => {
  __resetSearchIndexerForTesting()
})

describe("queueing", () => {
  it("starts with nothing pending", () => {
    expect(hasPendingIndexWork()).toBe(false)
    expect(pendingDirtySessionIds()).toEqual([])
  })

  it("records a dirty session", () => {
    markSessionDirty("s1")
    expect(hasPendingIndexWork()).toBe(true)
    expect(pendingDirtySessionIds()).toEqual(["s1"])
  })

  it("coalesces repeated marks for one session", () => {
    markSessionDirty("s1")
    markSessionDirty("s1")
    expect(pendingDirtySessionIds()).toEqual(["s1"])
  })

  it("ignores a blank id", () => {
    markSessionDirty("")
    markSessionRemoved("")
    markMessagesRemoved([""])
    expect(hasPendingIndexWork()).toBe(false)
  })

  it("supersedes a dirty mark with a removal", () => {
    // Re-projecting a session that was just deleted would re-create the rows the
    // removal is there to drop.
    markSessionDirty("s1")
    markSessionRemoved("s1")
    expect(pendingDirtySessionIds()).toEqual([])
    expect(hasPendingIndexWork()).toBe(true)
  })

  it("records removed message ids", () => {
    markMessagesRemoved(["a", "b"])
    expect(hasPendingIndexWork()).toBe(true)
  })
})

describe("drainSearchIndex", () => {
  it("drains an empty queue without doing work", async () => {
    const report = await drainSearchIndex(deps())
    expect(report).toEqual({
      sessions: 0,
      removedSessions: 0,
      removedMessages: 0,
      backfilled: 0,
      backfillComplete: true,
    })
  })

  it("re-projects each dirty session exactly once", async () => {
    const reproject = jest.fn(async () => ({ written: [], removed: [] }))
    markSessionDirty("s1")
    markSessionDirty("s2")
    const report = await drainSearchIndex(deps({ reproject }))
    expect(reproject).toHaveBeenCalledTimes(2)
    expect(report.sessions).toBe(2)
    expect(hasPendingIndexWork()).toBe(false)
  })

  it("deletes a removed session's projections", async () => {
    const deleteForSession = jest.fn(async () => {})
    markSessionRemoved("s1")
    const report = await drainSearchIndex(deps({ deleteForSession }))
    expect(deleteForSession).toHaveBeenCalledWith("s1")
    expect(report.removedSessions).toBe(1)
  })

  it("deletes removed messages in one batch", async () => {
    const deleteForMessages = jest.fn(async () => {})
    markMessagesRemoved(["a", "b"])
    const report = await drainSearchIndex(deps({ deleteForMessages }))
    expect(deleteForMessages).toHaveBeenCalledWith(["a", "b"])
    expect(report.removedMessages).toBe(2)
  })

  it("processes removals before re-projections", async () => {
    // A stale projection is a wrong answer; an un-projected message is only a
    // late one. Order matters if both touch the same session.
    const calls: string[] = []
    markSessionRemoved("gone")
    markSessionDirty("fresh")
    await drainSearchIndex(
      deps({
        deleteForSession: async (id) => {
          calls.push(`del:${id}`)
        },
        reproject: async (id) => {
          calls.push(`proj:${id}`)
          return { written: [], removed: [] }
        },
      })
    )
    expect(calls).toEqual(["del:gone", "proj:fresh"])
  })

  // ---- corpus folding ----

  it("folds newly-projected rows into the resident corpus", async () => {
    const corpus = buildCorpus([])
    markSessionDirty("s1")
    await drainSearchIndex(
      deps({
        corpus: () => corpus,
        reproject: async () => ({
          written: [row("fresh needle", { messageId: "new" })],
          removed: [],
        }),
      })
    )
    expect(corpus.search("needle", 5).map((h) => h.row.messageId)).toEqual(["new"])
  })

  it("folds rows in newest-first order", async () => {
    // `reprojectSession` returns ascending createdAt; the corpus wants
    // newest-first. Getting this backwards silently inverts result ordering for
    // every freshly-indexed turn.
    const corpus = buildCorpus([])
    markSessionDirty("s1")
    await drainSearchIndex(
      deps({
        corpus: () => corpus,
        reproject: async () => ({
          written: [
            row("needle older", { messageId: "old", createdAt: 10 }),
            row("needle newer", { messageId: "new", createdAt: 20 }),
          ],
          removed: [],
        }),
      })
    )
    expect(corpus.search("needle", 5).map((h) => h.row.messageId)).toEqual(["new", "old"])
  })

  it("folds every dirty session into the corpus in ONE rebuild", async () => {
    // `Corpus.fold` re-concatenates every chunk, so folding per session turned
    // a bulk history import into one full rebuild per imported conversation.
    const corpus = buildCorpus([])
    const folds = jest.spyOn(corpus, "fold")
    markSessionDirty("s1")
    markSessionDirty("s2")
    await drainSearchIndex(
      deps({
        corpus: () => corpus,
        reproject: async (sessionId) => ({
          written: [row("needle", { messageId: sessionId, sessionId })],
          removed: [],
        }),
      })
    )
    expect(folds).toHaveBeenCalledTimes(1)
    expect(
      corpus
        .search("needle", 5)
        .map((h) => h.row.messageId)
        .sort()
    ).toEqual(["s1", "s2"])
  })

  it("drops re-projection removals from the corpus", async () => {
    const corpus = buildCorpus([row("needle", { messageId: "truncated" })])
    markSessionDirty("s1")
    await drainSearchIndex(
      deps({
        corpus: () => corpus,
        reproject: async () => ({ written: [], removed: ["truncated"] }),
      })
    )
    expect(corpus.search("needle", 5)).toEqual([])
  })

  it("drops removed messages from the corpus", async () => {
    const corpus = buildCorpus([row("needle", { messageId: "gone" })])
    markMessagesRemoved(["gone"])
    await drainSearchIndex(deps({ corpus: () => corpus }))
    expect(corpus.search("needle", 5)).toEqual([])
  })

  it("works when no corpus has been loaded yet", async () => {
    const corpus = jest.fn(() => null as Corpus | null)
    markSessionDirty("s1")
    markMessagesRemoved(["gone"])
    await expect(
      drainSearchIndex(
        deps({ corpus, reproject: async () => ({ written: [row("x")], removed: ["y"] }) })
      )
    ).resolves.toBeDefined()
  })

  // ---- backfill pacing ----

  it("takes exactly one backfill step per drain", async () => {
    const backfillStep = jest.fn(async () => ({ projected: 500, complete: true }))
    const report = await drainSearchIndex(deps({ backfillStep }))
    expect(backfillStep).toHaveBeenCalledTimes(1)
    expect(report.backfilled).toBe(500)
  })

  it("schedules another drain while history remains", async () => {
    // One step per idle callback: finishing the whole walk inside one callback is
    // the long task idle callbacks exist to avoid.
    let steps = 0
    const backfillStep = jest.fn(async () => {
      steps += 1
      return { projected: 10, complete: steps >= 3 }
    })
    await drainSearchIndex(deps({ backfillStep }))
    expect(steps).toBe(3)
  })

  it("stops scheduling once the backfill is complete and the queue is empty", async () => {
    const schedule = jest.fn((run: () => void) => run())
    await drainSearchIndex(deps({ schedule }))
    expect(schedule).not.toHaveBeenCalled()
  })

  it("comes back for work queued while it was running", async () => {
    let first = true
    const reproject = jest.fn(async () => {
      if (first) {
        first = false
        // Arrives mid-drain — the queue was already taken, so only a follow-up
        // drain will see it.
        markSessionDirty("late")
      }
      return { written: [], removed: [] }
    })
    markSessionDirty("s1")
    await drainSearchIndex(deps({ reproject }))
    expect(reproject.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(hasPendingIndexWork()).toBe(false)
  })

  it("does not run two drains concurrently", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const reproject = jest.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return { written: [], removed: [] }
    })
    markSessionDirty("s1")
    markSessionDirty("s2")
    const d = deps({ reproject })
    await Promise.all([drainSearchIndex(d), drainSearchIndex(d)])
    expect(maxInFlight).toBe(1)
  })

  it("reports an empty drain when one is already running", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    markSessionDirty("s1")
    const d = deps({
      reproject: async () => {
        await gate
        return { written: [], removed: [] }
      },
    })
    const running = drainSearchIndex(d)
    const second = await drainSearchIndex(d)
    expect(second.sessions).toBe(0)
    release!()
    await running
  })

  it("clears the in-flight guard even when a step throws", async () => {
    markSessionDirty("s1")
    await expect(
      drainSearchIndex(
        deps({
          reproject: async () => {
            throw new Error("dexie exploded")
          },
        })
      )
    ).rejects.toThrow("dexie exploded")
    // A stuck guard would silently stop all future indexing.
    const report = await drainSearchIndex(deps())
    expect(report.backfillComplete).toBe(true)
  })
})

describe("scheduleSearchIndexDrain", () => {
  it("runs a drain through the scheduler", async () => {
    const reproject = jest.fn(async () => ({ written: [], removed: [] }))
    markSessionDirty("s1")
    scheduleSearchIndexDrain(deps({ reproject }))
    await Promise.resolve()
    await Promise.resolve()
    expect(reproject).toHaveBeenCalled()
  })

  it("coalesces repeated requests into one scheduled drain", async () => {
    const schedule = jest.fn()
    scheduleSearchIndexDrain(deps({ schedule }))
    scheduleSearchIndexDrain(deps({ schedule }))
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it("does nothing under the default scheduler with no window", () => {
    // This suite runs in the node project, so it exercises the SSR guard in
    // `defaultSchedule`. Static export pre-renders these modules; scheduling an
    // idle callback there would throw rather than degrade.
    expect(typeof window).toBe("undefined")
    markSessionDirty("s1")
    expect(() => scheduleSearchIndexDrain()).not.toThrow()
    // Still queued: nothing ran, so nothing was consumed.
    expect(pendingDirtySessionIds()).toEqual(["s1"])
  })
})
