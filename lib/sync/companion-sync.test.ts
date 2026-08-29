/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

/** Lets a test move the client onto a different host mid-run. */
let companionConfig: { deviceId: string; targetId?: string; accountId?: string } | null = null
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => companionConfig,
}))

import type { Transport } from "@/lib/tauri/transport-types"

import { getDb, whenSeeded } from "@/lib/db/schema"

import {
  COMPANION_SYNC_DOMAINS,
  __resetSyncStateForTests,
  SYNC_HANDLER_TABLES,
  installEventDrivenSync,
  EVENT_SYNC_COALESCE_MS,
  installForegroundSync,
  installNetworkSync,
  installResumeSync,
  installWorkflowRunStatusSync,
  getSyncStateFor,
  runSyncDown,
  runStagedSyncDown,
  snapshotSyncStates,
  SYNC_STAGES,
  SYNC_TABLE_STAGES,
  syncTablesForStage,
} from "./companion-sync"
import { SYNCABLE_TABLE_NAMES, type SyncOutcome, type SyncableTable } from "./types"

function makeOkOutcome(table: SyncableTable, applied = 1, nextSince = 1): SyncOutcome {
  return { ok: true, result: { table, applied, nextSince } }
}
function makeFailOutcome(
  table: SyncableTable,
  reason: "transport" | "not_implemented"
): SyncOutcome {
  return { ok: false, failure: { table, reason, message: `mock-${reason}` } }
}

function makeTransport(): Transport {
  return {
    call: jest.fn(),
    subscribe: jest.fn(() => () => {}),
  }
}

beforeEach(() => {
  __resetSyncStateForTests()
  // Unpaired unless the case says otherwise. Without this, a case that moves
  // the client onto another host leaks that host into the next one, which now
  // decides whether the cold-start mirror wipe fires.
  companionConfig = null
})

describe("sync stages", () => {
  it("assigns every governed table to exactly one stage", () => {
    const staged = SYNC_STAGES.flatMap((stage) => [...syncTablesForStage(stage)])
    expect(new Set(staged)).toEqual(new Set(SYNCABLE_TABLE_NAMES))
    expect(staged).toHaveLength(SYNCABLE_TABLE_NAMES.length)
  })

  it("keeps the first screen's tables in `critical` and the heavy ones out of it", () => {
    // The stage list is a product decision, so it is pinned rather than
    // derived: what a client must have before it may call itself online.
    expect(syncTablesForStage("critical")).toEqual([
      "settings",
      "characters",
      "sessions",
      "conversationOverrides",
    ])
    // `messages` and `memories` are the two largest applies in the pipeline —
    // the transcript tail and the row-by-row DEK decrypt. Neither may gate
    // first paint.
    expect(SYNC_TABLE_STAGES.messages).toBe("interactive")
    expect(SYNC_TABLE_STAGES.memories).toBe("background")
  })

  it("pulls characters before sessions so no chat row paints without its identity", () => {
    const critical = syncTablesForStage("critical")
    expect(critical.indexOf("characters")).toBeLessThan(critical.indexOf("sessions"))
  })

  it("runs only the requested stage's handlers", async () => {
    const characters = jest.fn(async () => makeOkOutcome("characters"))
    const messages = jest.fn(async () => makeOkOutcome("messages"))

    const outcomes = await runSyncDown({
      transport: makeTransport(),
      stages: ["critical"],
      handlers: [
        { table: "characters", stage: "critical", run: characters },
        { table: "messages", stage: "interactive", run: messages },
      ],
    })

    expect(characters).toHaveBeenCalledTimes(1)
    expect(messages).not.toHaveBeenCalled()
    expect(outcomes).toHaveLength(1)
  })

  it("treats an injected handler with no stage as critical", async () => {
    const characters = jest.fn(async () => makeOkOutcome("characters"))

    await runSyncDown({
      transport: makeTransport(),
      stages: ["critical"],
      handlers: [{ table: "characters", run: characters }],
    })

    expect(characters).toHaveBeenCalledTimes(1)
  })
})

