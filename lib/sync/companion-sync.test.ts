/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import { getDb, whenSeeded } from "@/lib/db/schema"

import {
  __resetSyncStateForTests,
  SYNC_HANDLER_TABLES,
  installEventDrivenSync,
  installForegroundSync,
  installNetworkSync,
  installResumeSync,
  runSyncDown,
  snapshotSyncStates,
} from "./companion-sync"
import type { SyncOutcome, SyncableTable } from "./types"

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
})

describe("SYNC_HANDLER_TABLES registry", () => {
  it("registers the terminalHistory handler (change point c)", () => {
    // Guards against a TS-only sync addition that never wires its handler into
    // DEFAULT_HANDLERS — the orchestrator would then silently skip the table.
    expect(SYNC_HANDLER_TABLES).toContain("terminalHistory")
  })
})

describe("runSyncDown", () => {
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
    await getDb().syncCursors.put({
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

    const persisted = await getDb().syncCursors.get("characters")
    expect(persisted?.since).toBe(555)
    expect(persisted?.lastError).toBeNull()
  })

  it("persists lastError to Dexie on a failing handler", async () => {
    await whenSeeded()
    const handler = jest.fn().mockResolvedValue(makeFailOutcome("characters", "transport"))
    const handlers = [{ table: "characters" as const, run: handler }]

    await runSyncDown({ transport: makeTransport(), handlers })
    await new Promise((r) => setTimeout(r, 5))

    const persisted = await getDb().syncCursors.get("characters")
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
    // Wave 4 — ensureHydrated awaits Dexie; give the IDB open a moment.
    await new Promise((r) => setTimeout(r, 50))

    expect(handlers[0].run).toHaveBeenCalled()

    teardown()
    expect(unsub).toHaveBeenCalled()
  })
})
