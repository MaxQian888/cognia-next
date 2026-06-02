import { cascadeReadState } from "./read-state"
import type { NotificationRecord } from "@/types/notifications"

const r = (over: Partial<NotificationRecord> = {}) =>
  ({ readState: "unseen", ...over }) as Pick<NotificationRecord, "readState" | "firstSeenAt">

describe("cascadeReadState", () => {
  it("unseen → seen stamps firstSeenAt + lastSeenAt", () => {
    const p = cascadeReadState(r(), "seen", 100)
    expect(p).toEqual({ readState: "seen", firstSeenAt: 100, lastSeenAt: 100 })
  })

  it("unseen → read stamps seen + read", () => {
    const p = cascadeReadState(r(), "read", 100)
    expect(p.readState).toBe("read")
    expect(p.firstSeenAt).toBe(100)
    expect(p.lastReadAt).toBe(100)
    expect(p.doneAt).toBeUndefined()
  })

  it("unseen → done stamps seen + read + done", () => {
    const p = cascadeReadState(r(), "done", 100)
    expect(p.readState).toBe("done")
    expect(p.lastSeenAt).toBe(100)
    expect(p.lastReadAt).toBe(100)
    expect(p.doneAt).toBe(100)
  })

  it("does not overwrite an existing firstSeenAt", () => {
    const p = cascadeReadState(r({ readState: "seen", firstSeenAt: 5 }), "read", 100)
    expect(p.firstSeenAt).toBeUndefined() // not in patch
    expect(p.lastSeenAt).toBe(100)
  })

  it("never downgrades (read → seen is a no-op)", () => {
    expect(cascadeReadState(r({ readState: "read" }), "seen", 100)).toEqual({})
  })

  it("is a no-op when already at target", () => {
    expect(cascadeReadState(r({ readState: "done" }), "done", 100)).toEqual({})
  })

  it("read → done still applies", () => {
    const p = cascadeReadState(r({ readState: "read", firstSeenAt: 5 }), "done", 100)
    expect(p.readState).toBe("done")
    expect(p.doneAt).toBe(100)
  })
})