describe("runStagedSyncDown", () => {
  it("resolves `critical` before the later stages have run", async () => {
    const order: string[] = []
    const handler = (table: SyncableTable, stage: "critical" | "interactive" | "background") => ({
      table,
      stage,
      run: jest.fn(async () => {
        order.push(table)
        return makeOkOutcome(table)
      }),
    })
    const handlers = [
      handler("sessions", "critical"),
      handler("messages", "interactive"),
      handler("memories", "background"),
    ]

    const staged = runStagedSyncDown({ transport: makeTransport(), handlers })
    await staged.critical

    // The whole point: the boot path is released with only `critical` done.
    expect(order).toEqual(["sessions"])

    await staged.whenComplete
    expect(order).toEqual(["sessions", "messages", "memories"])
  })

  it("reuses an in-flight staged run instead of stacking a second drain", () => {
    const transport = makeTransport()
    const handlers = [
      {
        table: "sessions" as const,
        stage: "critical" as const,
        run: jest.fn(async () => makeOkOutcome("sessions")),
      },
    ]
    const first = runStagedSyncDown({ transport, handlers })
    const second = runStagedSyncDown({ transport, handlers })
    expect(second).toBe(first)
  })

  it("surfaces a broken pipeline on `critical` while still draining later stages", async () => {
    const messages = jest.fn(async () => makeOkOutcome("messages"))
    const staged = runStagedSyncDown({
      transport: makeTransport(),
      handlers: [
        {
          table: "sessions",
          stage: "critical",
          run: jest.fn(async () => {
            throw new Error("transport exploded")
          }),
        },
        { table: "messages", stage: "interactive", run: messages },
      ],
    })

    // The boot path reconnects off this rejection — resolving would flip the
    // client to "online" over a sync that never ran.
    await expect(staged.critical).rejects.toThrow("transport exploded")
    // `whenComplete` is nobody's await, so it must not reject; the stages that
    // can still run, do.
    await expect(staged.whenComplete).resolves.toEqual([makeOkOutcome("messages")])
    expect(messages).toHaveBeenCalledTimes(1)
  })
})

describe("SYNC_HANDLER_TABLES registry", () => {
  it("has exactly one handler for every governed sync table", () => {
    expect(new Set(SYNC_HANDLER_TABLES)).toEqual(new Set(SYNCABLE_TABLE_NAMES))
    expect(SYNC_HANDLER_TABLES).toHaveLength(SYNCABLE_TABLE_NAMES.length)
  })

  it("has one closed authority/direction/deletion descriptor per handler", () => {
    expect(new Set(Object.keys(COMPANION_SYNC_DOMAINS))).toEqual(new Set(SYNC_HANDLER_TABLES))
    for (const descriptor of Object.values(COMPANION_SYNC_DOMAINS)) {
      expect(descriptor.authority).toBe("host")
      expect(descriptor.direction).toBe("host-to-client")
      expect(descriptor.allowedWrites).toEqual(["host"])
      expect(["tombstone", "append-only", "ttl"]).toContain(descriptor.deletionPolicy)
    }
  })
})

