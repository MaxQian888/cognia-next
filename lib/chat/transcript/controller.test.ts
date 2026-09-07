import type {
  SessionTimelinePage,
  SessionTurnMessagesPage,
  TranscriptSource as PublicTranscriptSource,
} from "./controller"
import { TranscriptController } from "./controller"
import { transcriptCapabilitiesV1 } from "./source"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function systemItem(id: string, startedAt: number, revision = 1) {
  return {
    kind: "system" as const,
    itemKey: id,
    revision,
    status: "completed" as const,
    message: { id, role: "system" as const, text: id, createdAt: startedAt },
    startedAt,
  }
}

function completedItem(revision: number) {
  return {
    kind: "completed-turn" as const,
    itemKey: "turn:u1",
    turnKey: "turn:u1",
    revision,
    detailRevision: revision,
    status: "completed" as const,
    startedAt: 1,
    userMessages: [{ id: "u1", role: "user" as const, text: "question", createdAt: 1 }],
    collapsed: { exists: true, messageCount: 2, trailingCount: 0, mediaCount: 0 },
  }
}

async function flushRequests() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

function page(overrides: Partial<SessionTimelinePage> = {}): SessionTimelinePage {
  return { items: [], revision: 1, hasMore: false, ...overrides }
}

describe("TranscriptController", () => {
  it("bounds revision-burst transfer volume with a fixed 30-row payload", async () => {
    const samples: { requests: number; bytes: number; revision: number | null }[] = []
    for (let sample = 0; sample < 11; sample++) {
      let notify!: (revision: number) => void
      const delayed = deferred<void>()
      let requests = 0
      let bytes = 0
      const response = (revision: number) =>
        page({
          revision,
          items: Array.from({ length: 30 }, (_, index) => ({
            ...systemItem(`row-${index}`, index, revision),
            message: {
              id: `row-${index}`,
              role: "system" as const,
              text: "history evidence ".repeat(256),
              createdAt: index,
            },
          })),
        })
      const controller = new TranscriptController("s1", {
        capabilities: async () => transcriptCapabilitiesV1(),
        timeline: async () => {
          const call = ++requests
          if (call === 2) await delayed.promise
          const value = response(call === 1 ? 1 : call === 2 ? 2 : 101)
          bytes += Buffer.byteLength(JSON.stringify(value))
          return value
        },
        turnMessages: jest.fn(),
        subscribeRevision: (_id, listener) => {
          notify = listener
          return () => {}
        },
      })
      controller.start()
      await controller.loadInitial()
      bytes = 0
      notify(2)
      await flushRequests()
      for (let revision = 3; revision <= 101; revision++) notify(revision)
      await flushRequests()
      delayed.resolve()
      await flushRequests()
      if (sample > 0)
        samples.push({ requests: requests - 1, bytes, revision: controller.getSnapshot().revision })
      controller.clear()
    }
    if (process.env.TRANSCRIPT_PERF_OUTPUT) {
      const { writeFileSync } = await import("node:fs")
      writeFileSync(
        process.env.TRANSCRIPT_PERF_OUTPUT,
        JSON.stringify({ warmups: 1, samples }, null, 2)
      )
    }
    expect(samples).toHaveLength(10)
    for (const sample of samples) {
      expect(sample.requests).toBeLessThanOrEqual(2)
      expect(sample.revision).toBe(101)
    }
  })
  it("coalesces 100 in-flight revision notifications and never publishes an older response last", async () => {
    let notify!: (revision: number) => void
    const delayed = deferred<SessionTimelinePage>()
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ items: [systemItem("initial", 1)] }))
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValue(page({ revision: 101, items: [systemItem("latest", 2, 101)] }))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
      subscribeRevision: (_id, listener) => {
        notify = listener
        return () => {}
      },
    })
    controller.start()
    await controller.loadInitial()
    notify(2)
    await flushRequests()
    for (let revision = 3; revision <= 101; revision++) notify(revision)
    await flushRequests()
    const inFlightCalls = timeline.mock.calls.length
    delayed.resolve(page({ revision: 2, items: [systemItem("stale", 2, 2)] }))
    await flushRequests()
    expect(inFlightCalls).toBe(2)
    expect(timeline).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot()).toMatchObject({ revision: 101, loading: false })
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["latest"])
  })

  it("refreshes the loaded window atomically, retaining older history in canonical order", async () => {
    const olderRefresh = deferred<SessionTimelinePage>()
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(
        page({ items: [systemItem("new", 2)], nextCursor: "old-v1", hasMore: true })
      )
      .mockResolvedValueOnce(page({ items: [systemItem("old", 1)] }))
      .mockResolvedValueOnce(
        page({
          revision: 2,
          items: [systemItem("newest", 3, 2)],
          nextCursor: "old-v2",
          hasMore: true,
        })
      )
      .mockImplementationOnce(() => olderRefresh.promise)
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    await controller.loadOlder()
    const refreshing = controller.loadInitial()
    await flushRequests()
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old", "new"])
    olderRefresh.resolve(
      page({ revision: 2, items: [systemItem("old", 1, 2), systemItem("new", 2, 2)] })
    )
    await refreshing
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual([
      "old",
      "new",
      "newest",
    ])
    expect(controller.getSnapshot()).toMatchObject({ revision: 2, loading: false, hasMore: false })
  })

  it("stops reading obsolete older pages as soon as a newer revision is announced", async () => {
    let notify!: (revision: number) => void
    const older = deferred<SessionTimelinePage>()
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ items: [systemItem("old", 0)] }))
      .mockResolvedValueOnce(
        page({
          revision: 2,
          items: [systemItem("new", 3, 2)],
          hasMore: true,
          nextCursor: "middle-v2",
        })
      )
      .mockImplementationOnce(() => older.promise)
      .mockImplementation(async (request: { cursor?: string }) =>
        request.cursor
          ? page({ revision: 2, items: [systemItem("old", 0, 2)] })
          : page({ revision: 3, items: [systemItem("old", 0, 3), systemItem("latest", 4, 3)] })
      )
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
      subscribeRevision: (_id, listener) => {
        notify = listener
        return () => {}
      },
    })
    controller.start()
    await controller.loadInitial()
    notify(2)
    await flushRequests()
    notify(3)
    older.resolve(
      page({
        revision: 2,
        items: [systemItem("middle", 2, 2)],
        hasMore: true,
        nextCursor: "old-v2",
      })
    )
    await flushRequests()
    expect(timeline.mock.calls.map(([request]) => request.cursor)).toEqual([
      undefined,
      undefined,
      "middle-v2",
      undefined,
    ])
    expect(controller.getSnapshot().revision).toBe(3)
  })

  it("ignores requests completed after clear, including after the controller restarts", async () => {
    const old = deferred<SessionTimelinePage>()
    const timeline = jest
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(page({ revision: 2, items: [systemItem("current", 2, 2)] }))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    const initial = controller.loadInitial()
    await flushRequests()
    controller.clear()
    controller.start()
    await controller.loadInitial()
    old.resolve(page({ items: [systemItem("obsolete", 1)] }))
    await initial
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["current"])
    expect(controller.getSnapshot().revision).toBe(2)
  })

  it("finishes every detail page in host order and deduplicates concurrent expansions", async () => {
    const first = deferred<SessionTurnMessagesPage>()
    const message = (id: string) => ({
      id,
      sessionId: "s1",
      role: "assistant" as const,
      parts: [],
      createdAt: 1,
    })
    const turnMessages = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({
        messages: [message("b")],
        revision: 1,
        detailRevision: 1,
        approximateBytes: 20,
        total: 2,
        hasMore: false,
      })
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline: jest.fn(),
      turnMessages,
    })
    const a = controller.expandTurn("turn:u1", 1, 1)
    const b = controller.expandTurn("turn:u1", 1, 1)
    first.resolve({
      messages: [message("a")],
      revision: 1,
      detailRevision: 1,
      approximateBytes: 10,
      total: 2,
      hasMore: true,
      nextCursor: "second",
    })
    await Promise.all([a, b])
    expect(turnMessages).toHaveBeenCalledTimes(2)
    expect(turnMessages).toHaveBeenLastCalledWith({
      sessionId: "s1",
      turnKey: "turn:u1",
      revision: 1,
      detailRevision: 1,
      cursor: "second",
    })
    expect(controller.getDetail("turn:u1")).toMatchObject({
      messages: [message("a"), message("b")],
      approximateBytes: 30,
      hasMore: false,
    })
  })
  it("hands capability absence to the legacy owner without downloading history twice", async () => {
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => null),
      timeline: jest.fn(),
      turnMessages: jest.fn(),
    }
    const controller = new TranscriptController("s1", source)

    await controller.loadInitial()

    expect(controller.getSnapshot().mode).toBe("legacy")
    expect(source.timeline).not.toHaveBeenCalled()
  })

  it("serializes retries, ignores obsolete notifications, and surfaces a failing refresh", async () => {
    let notify!: (revision: number) => void
    const failure = new Error("network unavailable")
    const timeline = jest.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(failure)
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
      subscribeRevision: (_id, listener) => {
        notify = listener
        return () => {}
      },
    })
    const listener = jest.fn()
    const unsubscribe = controller.subscribe(listener)
    controller.start()
    const initial = controller.loadInitial()
    expect(controller.loadInitial()).toBe(initial)
    await initial
    for (const revision of [NaN, Infinity, -1, 1.5, 0, 1]) notify(revision)
    await controller.loadOlder()
    expect(timeline).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    notify(2)
    await flushRequests()
    expect(controller.getSnapshot()).toMatchObject({ revision: 1, error: failure, loading: false })
    expect(listener).not.toHaveBeenCalled()
  })

  it("does not start a history read when cleared before or during capability negotiation", async () => {
    const capability = deferred<ReturnType<typeof transcriptCapabilitiesV1>>()
    const timeline = jest.fn()
    const controller = new TranscriptController("s1", {
      capabilities: () => capability.promise,
      timeline,
      turnMessages: jest.fn(),
    })
    const before = controller.loadInitial()
    controller.clear()
    await before
    const during = controller.loadInitial()
    await flushRequests()
    controller.clear()
    capability.resolve(transcriptCapabilitiesV1())
    await during
    expect(timeline).not.toHaveBeenCalled()
  })

  it.each([false, true])("discards superseded older-page results (reject=%s)", async (reject) => {
    const older = deferred<SessionTimelinePage>()
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(
        page({ items: [systemItem("current", 2)], hasMore: true, nextCursor: "older" })
      )
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValue(page({ revision: 2, items: [systemItem("current", 2, 2)] }))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    const pending = controller.loadOlder()
    await controller.loadOlder()
    const refresh = controller.loadInitial()
    await controller.loadOlder()
    await refresh
    if (reject) older.reject(new Error("late failure"))
    else older.resolve(page({ items: [systemItem("obsolete", 1)] }))
    await pending
    expect(controller.getSnapshot()).toMatchObject({
      revision: 2,
      loadingOlder: false,
      error: null,
    })
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["current"])
  })

  it("recovers a stale pagination cursor without rolling the revision back", async () => {
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(
        page({ items: [systemItem("current", 2)], hasMore: true, nextCursor: "older" })
      )
      .mockResolvedValueOnce(page({ revision: 0 }))
      .mockResolvedValueOnce(page({ revision: 2, items: [systemItem("current", 2, 2)] }))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    await controller.loadOlder()
    expect(controller.getSnapshot()).toMatchObject({
      revision: 2,
      loadingOlder: false,
      error: null,
    })
  })

  it("leaves older history retryable on network errors", async () => {
    const failure = new Error("offline")
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ hasMore: true, nextCursor: "older" }))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(page({ items: [systemItem("old", 1), systemItem("old", 1)] }))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    await controller.loadOlder()
    expect(controller.getSnapshot()).toMatchObject({ error: failure, loadingOlder: false })
    await controller.loadOlder()
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old"])
  })

  it("bounds retries if the host keeps returning an older revision", async () => {
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ revision: 3 }))
      .mockResolvedValue(page())
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    await controller.loadInitial()
    expect(timeline).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot()).toMatchObject({
      revision: 3,
      loading: false,
      error: { code: "TRANSCRIPT_STALE" },
    })
  })

  it.each([undefined, "repeated"])(
    "reports a non-advancing refresh cursor (%s) and retains the readable window",
    async (cursor) => {
      const timeline = jest
        .fn()
        .mockResolvedValueOnce(page({ items: [systemItem("old", 1)] }))
        .mockResolvedValue(
          page({ revision: 2, items: [systemItem("new", 2, 2)], hasMore: true, nextCursor: cursor })
        )
      const controller = new TranscriptController("s1", {
        capabilities: async () => transcriptCapabilitiesV1(),
        timeline,
        turnMessages: jest.fn(),
      })
      await controller.loadInitial()
      await controller.loadInitial()
      expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old"])
      expect(controller.getSnapshot().error).toEqual(
        new Error("transcript timeline cursor did not advance")
      )
    }
  )

  it("retries a revision change between refreshed pages and applies only one coherent window", async () => {
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ items: [systemItem("old", 1)] }))
      .mockResolvedValueOnce(
        page({ revision: 2, items: [systemItem("new", 2, 2)], hasMore: true, nextCursor: "old-v2" })
      )
      .mockResolvedValueOnce(page({ revision: 3, items: [systemItem("old", 1, 3)] }))
      .mockResolvedValueOnce(
        page({ revision: 3, items: [systemItem("old", 1, 3), systemItem("new", 2, 3)] })
      )
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages: jest.fn(),
    })
    await controller.loadInitial()
    await controller.loadInitial()
    expect(controller.getSnapshot()).toMatchObject({ revision: 3, error: null })
    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old", "new"])
  })

  it("uses cached details on re-expansion and stops pinning a collapsed pending detail", async () => {
    const pending = deferred<SessionTurnMessagesPage>()
    const detail = {
      messages: [],
      revision: 1,
      detailRevision: 1,
      approximateBytes: 20,
      total: 0,
      hasMore: false,
    }
    const turnMessages = jest.fn().mockImplementationOnce(() => pending.promise)
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline: jest.fn(),
      turnMessages,
    })
    const expansion = controller.expandTurn("turn:u1", 1, 1)
    controller.collapseTurn("turn:u1")
    pending.resolve(detail)
    await expansion
    expect(controller.getSnapshot().expandedTurnKeys.size).toBe(0)
    await controller.expandTurn("turn:u1", 1, 1)
    expect(turnMessages).toHaveBeenCalledTimes(1)
    expect(controller.getDetail("turn:u1")).toEqual(detail)
  })

  it("refreshes expanded details and rejects detail responses from the old displayed revision", async () => {
    const refreshing = deferred<SessionTimelinePage>()
    const outdated = deferred<SessionTurnMessagesPage>()
    const detail = (revision: number): SessionTurnMessagesPage => ({
      messages: [],
      revision,
      detailRevision: revision,
      approximateBytes: 0,
      total: 0,
      hasMore: false,
    })
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(page({ items: [completedItem(1)] }))
      .mockImplementationOnce(() => refreshing.promise)
    const turnMessages = jest
      .fn()
      .mockImplementationOnce(() => outdated.promise)
      .mockResolvedValue(detail(2))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages,
    })
    await controller.loadInitial()
    const refresh = controller.loadInitial()
    await flushRequests()
    // A user may expand the still-readable old row while the refresh is pending.
    const oldExpansion = controller.expandTurn("turn:u1", 1, 1)
    refreshing.resolve(page({ revision: 2, items: [completedItem(2)] }))
    await refresh
    await flushRequests()
    outdated.resolve(detail(1))
    await oldExpansion
    expect(controller.getSnapshot().expandedTurnKeys.has("turn:u1")).toBe(true)
    expect(controller.getDetail("turn:u1")).toEqual(detail(2))
    expect(turnMessages).toHaveBeenCalledTimes(2)
  })

  it("stops automatic detail reconciliation when the refreshed host still rejects the turn", async () => {
    const first = deferred<SessionTurnMessagesPage>()
    const retried = deferred<SessionTurnMessagesPage>()
    const timeline = jest.fn(async () => page({ items: [completedItem(1)] }))
    const turnMessages = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => retried.promise)
      .mockImplementation(() => new Promise(() => {}))
    const controller = new TranscriptController("s1", {
      capabilities: async () => transcriptCapabilitiesV1(),
      timeline,
      turnMessages,
    })
    await controller.loadInitial()
    const expansion = controller.expandTurn("turn:u1", 1, 1)
    const stale = Object.assign(new Error("stale"), { code: "TRANSCRIPT_STALE" })
    first.reject(stale)
    await expansion
    await flushRequests()
    // Real HTTP errors arrive after the previous refresh promise has settled.
    retried.reject(stale)
    await flushRequests()
    expect(timeline).toHaveBeenCalledTimes(2)
    expect(turnMessages).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().error).toBe(stale)
  })

  it.each([false, true])("discards disposed detail responses (reject=%s)", async (reject) => {
    const pending = deferred<SessionTurnMessagesPage>()
    const controller = new TranscriptController("s1", {
      capabilities: jest.fn(),
      timeline: jest.fn(),
      turnMessages: () => pending.promise,
    })
    const expansion = controller.expandTurn("turn:u1", 1, 1)
    controller.clear()
    if (reject) pending.reject(new Error("late failure"))
    else
      pending.resolve({
        messages: [],
        revision: 1,
        detailRevision: 1,
        approximateBytes: 0,
        total: 0,
        hasMore: false,
      })
    await expansion
    expect(controller.getDetail("turn:u1")).toBeUndefined()
    expect(controller.getSnapshot().error).toBeNull()
  })

  it.each([undefined, "repeated"])(
    "reports a non-advancing detail cursor (%s) instead of displaying truncated history",
    async (cursor) => {
      const controller = new TranscriptController("s1", {
        capabilities: jest.fn(),
        timeline: jest.fn(),
        turnMessages: jest.fn(async () => ({
          messages: [],
          revision: 1,
          detailRevision: 1,
          approximateBytes: 0,
          total: 1,
          hasMore: true,
          nextCursor: cursor,
        })),
      })
      await controller.expandTurn("turn:u1", 1, 1)
      expect(controller.getDetail("turn:u1")).toBeUndefined()
      expect(controller.getSnapshot().error).toEqual(
        new Error("transcript detail cursor did not advance")
      )
    }
  )

  it("loads the newest page and prepends older pages without replacing current items", async () => {
    const timeline = jest
      .fn()
      .mockResolvedValueOnce(
        page({
          items: [
            {
              kind: "system",
              itemKey: "new",
              revision: 1,
              status: "completed",
              message: { id: "new", role: "system", text: "new", createdAt: 2 },
              startedAt: 2,
            },
          ],
          nextCursor: "older",
          hasMore: true,
        })
      )
      .mockResolvedValueOnce(
        page({
          items: [
            {
              kind: "system",
              itemKey: "old",
              revision: 1,
              status: "completed",
              message: { id: "old", role: "system", text: "old", createdAt: 1 },
              startedAt: 1,
            },
          ],
        })
      )
    const controller = new TranscriptController("s1", {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline,
      turnMessages: jest.fn(),
    })

    await controller.loadInitial()
    await controller.loadOlder()

    expect(controller.getSnapshot().items.map((item) => item.itemKey)).toEqual(["old", "new"])
    expect(timeline).toHaveBeenLastCalledWith({
      sessionId: "s1",
      direction: "backward",
      cursor: "older",
    })
  })

  it("keeps expanded state while an evicted detail is fetched again", async () => {
    const details: SessionTurnMessagesPage = {
      messages: [],
      revision: 1,
      detailRevision: 1,
      total: 0,
      approximateBytes: 10,
      hasMore: false,
    }
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => page()),
      turnMessages: jest.fn(async () => details),
    }
    const controller = new TranscriptController("s1", source, {
      softBytes: 1,
      hardBytes: 1,
    })

    await controller.expandTurn("turn:u1", 1, 1)
    expect(controller.getSnapshot().expandedTurnKeys.has("turn:u1")).toBe(true)
    expect(controller.getDetail("turn:u1")).toBeUndefined()

    await controller.expandTurn("turn:u1", 1, 1)
    expect(source.turnMessages).toHaveBeenCalledTimes(2)
  })

  it("subscribes to revisions only once start() runs, and drops it on clear", () => {
    const unsubscribe = jest.fn()
    const subscribeRevision = jest.fn(() => unsubscribe)
    const controller = new TranscriptController("s1", {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => page()),
      turnMessages: jest.fn(),
      subscribeRevision,
    })

    expect(subscribeRevision).not.toHaveBeenCalled()

    controller.start()
    controller.start()
    expect(subscribeRevision).toHaveBeenCalledTimes(1)

    controller.clear()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("clears only the current session cache and reloads newest on a stale detail", async () => {
    const source: PublicTranscriptSource = {
      capabilities: jest.fn(async () => transcriptCapabilitiesV1()),
      timeline: jest.fn(async () => page({ revision: 2 })),
      turnMessages: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "TRANSCRIPT_STALE" })),
    }
    const controller = new TranscriptController("s1", source)

    await expect(controller.expandTurn("turn:u1", 1, 1)).resolves.toBeUndefined()

    expect(source.timeline).toHaveBeenCalledWith({ sessionId: "s1", direction: "backward" })
    expect(controller.getSnapshot()).toMatchObject({ revision: 2, error: null })
  })
})
