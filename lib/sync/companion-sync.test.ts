/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"

import {
  __resetSyncStateForTests,
  installEventDrivenSync,
  installForegroundSync,
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

    // Drain microtasks so runSyncDown's body executes.
    await new Promise((r) => setTimeout(r, 0))
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
    await new Promise((r) => setTimeout(r, 0))

    expect(handlers[0].run).toHaveBeenCalled()

    teardown()
    expect(unsub).toHaveBeenCalled()
  })
})