describe("runSyncDown", () => {
  it("accepts an empty handler set with the production transport default", async () => {
    await expect(runSyncDown({ handlers: [] })).resolves.toEqual([])
  })

  it("runs every handler and aggregates outcomes", async () => {
    const transport = makeTransport()
    const handlers = [
      {
        table: "characters" as const,
        run: jest.fn().mockResolvedValue(makeOkOutcome("characters", 3, 10)),
      },
      { table: "skills" as const, run: jest.fn().mockResolvedValue(makeOkOutcome("skills", 2, 5)) },
    ]

    const outcomes = await runSyncDown({ transport, handlers })

    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((o) => o.ok)).toBe(true)
    for (const h of handlers) {
      expect(h.run).toHaveBeenCalledTimes(1)
    }
  })

  it("advances the per-table cursor on success", async () => {
    const transport = makeTransport()
    const handler = jest.fn()
    handler.mockResolvedValueOnce(makeOkOutcome("characters", 1, 100))
    handler.mockResolvedValueOnce(makeOkOutcome("characters", 1, 200))

    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport, handlers })
    await runSyncDown({ transport, handlers })

    // Second invocation should pass `since: 100` to the handler.
    expect(handler.mock.calls[1][1]).toEqual({ since: 100 })
    expect(snapshotSyncStates().characters.since).toBe(200)
    expect(getSyncStateFor("characters")).toMatchObject({ since: 200, lastError: null })
  })

  it("captures lastError on a failing handler without breaking the others", async () => {
    const transport = makeTransport()
    const handlers = [
      {
        table: "characters" as const,
        run: jest.fn().mockResolvedValue(makeFailOutcome("characters", "transport")),
      },
      {
        table: "skills" as const,
        run: jest.fn().mockResolvedValue(makeOkOutcome("skills", 1, 1)),
      },
    ]

    const outcomes = await runSyncDown({ transport, handlers })

    expect(outcomes[0].ok).toBe(false)
    expect(outcomes[1].ok).toBe(true)
    const states = snapshotSyncStates()
    expect(states.characters.lastError).toContain("mock-transport")
    expect(states.skills.lastError).toBeNull()
  })

  it("does not advance the cursor on a failing handler", async () => {
    const transport = makeTransport()
    const handler = jest.fn().mockResolvedValue(makeFailOutcome("characters", "transport"))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport, handlers })

    expect(snapshotSyncStates().characters.since).toBe(0)
  })

  it("never regresses the per-table cursor when a stale outcome lands late", async () => {
    // ADR-0027 monotonic-cursor invariant: a targeted `opts.only` run and a
    // full background pull share the same `stateMap[table]`. If the targeted
    // run's outcome arrives AFTER the full run already advanced the cursor
    // past it, the late writer must not regress `state.since`.
    const transport = makeTransport()
    const handler = jest.fn()
    // First run advances cursor to 500.
    handler.mockResolvedValueOnce(makeOkOutcome("characters", 1, 500))
    // A subsequent stale outcome with nextSince=200 must be ignored.
    handler.mockResolvedValueOnce(makeOkOutcome("characters", 1, 200))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport, handlers })
    expect(snapshotSyncStates().characters.since).toBe(500)

    await runSyncDown({ transport, handlers, only: ["characters"] })
    // Cursor must stay at 500 — stale outcome ignored by the monotonic guard.
    expect(snapshotSyncStates().characters.since).toBe(500)
  })

  it("dedupes concurrent calls — second call reuses the inflight promise", async () => {
    const transport = makeTransport()
    let resolveHandler: (value: SyncOutcome) => void = () => {}
    const handler = jest.fn().mockImplementation(
      () =>
        new Promise<SyncOutcome>((resolve) => {
          resolveHandler = resolve
        })
    )
    const handlers = [{ table: "characters" as const, run: handler }]

    const p1 = runSyncDown({ transport, handlers })
    const p2 = runSyncDown({ transport, handlers })
    expect(p1).toBe(p2)

    // Wave 4 / ADR-0026 — `ensureHydrated()` awaits a Dexie open. Drain
    // enough macrotasks for the IDB transaction to settle so the for loop
    // actually invokes the handler (which captures the real `resolveHandler`).
    await new Promise((r) => setTimeout(r, 50))

    resolveHandler(makeOkOutcome("characters", 1, 1))
    await p1

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("installForegroundSync", () => {
  it("returns a teardown that detaches the listener", () => {
    const transport = makeTransport()
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    const removeListenerSpy = jest.spyOn(document, "removeEventListener")
    const teardown = installForegroundSync({ transport, handlers })
    teardown()

    expect(removeListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
    removeListenerSpy.mockRestore()
  })

  it("triggers a sync when document becomes visible", async () => {
    const transport = makeTransport()
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    const teardown = installForegroundSync({ transport, handlers })

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))

    // Drain microtasks so runSyncDown's body executes. `runSyncDown`
    // chains `ensureHydrated → loadCursors → await getDb().toArray()`
    // before invoking handlers, which spans several Promise hops — one
    // macrotask is not always enough, especially on slower runners.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(handler).toHaveBeenCalledTimes(1)
    teardown()
  })

  it("ignores hidden visibility changes", async () => {
    const transport = makeTransport()
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    const teardown = installForegroundSync({ transport, handlers })

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await new Promise((r) => setTimeout(r, 0))
    expect(handler).not.toHaveBeenCalled()
    teardown()
  })
})

describe("cursor persistence (Wave 4 / ADR-0026)", () => {
  it("hydrates `since` from the Dexie syncCursors table on first runSyncDown", async () => {
    await whenSeeded()
    await getDb().hostSyncCursors.put({
      // Unpaired in tests, so the orchestrator's host key is the empty string.
      serverKey: "",
      table: "characters",
      since: 777,
      lastSyncAt: 1_700_000_000_000,
      lastError: null,
    })

    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 1, 999))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport: makeTransport(), handlers })

    expect(handler.mock.calls[0][1]).toEqual({ since: 777 })
    expect(snapshotSyncStates().characters.since).toBe(999)
  })

  it("persists the advanced cursor back into Dexie after a successful run", async () => {
    await whenSeeded()
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 1, 555))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport: makeTransport(), handlers })
    // Fire-and-forget writes settle on the next microtask.
    await new Promise((r) => setTimeout(r, 5))

    const persisted = await getDb().hostSyncCursors.get(["", "characters"])
    expect(persisted?.since).toBe(555)
    expect(persisted?.lastError).toBeNull()
  })

  it("persists lastError to Dexie on a failing handler", async () => {
    await whenSeeded()
    const handler = jest.fn().mockResolvedValue(makeFailOutcome("characters", "transport"))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    const persisted = await getDb().hostSyncCursors.get(["", "characters"])
    expect(persisted?.lastError).toContain("mock-transport")
    expect(persisted?.since).toBe(0)
  })
})

