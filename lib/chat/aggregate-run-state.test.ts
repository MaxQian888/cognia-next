import { aggregateRunState, backgroundActiveSessionIds } from "./aggregate-run-state"

const sessions = (map: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map).map(([id, status]) => [
      id,
      { status: status as "idle" | "streaming" | "awaiting_approval" | "error" },
    ])
  )

describe("aggregateRunState", () => {
  it("reports idle when nothing is happening", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "idle", b: "idle" }),
      activeSessionId: "a",
    })
    expect(out.status).toBe("idle")
    expect(out.active).toBe(0)
    expect(out.activeElsewhere).toBe(false)
  })

  it("does not call the app idle because the focused conversation is", () => {
    // The whole point: two background turns in flight, focus on a quiet one.
    const out = aggregateRunState({
      sessions: sessions({ a: "idle", b: "streaming", c: "streaming" }),
      activeSessionId: "a",
    })
    expect(out.status).toBe("streaming")
    expect(out.streaming).toBe(2)
    expect(out.focused).toBe("idle")
    expect(out.activeElsewhere).toBe(true)
  })

  it("puts a blocked approval above a running turn", () => {
    // Awaiting approval is the only state that needs the user.
    const out = aggregateRunState({
      sessions: sessions({ a: "streaming", b: "awaiting_approval" }),
      activeSessionId: "a",
    })
    expect(out.status).toBe("awaiting_approval")
  })

  it("does not let an old failure mask a live turn", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "error", b: "streaming" }),
      activeSessionId: "a",
    })
    expect(out.status).toBe("streaming")
    expect(out.error).toBe(1)
  })

  it("keeps an off-screen failure visible through the status word", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "idle", b: "error" }),
      activeSessionId: "a",
    })
    expect(out.status).toBe("error")
    expect(out.error).toBe(1)
  })

  it("does not call a background failure activity elsewhere", () => {
    // `activeElsewhere` drives a spinning "N running in the background" chip
    // that offers to take you to something happening. A turn that already
    // failed is not happening, and the spinner never stopped.
    const out = aggregateRunState({
      sessions: sessions({ a: "idle", b: "error" }),
      activeSessionId: "a",
    })
    expect(out.activeElsewhere).toBe(false)
    expect(out.active).toBe(0)
  })

  it("counts only work in flight as active", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "streaming", b: "awaiting_approval", c: "error", d: "idle" }),
      activeSessionId: "a",
    })
    // Streaming + awaiting approval. The errored session is reported through
    // `error` and `status`, not through the "N running" count.
    expect(out.active).toBe(2)
    expect(out.error).toBe(1)
  })

  it("does not report activity elsewhere when only the focused session is busy", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "streaming", b: "idle" }),
      activeSessionId: "a",
    })
    expect(out.activeElsewhere).toBe(false)
    expect(out.status).toBe("streaming")
  })

  it("reports the focused session's own state alongside the aggregate", () => {
    const out = aggregateRunState({
      sessions: sessions({ a: "awaiting_approval", b: "streaming" }),
      activeSessionId: "a",
    })
    expect(out.focused).toBe("awaiting_approval")
    expect(out.status).toBe("awaiting_approval")
  })

  it("treats every busy session as elsewhere when nothing is focused", () => {
    const out = aggregateRunState({ sessions: sessions({ a: "streaming" }), activeSessionId: null })
    expect(out.focused).toBe("idle")
    expect(out.activeElsewhere).toBe(true)
  })

  it("treats a slice with no status as idle", () => {
    const out = aggregateRunState({ sessions: { a: {}, b: undefined }, activeSessionId: "a" })
    expect(out.status).toBe("idle")
    expect(out.active).toBe(0)
  })

  it("handles an empty store", () => {
    const out = aggregateRunState({ sessions: {} })
    expect(out).toMatchObject({
      status: "idle",
      active: 0,
      activeElsewhere: false,
      focused: "idle",
    })
  })
})

describe("backgroundActiveSessionIds", () => {
  it("lists busy sessions other than the focused one", () => {
    expect(
      backgroundActiveSessionIds({
        sessions: sessions({ a: "streaming", b: "streaming", c: "idle" }),
        activeSessionId: "a",
      })
    ).toEqual(["b"])
  })

  it("is ordered so the list does not reshuffle between renders", () => {
    expect(
      backgroundActiveSessionIds({
        sessions: sessions({ z: "streaming", a: "streaming", m: "awaiting_approval" }),
        activeSessionId: null,
      })
    ).toEqual(["a", "m", "z"])
  })

  it("leaves out a session that already failed", () => {
    // Same predicate as `activeElsewhere`, so the chip's count and the list it
    // opens can never disagree.
    expect(
      backgroundActiveSessionIds({
        sessions: sessions({ a: "error", b: "streaming" }),
        activeSessionId: null,
      })
    ).toEqual(["b"])
  })

  it("is empty when only the focused session is busy", () => {
    expect(
      backgroundActiveSessionIds({ sessions: sessions({ a: "streaming" }), activeSessionId: "a" })
    ).toEqual([])
  })
})
