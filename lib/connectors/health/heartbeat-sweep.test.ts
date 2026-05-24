/**
 * Coverage for the consolidated heartbeat sweep (v51):
 *   - one interval services every running adapter per tick
 *   - the passive probe fires every PASSIVE_EVERY_N ticks, passive adapters only
 *   - a hung passive probe never blocks other adapters' active heartbeats
 *   - dispose stops the interval and is idempotent
 */

import { startHeartbeatSweep, PASSIVE_EVERY_N } from "./heartbeat-sweep"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function fakeAdapter(id: string, type = "telegram"): PlatformAdapter {
  return { id, meta: { type } } as unknown as PlatformAdapter
}

function fakeRow(id: string, type: string, transport?: string): AdapterInstanceRow {
  return {
    id,
    type,
    settings: transport ? { transport } : {},
  } as unknown as AdapterInstanceRow
}

function makeScheduler() {
  let captured: (() => void) | null = null
  const scheduler = {
    setInterval: jest.fn((cb: () => void) => {
      captured = cb
      return 1 as unknown
    }),
    clearInterval: jest.fn(),
  }
  return { scheduler, tick: () => captured?.() }
}

/** Let the immediate tick's async work (loadRows + allSettled) drain. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("startHeartbeatSweep", () => {
  it("uses one interval and heartbeats every running adapter per tick", async () => {
    const recordHeartbeat = jest.fn().mockResolvedValue(undefined)
    const { scheduler } = makeScheduler()
    const handle = startHeartbeatSweep({
      listAdapters: () => [{ adapter: fakeAdapter("a") }, { adapter: fakeAdapter("b") }],
      recordHeartbeat,
      recordPassive: jest.fn().mockResolvedValue(undefined),
      loadRows: async () => [],
      scheduler,
      now: () => 1000,
    })
    await flush()

    expect(scheduler.setInterval).toHaveBeenCalledTimes(1)
    expect(recordHeartbeat).toHaveBeenCalledTimes(2)
    expect(recordHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), 1000)
    expect(recordHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), 1000)

    handle.dispose()
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1)
  })

  it(`fires the passive probe every ${PASSIVE_EVERY_N} ticks for passive adapters only`, async () => {
    const recordPassive = jest.fn().mockResolvedValue(undefined)
    const { scheduler, tick } = makeScheduler()
    startHeartbeatSweep({
      listAdapters: () => [
        { adapter: fakeAdapter("lark", "lark") },
        { adapter: fakeAdapter("tg", "telegram") },
      ],
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
      recordPassive,
      loadRows: async () => [
        fakeRow("lark", "lark", "webhook"), // passive transport
        fakeRow("tg", "telegram"), // active transport
      ],
      scheduler,
    })

    // idx 0 → passive fires (0 % N === 0), only for the passive adapter.
    await flush()
    expect(recordPassive).toHaveBeenCalledTimes(1)
    expect(recordPassive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lark" }),
      expect.any(Number)
    )

    // idx 1 → no passive.
    recordPassive.mockClear()
    tick()
    await flush()
    expect(recordPassive).not.toHaveBeenCalled()

    // idx 2 → passive again.
    tick()
    await flush()
    expect(recordPassive).toHaveBeenCalledTimes(1)
  })

  it("does not let a hung passive probe block other adapters' active heartbeats", async () => {
    const recordHeartbeat = jest.fn().mockResolvedValue(undefined)
    // Passive probe never resolves.
    const recordPassive = jest.fn(() => new Promise<void>(() => {}))
    const { scheduler } = makeScheduler()
    startHeartbeatSweep({
      listAdapters: () => [
        { adapter: fakeAdapter("lark", "lark") },
        { adapter: fakeAdapter("tg", "telegram") },
      ],
      recordHeartbeat,
      recordPassive,
      loadRows: async () => [fakeRow("lark", "lark", "webhook"), fakeRow("tg", "telegram")],
      scheduler,
    })
    await flush()

    // Active heartbeats for both adapters fired despite the hung passive probe.
    expect(recordHeartbeat).toHaveBeenCalledTimes(2)
    expect(recordPassive).toHaveBeenCalledTimes(1)
  })

  it("still heartbeats actively when the passive row load fails", async () => {
    const recordHeartbeat = jest.fn().mockResolvedValue(undefined)
    const recordPassive = jest.fn().mockResolvedValue(undefined)
    startHeartbeatSweep({
      listAdapters: () => [{ adapter: fakeAdapter("lark", "lark") }],
      recordHeartbeat,
      recordPassive,
      loadRows: async () => {
        throw new Error("dexie down")
      },
      scheduler: makeScheduler().scheduler,
    })
    await flush()
    // Active heartbeat fired; passive gating fell back to "no rows" → no probe.
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)
    expect(recordPassive).not.toHaveBeenCalled()
  })

  it("does no work when no adapters are running", async () => {
    const recordHeartbeat = jest.fn()
    const recordPassive = jest.fn()
    startHeartbeatSweep({
      listAdapters: () => [],
      recordHeartbeat,
      recordPassive,
      loadRows: async () => [],
      scheduler: makeScheduler().scheduler,
    })
    await flush()
    expect(recordHeartbeat).not.toHaveBeenCalled()
    expect(recordPassive).not.toHaveBeenCalled()
  })

  it("skips an overlapping tick until the in-flight sweep settles", async () => {
    // Ref holder (not a bare `let`) so TS doesn't narrow the closure-assigned
    // resolver back to `null` at the call site below.
    const resolveRef: { fn: (() => void) | null } = { fn: null }
    const recordHeartbeat = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRef.fn = () => resolve()
        })
    )
    const { scheduler, tick } = makeScheduler()
    startHeartbeatSweep({
      listAdapters: () => [{ adapter: fakeAdapter("a") }],
      recordHeartbeat,
      recordPassive: jest.fn().mockResolvedValue(undefined),
      loadRows: async () => [],
      scheduler,
    })
    await flush()
    // The immediate tick started one sweep; its heartbeat is still in flight.
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    // A scheduler fire while that sweep is unfinished must be skipped, not
    // stacked on top of it.
    tick()
    await flush()
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    // Once the in-flight sweep settles, the next tick runs normally.
    resolveRef.fn?.()
    await flush()
    tick()
    await flush()
    expect(recordHeartbeat).toHaveBeenCalledTimes(2)
  })

  it("dispose stops further ticks and is idempotent", async () => {
    const recordHeartbeat = jest.fn().mockResolvedValue(undefined)
    const { scheduler, tick } = makeScheduler()
    const handle = startHeartbeatSweep({
      listAdapters: () => [{ adapter: fakeAdapter("a") }],
      recordHeartbeat,
      recordPassive: jest.fn().mockResolvedValue(undefined),
      loadRows: async () => [],
      scheduler,
    })
    await flush()
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    handle.dispose()
    handle.dispose()
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1)

    // A post-dispose scheduler callback is a no-op.
    recordHeartbeat.mockClear()
    tick()
    await flush()
    expect(recordHeartbeat).not.toHaveBeenCalled()
  })
})