describe("installNetworkSync", () => {
  it("triggers runSyncDown on network connected=true", async () => {
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    // Set up navigator.onLine + fire the `online` event so the web fallback
    // path inside `lib/capacitor/network.subscribe` triggers connected=true.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })

    const teardown = await installNetworkSync({ transport: makeTransport(), handlers })

    window.dispatchEvent(new Event("online"))
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).toHaveBeenCalled()
    teardown()
  })

  it("does not trigger when network reports disconnected", async () => {
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })

    const teardown = await installNetworkSync({ transport: makeTransport(), handlers })

    window.dispatchEvent(new Event("offline"))
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).not.toHaveBeenCalled()
    teardown()

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })
})

describe("installResumeSync", () => {
  it("triggers runSyncDown on visibilitychange to visible (fallback path)", async () => {
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const handlers = [{ table: "characters" as const, run: handler }]

    const teardown = await installResumeSync({ transport: makeTransport(), handlers })

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    // Drain multiple macrotasks: runSyncDown chains ensureHydrated +
    // loadCursors + handler invocations, more than a single 10ms wait
    // covers reliably on slower CI runners.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(handler).toHaveBeenCalled()
    teardown()
  })
})

describe("installEventDrivenSync", () => {
  it("runs only the invalidated table handler when the event names one", async () => {
    const characters = jest.fn().mockResolvedValue(makeOkOutcome("characters"))
    const messages = jest.fn().mockResolvedValue(makeOkOutcome("messages"))
    let subscriber: ((payload: { table?: "characters" | "messages" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }

    const teardown = installEventDrivenSync({
      transport,
      handlers: [
        { table: "characters", run: characters },
        { table: "messages", run: messages },
      ],
    })
    subscriber?.({ table: "messages" })
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 100))

    expect(messages).toHaveBeenCalledTimes(1)
    expect(characters).not.toHaveBeenCalled()
    teardown()
  })

  it("coalesces a burst of same-table invalidations into one pull per window (ADR-0131)", async () => {
    const outbound = jest.fn().mockResolvedValue(makeOkOutcome("outboundQueue"))
    const drafts = jest.fn().mockResolvedValue(makeOkOutcome("connectorDrafts"))
    let subscriber: ((payload: { table?: "outboundQueue" | "connectorDrafts" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }
    const teardown = installEventDrivenSync({
      transport,
      handlers: [
        { table: "outboundQueue", run: outbound },
        { table: "connectorDrafts", run: drafts },
      ],
    })
    for (let i = 0; i < 6; i++) subscriber?.({ table: "outboundQueue" })
    subscriber?.({ table: "connectorDrafts" })
    subscriber?.({ table: "connectorDrafts" })
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 150))

    expect(outbound).toHaveBeenCalledTimes(1)
    expect(drafts).toHaveBeenCalledTimes(1)
    teardown()
  })

  it("an untabled invalidation collapses pending keyed windows into one full run", async () => {
    const outbound = jest.fn().mockResolvedValue(makeOkOutcome("outboundQueue"))
    const drafts = jest.fn().mockResolvedValue(makeOkOutcome("connectorDrafts"))
    let subscriber: ((payload: { table?: "outboundQueue" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }
    const teardown = installEventDrivenSync({
      transport,
      handlers: [
        { table: "outboundQueue", run: outbound },
        { table: "connectorDrafts", run: drafts },
      ],
    })
    subscriber?.({ table: "outboundQueue" })
    subscriber?.({})
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 150))

    // Exactly one full run — the keyed window did not fire separately.
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(drafts).toHaveBeenCalledTimes(1)
    teardown()
  })

  it("does not arm a keyed window while a full invalidation is already pending", async () => {
    const outbound = jest.fn().mockResolvedValue(makeOkOutcome("outboundQueue"))
    let subscriber: ((payload: { table?: "outboundQueue" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }
    const teardown = installEventDrivenSync({
      transport,
      handlers: [{ table: "outboundQueue", run: outbound }],
    })

    subscriber?.({})
    subscriber?.({ table: "outboundQueue" })
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 150))

    expect(outbound).toHaveBeenCalledTimes(1)
    teardown()
  })

  it("teardown cancels a pending window so no pull fires after unsubscribe", async () => {
    const outbound = jest.fn().mockResolvedValue(makeOkOutcome("outboundQueue"))
    let subscriber: ((payload: { table?: "outboundQueue" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }
    const teardown = installEventDrivenSync({
      transport,
      handlers: [{ table: "outboundQueue", run: outbound }],
    })
    subscriber?.({ table: "outboundQueue" })
    teardown()
    subscriber?.({ table: "outboundQueue" })
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 100))
    expect(outbound).not.toHaveBeenCalled()
  })

  it("ignores invalidations for tables outside an `only` scope", async () => {
    const outbound = jest.fn().mockResolvedValue(makeOkOutcome("outboundQueue"))
    let subscriber: ((payload: { table?: "connectorDrafts" }) => void) | undefined
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as typeof subscriber
        return jest.fn()
      }),
    }
    const teardown = installEventDrivenSync({
      transport,
      only: ["outboundQueue"],
      handlers: [{ table: "outboundQueue", run: outbound }],
    })
    subscriber?.({ table: "connectorDrafts" })
    await new Promise((resolve) => setTimeout(resolve, EVENT_SYNC_COALESCE_MS + 100))
    expect(outbound).not.toHaveBeenCalled()
    teardown()
  })

  it("subscribes once and triggers a sync per inbound event", async () => {
    const handlers = [
      {
        table: "characters" as const,
        run: jest.fn().mockResolvedValue(makeOkOutcome("characters")),
      },
    ]
    const subscribers: Array<(payload: unknown) => void> = []
    const unsub = jest.fn()
    const transport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscribers.push(handler as (p: unknown) => void)
        return unsub
      }),
    }

    const teardown = installEventDrivenSync({ transport, handlers })

    expect(transport.subscribe).toHaveBeenCalledWith("sync://invalidate", expect.any(Function))

    subscribers[0]?.({})
    // Wave 4 — ensureHydrated awaits Dexie; give the IDB open a moment (plus
    // the ADR-0131 coalescing window).
    await new Promise((r) => setTimeout(r, EVENT_SYNC_COALESCE_MS + 100))

    expect(handlers[0].run).toHaveBeenCalled()

    teardown()
    expect(unsub).toHaveBeenCalled()
  })
})

