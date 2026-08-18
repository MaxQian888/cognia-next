/**
 * @jest-environment jsdom
 */
import {
  INVALIDATE_COALESCE_MS,
  SYNC_INVALIDATE_TOPIC,
  __resetHostInvalidateForTests,
  __setHostInvalidateDepsForTests,
  flushPendingSyncInvalidates,
  publishSyncInvalidate,
  type SyncInvalidatePayload,
} from "./host-invalidate"

let published: Array<{ topic: string; payload: SyncInvalidatePayload }> = []
let restore: () => void = () => undefined

function install(over: { remoteActive?: boolean; publish?: jest.Mock } = {}): void {
  restore = __setHostInvalidateDepsForTests({
    publish:
      over.publish ??
      ((topic: string, payload: SyncInvalidatePayload) => {
        published.push({ topic, payload })
      }),
    // Resolve the global at CALL time. The module captures `setTimeout` at
    // import time, which is the real one — `jest.useFakeTimers()` swaps the
    // global afterwards and would never drive the captured reference.
    setTimeoutFn: ((fn: () => void, ms?: number) =>
      setTimeout(fn, ms)) as unknown as typeof setTimeout,
    isRemoteHostActiveFn: () => over.remoteActive ?? false,
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  published = []
  __resetHostInvalidateForTests()
  install()
})

afterEach(() => {
  __resetHostInvalidateForTests()
  restore()
  jest.useRealTimers()
})

describe("publishSyncInvalidate", () => {
  it("publishes one frame per table after the coalesce window", () => {
    publishSyncInvalidate("messages", "telegram:tg:1")
    expect(published).toHaveLength(0)

    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    expect(published).toEqual([
      { topic: SYNC_INVALIDATE_TOPIC, payload: { table: "messages", conversationKey: "telegram:tg:1" } },
    ])
  })

  it("coalesces a burst on one conversation into a single keyed frame", () => {
    // An ai-run reply touches the outbound row three times; a client only
    // needs to be told once.
    for (let i = 0; i < 20; i++) publishSyncInvalidate("outboundQueue", "telegram:tg:1")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)

    expect(published).toHaveLength(1)
    expect(published[0].payload).toEqual({
      table: "outboundQueue",
      conversationKey: "telegram:tg:1",
    })
  })

  it("drops the key when a window mixes conversations", () => {
    // A mixed burst would need N keyed pulls; one table-wide pull is cheaper
    // and strictly more correct.
    publishSyncInvalidate("messages", "telegram:tg:1")
    publishSyncInvalidate("messages", "slack:sl:C1")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)

    expect(published).toHaveLength(1)
    expect(published[0].payload).toEqual({ table: "messages" })
  })

  it("drops the key when any write in the window was table-wide", () => {
    publishSyncInvalidate("messages", "telegram:tg:1")
    publishSyncInvalidate("messages")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    expect(published[0].payload).toEqual({ table: "messages" })
  })

  it("keeps separate windows per table", () => {
    publishSyncInvalidate("messages", "telegram:tg:1")
    publishSyncInvalidate("connectorDrafts", "telegram:tg:1")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)

    expect(published.map((p) => p.payload.table).sort()).toEqual(["connectorDrafts", "messages"])
  })

  it("opens a fresh window after a flush", () => {
    publishSyncInvalidate("messages")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    publishSyncInvalidate("messages")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    expect(published).toHaveLength(2)
  })

  it("stays silent while THIS desktop is itself a thin client", () => {
    // Its Dexie rows are mirrors of the remote host's, not authoritative;
    // telling its own paired phones to re-pull them from here would hand
    // back stale data.
    restore()
    install({ remoteActive: true })
    publishSyncInvalidate("messages", "telegram:tg:1")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    expect(published).toHaveLength(0)
  })

  it("treats a throwing routing check as a local host", () => {
    restore()
    restore = __setHostInvalidateDepsForTests({
      publish: (topic, payload) => {
        published.push({ topic, payload })
      },
      setTimeoutFn: ((fn: () => void, ms?: number) =>
        setTimeout(fn, ms)) as unknown as typeof setTimeout,
      isRemoteHostActiveFn: () => {
        throw new Error("SSR — routing module unavailable")
      },
    })
    publishSyncInvalidate("messages")
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)
    expect(published).toHaveLength(1)
  })

  it("never lets a publisher failure reach the Dexie writer", () => {
    const publish = jest.fn(() => {
      throw new Error("emit failed")
    })
    restore()
    install({ publish })
    publishSyncInvalidate("messages")
    expect(() => jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)).not.toThrow()
    expect(publish).toHaveBeenCalled()
  })

  it("swallows a rejected async publisher", () => {
    const publish = jest.fn(() => Promise.reject(new Error("bridge down")))
    restore()
    install({ publish })
    publishSyncInvalidate("messages")
    expect(() => jest.advanceTimersByTime(INVALIDATE_COALESCE_MS)).not.toThrow()
  })
})

describe("flushPendingSyncInvalidates", () => {
  it("publishes every open window immediately", () => {
    publishSyncInvalidate("messages", "telegram:tg:1")
    publishSyncInvalidate("outboundQueue")
    flushPendingSyncInvalidates()

    expect(published.map((p) => p.payload.table).sort()).toEqual(["messages", "outboundQueue"])
    // The cancelled timers must not fire a second frame.
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS * 2)
    expect(published).toHaveLength(2)
  })

  it("is a no-op with nothing pending", () => {
    flushPendingSyncInvalidates()
    expect(published).toHaveLength(0)
  })
})

describe("__resetHostInvalidateForTests", () => {
  it("drops pending windows without publishing", () => {
    publishSyncInvalidate("messages")
    __resetHostInvalidateForTests()
    jest.advanceTimersByTime(INVALIDATE_COALESCE_MS * 2)
    expect(published).toHaveLength(0)
  })
})
