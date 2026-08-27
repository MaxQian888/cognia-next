import {
  clearSidecarLogTrail,
  lastSidecarError,
  readSidecarLogTrail,
  recordSidecarLog,
  SIDECAR_CAUSE_MAX_AGE_MS,
  SIDECAR_LOG_ENTRY_MAX_CHARS,
  SIDECAR_LOG_TRAIL_CAPACITY,
} from "./sidecar-log-trail"

beforeEach(() => clearSidecarLogTrail())

it("keeps error-level lines and drops the noise", () => {
  expect(recordSidecarLog({ level: "info", message: "starting" }, 1)).toBeNull()
  expect(recordSidecarLog({ level: "debug", message: "tick" }, 2)).toBeNull()
  expect(recordSidecarLog({ level: "warn", message: "slow" }, 3)).not.toBeNull()
  expect(recordSidecarLog({ level: "error", message: "boom" }, 4)).not.toBeNull()
  expect(recordSidecarLog({ level: "fatal", message: "dead" }, 5)).not.toBeNull()
  expect(readSidecarLogTrail().map((e) => e.message)).toEqual(["slow", "boom", "dead"])
})

it("ignores frames with nothing to say", () => {
  expect(recordSidecarLog({ level: "error", message: "   " }, 1)).toBeNull()
  expect(recordSidecarLog({ level: "error", message: 42 }, 2)).toBeNull()
  expect(recordSidecarLog({ level: "error" }, 3)).toBeNull()
  expect(recordSidecarLog({ message: "no level" }, 4)).toBeNull()
  expect(readSidecarLogTrail()).toEqual([])
})

it("is bounded — a crash loop cannot grow it without limit", () => {
  for (let i = 0; i < SIDECAR_LOG_TRAIL_CAPACITY * 5; i += 1) {
    recordSidecarLog({ level: "error", message: `line ${i}` }, i)
  }
  const trail = readSidecarLogTrail()
  expect(trail).toHaveLength(SIDECAR_LOG_TRAIL_CAPACITY)
  // The tail is what survives: the newest lines are the ones that explain the
  // exit that is about to follow.
  expect(trail[trail.length - 1]!.message).toBe(`line ${SIDECAR_LOG_TRAIL_CAPACITY * 5 - 1}`)
})

it("truncates a long entry rather than storing a whole stack trace", () => {
  recordSidecarLog({ level: "error", message: "x".repeat(5_000) }, 1)
  const [entry] = readSidecarLogTrail()
  expect(entry!.message).toHaveLength(SIDECAR_LOG_ENTRY_MAX_CHARS)
  expect(entry!.message.endsWith("…")).toBe(true)
})

it("redacts before it truncates, so a cut cannot smuggle half a secret through", () => {
  const secret = "contact ops@example.com about it"
  recordSidecarLog({ level: "error", message: `${secret} ${"y".repeat(5_000)}` }, 1)
  const [entry] = readSidecarLogTrail()
  expect(entry!.message).not.toContain("ops@example.com")
})

it("prefers the session's own line but falls back to the supervisor's", () => {
  recordSidecarLog({ level: "error", message: "session line", sessionId: "s1" }, 1)
  recordSidecarLog({ level: "error", message: "supervisor line" }, 2)
  expect(lastSidecarError("s1", 3)?.message).toBe("session line")
  // The frame that explains a crash is often emitted after the session context
  // is gone, so an unscoped tail is better than nothing.
  expect(lastSidecarError("s2", 3)?.message).toBe("supervisor line")
  expect(lastSidecarError(undefined, 3)?.message).toBe("supervisor line")
})

it("offers nothing once the newest line is too old to have caused anything", () => {
  // The trail is capacity-bounded, not time-bounded, so without an age check a
  // warning from minute 1 of a long session was still the newest entry an hour
  // later and got attached to an unrelated exit as its explanation.
  recordSidecarLog({ level: "error", message: "session line", sessionId: "s1" }, 1_000)
  const stale = 1_000 + SIDECAR_CAUSE_MAX_AGE_MS + 1
  expect(lastSidecarError("s1", stale)).toBeUndefined()
  expect(lastSidecarError(undefined, stale)).toBeUndefined()
  // Still inside the window it is offered, so the bound is the only difference.
  expect(lastSidecarError("s1", 1_000 + SIDECAR_CAUSE_MAX_AGE_MS)?.message).toBe("session line")
})

it("returns nothing when the sidecar has said nothing", () => {
  expect(lastSidecarError()).toBeUndefined()
  expect(lastSidecarError("s1")).toBeUndefined()
})

it("hands out a copy, so a caller cannot mutate the trail", () => {
  recordSidecarLog({ level: "error", message: "a" }, 1)
  const first = readSidecarLogTrail() as unknown as unknown[]
  first.push({ at: 2, message: "injected" })
  expect(readSidecarLogTrail()).toHaveLength(1)
})