describe("installWorkflowRunStatusSync", () => {
  it("applies live status to an existing mirror and never regresses a terminal run", async () => {
    await getDb().workflowRuns.clear()
    await getDb().workflowRuns.put({
      id: "run-live",
      workflowId: "workflow-1",
      status: "pending",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 1,
      workflowSnapshot: {
        id: "workflow-1",
        name: "Live",
        nodes: [],
        edges: [],
        settings: { concurrency: 1 },
        createdAt: 1,
        updatedAt: 1,
      },
    } as never)
    let subscriber: ((frame: unknown) => void) | undefined
    const unsubscribe = jest.fn()
    const liveTransport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as (frame: unknown) => void
        return unsubscribe
      }),
    }
    const teardown = installWorkflowRunStatusSync({ transport: liveTransport })

    subscriber?.({
      runId: "run-live",
      workflowId: "workflow-1",
      status: "running",
      lastStepId: "step-1",
    })
    for (let index = 0; index < 20; index += 1) {
      if ((await getDb().workflowRuns.get("run-live"))?.status === "running") break
      await Promise.resolve()
    }
    await expect(getDb().workflowRuns.get("run-live")).resolves.toMatchObject({
      status: "running",
      lastCompletedStepId: "step-1",
    })

    await getDb().workflowRuns.update("run-live", { status: "succeeded" })
    subscriber?.({ runId: "run-live", workflowId: "workflow-1", status: "running" })
    await Promise.resolve()
    await expect(getDb().workflowRuns.get("run-live")).resolves.toMatchObject({
      status: "succeeded",
    })

    teardown()
    expect(liveTransport.subscribe).toHaveBeenCalledWith(
      "workflow://run-status",
      expect.any(Function)
    )
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("pulls the workflow run mirror when a live frame arrives before its row", async () => {
    await getDb().workflowRuns.clear()
    const workflowRuns = jest.fn().mockResolvedValue(makeOkOutcome("workflowRuns"))
    let subscriber: ((frame: unknown) => void) | undefined
    const liveTransport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as (frame: unknown) => void
        return jest.fn()
      }),
    }
    installWorkflowRunStatusSync({
      transport: liveTransport,
      handlers: [{ table: "workflowRuns", run: workflowRuns }],
    })

    subscriber?.({ runId: "run-new", workflowId: "workflow-1", status: "pending" })
    for (let index = 0; index < 20 && workflowRuns.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(workflowRuns).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed frames and falls back to a pull when local persistence fails", async () => {
    const workflowRuns = jest.fn().mockResolvedValue(makeOkOutcome("workflowRuns"))
    let subscriber: ((frame: unknown) => void) | undefined
    const liveTransport: Transport = {
      call: jest.fn(),
      subscribe: jest.fn((_channel, handler) => {
        subscriber = handler as (frame: unknown) => void
        return jest.fn()
      }),
    }
    const getSpy = jest.spyOn(getDb().workflowRuns, "get").mockRejectedValueOnce(new Error("disk"))
    const teardown = installWorkflowRunStatusSync({
      transport: liveTransport,
      handlers: [{ table: "workflowRuns", run: workflowRuns }],
    })

    for (const frame of [
      null,
      {},
      { runId: "", workflowId: "workflow-1", status: "running" },
      { runId: "run-1", workflowId: "", status: "running" },
      { runId: "run-1", workflowId: "workflow-1", status: "unknown" },
    ]) {
      subscriber?.(frame)
    }
    expect(getSpy).not.toHaveBeenCalled()

    subscriber?.({ runId: "run-1", workflowId: "workflow-1", status: "running" })
    for (let index = 0; index < 20 && workflowRuns.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(workflowRuns).toHaveBeenCalledTimes(1)

    teardown()
    subscriber?.({ runId: "run-2", workflowId: "workflow-1", status: "running" })
    await Promise.resolve()
    expect(getSpy).toHaveBeenCalledTimes(1)
    getSpy.mockRestore()
  })
})

