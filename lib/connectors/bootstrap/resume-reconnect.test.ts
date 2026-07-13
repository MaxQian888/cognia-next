import { startResumeReconnect, DEFAULT_MIN_AWAY_MS } from "./resume-reconnect"

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
    t.advance(1_000) // < 30s
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
})
