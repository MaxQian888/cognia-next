import {
  startResumeReconnect,
  DEFAULT_MIN_AWAY_MS,
  DEFAULT_ACTIVITY_FRESH_MS,
} from "./resume-reconnect"
import type { AdapterHealth } from "@/types/connectors/adapter"
import { appendAudit } from "@/lib/connectors/audit"

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn(() => Promise.resolve()),
}))

/** Minimal EventTarget stand-in that lets a test fire named events. */
class FakeTarget {
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(cb)
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb)
  }
  fire(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb()
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0
  }
}

function setup(overrides: Partial<Parameters<typeof startResumeReconnect>[0]> = {}) {
  const win = new FakeTarget()
  const doc = new FakeTarget()
  let clock = 1_000_000
  const requeue = jest.fn(async () => true)
  const audit = jest.fn()
  const state = { hidden: false, offline: false }
  const handle = startResumeReconnect({
    windowTarget: win,
    documentTarget: doc,
    now: () => clock,
    isHidden: () => state.hidden,
    isOffline: () => state.offline,
    listAdapters: () => [{ adapter: { id: "a1" } }, { adapter: { id: "a2" } }],
    requeue,
    audit,
    ...overrides,
  })
  return {
    win,
    doc,
    requeue,
    audit,
    state,
    handle,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("startResumeReconnect", () => {
  it("requeues every adapter after a long hidden period ends", async () => {
    const t = setup()
    t.state.hidden = true
    t.doc.fire("visibilitychange") // went away
    t.advance(DEFAULT_MIN_AWAY_MS + 1)
    t.state.hidden = false
    t.doc.fire("visibilitychange") // came back
    await Promise.resolve()
    expect(t.requeue).toHaveBeenCalledTimes(2)
    expect(t.requeue).toHaveBeenCalledWith("a1")
    expect(t.requeue).toHaveBeenCalledWith("a2")
    expect(t.audit).toHaveBeenCalledWith("a1", "visible", DEFAULT_MIN_AWAY_MS + 1)
  })

  it("ignores a brief tab switch below the away threshold", () => {
    const t = setup()
    t.state.hidden = true
    t.doc.fire("visibilitychange")
    t.advance(1_000) // « the multi-minute away threshold
    t.state.hidden = false
    t.doc.fire("visibilitychange")
    expect(t.requeue).not.toHaveBeenCalled()
  })

  it("reconnects on `online` after a long offline gap", async () => {
    const t = setup()
    t.state.offline = true
    t.win.fire("offline")
    t.advance(DEFAULT_MIN_AWAY_MS + 5)
    t.state.offline = false
    t.win.fire("online")
    await Promise.resolve()
    expect(t.requeue).toHaveBeenCalledTimes(2)
    expect(t.audit).toHaveBeenCalledWith("a1", "online", DEFAULT_MIN_AWAY_MS + 5)
  })

  it("collapses a near-simultaneous online+visible pair into one burst", async () => {
    const t = setup()
    t.state.offline = true
    t.state.hidden = true
    t.win.fire("offline")
    t.advance(DEFAULT_MIN_AWAY_MS + 10)
    // Real wake: network back, then tab visible a moment later.
    t.state.offline = false
    t.win.fire("online")
    t.state.hidden = false
    t.doc.fire("visibilitychange")
    await Promise.resolve()
    // Only the first (online) burst requeues; the visible one is inside cooldown.
    expect(t.requeue).toHaveBeenCalledTimes(2)
  })

  it("does not reconnect while still offline even if visibility flips", () => {
    const t = setup()
    t.state.hidden = true
    t.state.offline = true
    t.doc.fire("visibilitychange")
    t.advance(DEFAULT_MIN_AWAY_MS + 1)
    t.state.hidden = false // visible again, but network still down
    t.doc.fire("visibilitychange")
    expect(t.requeue).not.toHaveBeenCalled()
  })

  // Health-gated requeue: a wake only tears down transports that may have gone
  // half-open. One still delivering traffic is left alone (no message-loss
  // reconnect window on a self-healing socket like the Lark long-conn).
  function setupWithHealth(health: () => AdapterHealth) {
    const win = new FakeTarget()
    const doc = new FakeTarget()
    let clock = 1_000_000
    const state = { hidden: false, offline: false }
    const requeue = jest.fn(async () => true)
    const audit = jest.fn()
    const handle = startResumeReconnect({
      windowTarget: win,
      documentTarget: doc,
      now: () => clock,
      isHidden: () => state.hidden,
      isOffline: () => state.offline,
      listAdapters: () => [{ adapter: { id: "a1", health } }],
      requeue,
      audit,
    })
    const wake = () => {
      state.hidden = true
      doc.fire("visibilitychange")
      clock += DEFAULT_MIN_AWAY_MS + 1
      state.hidden = false
      doc.fire("visibilitychange")
    }
    return { requeue, audit, handle, wake, now: () => clock }
  }

  it("skips a running adapter that delivered traffic within the fresh window", async () => {
    let t: ReturnType<typeof setupWithHealth>
    // eslint-disable-next-line prefer-const
    t = setupWithHealth(() => ({
      state: "running",
      lastActivityAt: t.now() - (DEFAULT_ACTIVITY_FRESH_MS - 5_000),
    }))
    t.wake()
    await Promise.resolve()
    expect(t.requeue).not.toHaveBeenCalled()
    expect(t.audit).not.toHaveBeenCalled()
    t.handle.dispose()
  })

  it("requeues a running adapter whose last activity is stale", async () => {
    let t: ReturnType<typeof setupWithHealth>
    // eslint-disable-next-line prefer-const
    t = setupWithHealth(() => ({
      state: "running",
      lastActivityAt: t.now() - (DEFAULT_ACTIVITY_FRESH_MS + 5_000),
    }))
    t.wake()
    await Promise.resolve()
    expect(t.requeue).toHaveBeenCalledWith("a1")
    t.handle.dispose()
  })

  it("requeues a non-running adapter even with fresh activity", async () => {
    let t: ReturnType<typeof setupWithHealth>
    // eslint-disable-next-line prefer-const
    t = setupWithHealth(() => ({
      state: "degraded",
      lastActivityAt: t.now() - 1_000,
    }))
    t.wake()
    await Promise.resolve()
    expect(t.requeue).toHaveBeenCalledWith("a1")
    t.handle.dispose()
  })

  it("requeues a running adapter that has never recorded activity", async () => {
    // `running` but no `lastActivityAt` — cannot prove the socket is alive, so
    // it is treated as maybe-half-open and requeued.
    const t = setupWithHealth(() => ({ state: "running" }))
    t.wake()
    await Promise.resolve()
    expect(t.requeue).toHaveBeenCalledWith("a1")
    t.handle.dispose()
  })

  it("requeues when the adapter exposes no health() (unknown → maybe dead)", async () => {
    const win = new FakeTarget()
    const doc = new FakeTarget()
    let clock = 1_000_000
    const state = { hidden: false, offline: false }
    const requeue = jest.fn(async () => true)
    const handle = startResumeReconnect({
      windowTarget: win,
      documentTarget: doc,
      now: () => clock,
      isHidden: () => state.hidden,
      isOffline: () => state.offline,
      listAdapters: () => [{ adapter: { id: "a1" } }],
      requeue,
      audit: jest.fn(),
    })
    state.hidden = true
    doc.fire("visibilitychange")
    clock += DEFAULT_MIN_AWAY_MS + 1
    state.hidden = false
    doc.fire("visibilitychange")
    await Promise.resolve()
    expect(requeue).toHaveBeenCalledWith("a1")
    handle.dispose()
  })

  it("audits a real requeue via the default appendAudit sink", async () => {
    ;(appendAudit as jest.Mock).mockClear()
    const win = new FakeTarget()
    const doc = new FakeTarget()
    let clock = 1_000_000
    const state = { hidden: false, offline: false }
    // No `audit` seam → exercises the default appendAudit-backed sink.
    const handle = startResumeReconnect({
      windowTarget: win,
      documentTarget: doc,
      now: () => clock,
      isHidden: () => state.hidden,
      isOffline: () => state.offline,
      listAdapters: () => [{ adapter: { id: "a1" } }],
      requeue: jest.fn(async () => true),
    })
    state.hidden = true
    doc.fire("visibilitychange")
    clock += DEFAULT_MIN_AWAY_MS + 1
    state.hidden = false
    doc.fire("visibilitychange")
    await Promise.resolve()
    await Promise.resolve()
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        kind: "adapter.resumed",
        fields: { reason: "visible", awayMs: DEFAULT_MIN_AWAY_MS + 1 },
      })
    )
    handle.dispose()
  })

  it("dispose() detaches every listener and is idempotent", () => {
    const t = setup()
    expect(t.win.count("online")).toBe(1)
    expect(t.doc.count("visibilitychange")).toBe(1)
    t.handle.dispose()
    t.handle.dispose()
    expect(t.win.count("online")).toBe(0)
    expect(t.win.count("offline")).toBe(0)
    expect(t.doc.count("visibilitychange")).toBe(0)
  })

  it("no-ops without any DOM target", () => {
    const handle = startResumeReconnect({ windowTarget: undefined, documentTarget: undefined })
    expect(() => handle.dispose()).not.toThrow()
  })

  it("no-ops when the Node window shim has no event-listener method", () => {
    expect(typeof globalThis.addEventListener).toBe("undefined")
    const handle = startResumeReconnect({
      windowTarget: globalThis as never,
      documentTarget: undefined,
    })
    expect(() => handle.dispose()).not.toThrow()
  })
})