describe("host isolation (v130)", () => {
  it("does not resume from a cursor recorded against a different host", async () => {
    // The corruption this closes: re-pairing elsewhere used to resume from the
    // previous host's watermark and ask the new one for "everything since <a
    // timestamp that means nothing here>", blending two machines' data.
    await whenSeeded()
    await getDb().hostSyncCursors.put({
      serverKey: "other-host",
      table: "characters",
      since: 777,
      lastSyncAt: 1,
      lastError: null,
    })

    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 1, 5))
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })

    expect(handler.mock.calls[0][1]).toEqual({ since: 0 })
  })

  it("keeps each host's watermark separately", async () => {
    await whenSeeded()
    await getDb().hostSyncCursors.bulkPut([
      { serverKey: "", table: "characters", since: 11, lastSyncAt: 1, lastError: null },
      { serverKey: "other-host", table: "characters", since: 99, lastSyncAt: 1, lastError: null },
    ])

    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 1, 12))
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })

    expect(handler.mock.calls[0][1]).toEqual({ since: 11 })
    // The other host's row is untouched — switching back must not re-pull.
    expect((await getDb().hostSyncCursors.get(["other-host", "characters"]))?.since).toBe(99)
  })

  it("drops the mirrored rows when the host changes under it", async () => {
    // Partitioning the cursors alone is not enough: the ROWS pulled from the
    // previous host stay in the same tables, so two machines' sessions would
    // simply pile up together. These tables are a cache of a host's state, not
    // the client's own data, so clearing and re-pulling loses nothing.
    await whenSeeded()
    const db = getDb()
    // A row that could only have come from the host we are leaving. Asserting
    // on this specific row rather than a count keeps the test honest about
    // seeded built-ins.
    await db.characters.put({ id: "from-host-a", name: "A" } as never)

    // First run hydrates against the current host key.
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 0, 1))
    const handlers = [{ table: "characters" as const, run: handler }]
    await runSyncDown({ transport: makeTransport(), handlers })
    expect(await db.characters.get("from-host-a")).toBeDefined()

    // Now the client is talking to a different host.
    companionConfig = { deviceId: "device-on-host-b" }
    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    expect(await db.characters.get("from-host-a")).toBeUndefined()
  })

  it("keeps device-local settings when the host changes", async () => {
    // `settings` is the one mirrored table the client also writes locally.
    // Clearing it would throw away preferences the host never had.
    await whenSeeded()
    const db = getDb()
    await db.settings.put({ id: "singleton", apiKey: "device-local" } as never)

    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 0, 1))
    const handlers = [{ table: "characters" as const, run: handler }]
    await runSyncDown({ transport: makeTransport(), handlers })

    companionConfig = { deviceId: "device-on-host-b" }
    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    expect((await db.settings.get("singleton"))?.apiKey).toBe("device-local")
  })

  it("drops rows left by a host it stopped talking to while it was not running", async () => {
    // The in-process check only fires when THIS process already talked to
    // another host. Re-pairing is a restart, and on iOS the app is routinely
    // killed between the `CompanionConfig` write and the next sync tick — so
    // without a durable record, host A's rows sat in the tables while host B's
    // cursors started from zero, which is the blend v130 exists to prevent.
    await whenSeeded()
    const db = getDb()
    // Let the beforeEach `clearCursors()` land before seeding the state the
    // restart would have left behind.
    await new Promise((r) => setTimeout(r, 5))
    await db.characters.put({ id: "from-host-a", name: "A" } as never)
    await db.hostSyncCursors.put({
      serverKey: "device-on-host-a",
      table: "characters",
      since: 500,
      lastSyncAt: 1,
      lastError: null,
    })

    // Cold start: nothing in memory records host A — only the cursor row does.
    companionConfig = { deviceId: "device-on-host-b" }
    const handler = jest.fn().mockResolvedValue(makeOkOutcome("characters", 0, 1))
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(await db.characters.get("from-host-a")).toBeUndefined()
    expect(await db.hostSyncCursors.get(["device-on-host-a", "characters"])).toBeUndefined()
    // ...and host B is asked for everything, not "since host A's watermark".
    expect(handler.mock.calls[0][1]).toEqual({ since: 0 })
  })

  it("leaves the mirror alone while the companion config is still hydrating", async () => {
    // `loadCompanionConfig` reads a cache that stays empty until
    // `hydrateCompanionConfig` resolves at boot. Reading that as "a different
    // host" would destroy the mirror of the host we are still paired to.
    await whenSeeded()
    const db = getDb()
    await new Promise((r) => setTimeout(r, 5))
    await db.characters.put({ id: "from-host-a", name: "A" } as never)
    await db.hostSyncCursors.put({
      serverKey: "device-on-host-a",
      table: "characters",
      since: 500,
      lastSyncAt: 1,
      lastError: null,
    })

    await runSyncDown({
      transport: makeTransport(),
      handlers: [
        {
          table: "characters" as const,
          run: jest.fn().mockResolvedValue(makeOkOutcome("characters", 0, 1)),
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(await db.characters.get("from-host-a")).toBeDefined()
    expect(await db.hostSyncCursors.get(["device-on-host-a", "characters"])).toBeDefined()
  })
})

describe("cursor namespace keying (ADR-0097 D13)", () => {
  const handlerFor = (nextSince: number) =>
    jest.fn().mockResolvedValue(makeOkOutcome("characters", 0, nextSince))

  async function seedCursor(serverKey: string, since: number): Promise<void> {
    await whenSeeded()
    // Let the beforeEach `clearCursors()` land before seeding the state a
    // restart would have left behind.
    await new Promise((r) => setTimeout(r, 5))
    await getDb().hostSyncCursors.put({
      serverKey,
      table: "characters",
      since,
      lastSyncAt: 1,
      lastError: null,
    })
  }

  it("files cursors under {accountNamespace}:{hostId}, not the bare device id", async () => {
    await whenSeeded()
    companionConfig = { deviceId: "dev-1", targetId: "host-a", accountId: "acct_a" }

    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handlerFor(7) }],
    })
    await new Promise((r) => setTimeout(r, 5))

    // The pair {hostId, accountNamespace} is what the mirror belongs to, so it
    // is what the watermark has to be filed under: the same desktop reached
    // from a second local account must not advance this account's cursor.
    expect((await getDb().hostSyncCursors.get(["acct_a:host-a", "characters"]))?.since).toBe(7)
    expect(await getDb().hostSyncCursors.get(["dev-1", "characters"])).toBeUndefined()
  })

  it("keeps the watermark when the same host issues a new device id on re-pair", async () => {
    // `deviceId` is minted per pairing, so keying on it made re-pairing to the
    // SAME desktop read as a different host: a full re-pull of every table plus
    // a mirror wipe, for a machine whose state had not changed at all.
    await seedCursor("__local__:host-a", 500)
    const db = getDb()
    await db.characters.put({ id: "from-this-host", name: "A" } as never)

    companionConfig = { deviceId: "dev-2-after-repair", targetId: "host-a" }
    const handler = handlerFor(501)
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(handler.mock.calls[0][1]).toEqual({ since: 500 })
    expect(await db.characters.get("from-this-host")).toBeDefined()
  })

  it("adopts cursors an earlier build wrote under this host's bare device id", async () => {
    // The upgrade path. Without adoption the install's own rows sit under a key
    // this build no longer recognises, get classified as another host's, and
    // the mirror of the host we are still paired to is wiped on first launch.
    await seedCursor("dev-1", 500)
    const db = getDb()
    await db.characters.put({ id: "from-this-host", name: "A" } as never)

    companionConfig = { deviceId: "dev-1" }
    const handler = handlerFor(501)
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(handler.mock.calls[0][1]).toEqual({ since: 500 })
    expect(await db.characters.get("from-this-host")).toBeDefined()
    // …and the legacy row is gone, so the next run does not see it as foreign.
    expect(await db.hostSyncCursors.get(["dev-1", "characters"])).toBeUndefined()
    expect((await db.hostSyncCursors.get(["__local__:dev-1", "characters"]))?.since).toBe(501)
  })

  it("prefers the namespaced cursor over a stale legacy one for the same host", async () => {
    await seedCursor("__local__:dev-1", 10)
    await getDb().hostSyncCursors.put({
      serverKey: "dev-1",
      table: "characters",
      since: 500,
      lastSyncAt: 1,
      lastError: null,
    })

    companionConfig = { deviceId: "dev-1" }
    const handler = handlerFor(11)
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })
    await new Promise((r) => setTimeout(r, 5))

    // The namespaced row was written by this build against the key we resume
    // from; the legacy row is a stale duplicate, not a newer watermark.
    expect(handler.mock.calls[0][1]).toEqual({ since: 10 })
    expect(await getDb().hostSyncCursors.get(["dev-1", "characters"])).toBeUndefined()
  })

  it("adopts nothing when the pairing carries no device id", async () => {
    await seedCursor("", 500)
    companionConfig = { deviceId: "", targetId: "host-a" }

    const handler = handlerFor(1)
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handler }],
    })
    await new Promise((r) => setTimeout(r, 5))

    // `""` is the unpaired key, not this host's former key — adopting it would
    // hand every unpaired client's watermark to the first host it pairs with.
    expect(handler.mock.calls[0][1]).toEqual({ since: 0 })
  })

  it("keeps both hosts' mirrors when each host has its own database", async () => {
    // ADR-0061 L3 — switching hosts activates that host's runtime-target
    // database (`activateAccountDatabase(accountId, targetId)`) instead of
    // clearing the other host's state. The wipe is driven by what THIS database
    // holds, so once the mirrors are in separate Dexie files the scan finds
    // nothing foreign and neither host loses its cache.
    await whenSeeded()
    const db = getDb()
    companionConfig = { deviceId: "dev-a", targetId: "host-a" }
    const handlers = [{ table: "characters" as const, run: handlerFor(1) }]
    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    // The switch activated host B's own database: a different file, holding B's
    // mirror and no cursor for A. `fake-indexeddb` gives the suite a single
    // database, so that state is presented directly.
    await db.hostSyncCursors.clear()
    await db.characters.put({ id: "from-host-b", name: "B" } as never)
    companionConfig = { deviceId: "dev-b", targetId: "host-b" }
    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    expect(await db.characters.get("from-host-b")).toBeDefined()
  })

  it("still wipes when the two hosts share one database", async () => {
    // The other side of the same rule: an install with no runtime target keeps
    // both hosts' rows in one file, so a foreign cursor is a real blend.
    await seedCursor("__local__:host-a", 500)
    const db = getDb()
    await db.characters.put({ id: "from-host-a", name: "A" } as never)

    companionConfig = { deviceId: "dev-b", targetId: "host-b" }
    await runSyncDown({
      transport: makeTransport(),
      handlers: [{ table: "characters" as const, run: handlerFor(1) }],
    })
    await new Promise((r) => setTimeout(r, 5))

    expect(await db.characters.get("from-host-a")).toBeUndefined()
    expect(await db.hostSyncCursors.get(["__local__:host-a", "characters"])).toBeUndefined()
  })
})
