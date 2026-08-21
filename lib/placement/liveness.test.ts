import {
  DEFAULT_LIVENESS_TTL_MS,
  isPlaceable,
  livenessAgeMs,
  type PlacementLiveness,
} from "./liveness"

const now = 1_000_000

function liveness(overrides: Partial<PlacementLiveness> = {}): PlacementLiveness {
  return { online: true, lastSeenAt: now, source: "request", ...overrides }
}

describe("isPlaceable", () => {
  it("trusts an open socket without consulting the clock", () => {
    // The socket is the one signal that proves presence rather than inferring
    // it, and the host already times it out at 90s on its own.
    expect(isPlaceable(liveness({ source: "socket", lastSeenAt: 0 }), now)).toBe(true)
    expect(isPlaceable(liveness({ source: "socket", online: false }), now)).toBe(false)
  })

  it("always places local work", () => {
    expect(isPlaceable(liveness({ source: "local", online: false, lastSeenAt: 0 }), now)).toBe(true)
  })

  it("expires a timestamp-based peer at the host's own idle timeout", () => {
    // This is the bug: `action.mobile.*` sorted by `lastSeenAt` and never
    // checked it, so a phone last seen three days ago was selected, dispatched
    // to, and blocked for 120s before failing — without trying anyone else.
    expect(isPlaceable(liveness({ lastSeenAt: now - DEFAULT_LIVENESS_TTL_MS + 1 }), now)).toBe(true)
    expect(isPlaceable(liveness({ lastSeenAt: now - DEFAULT_LIVENESS_TTL_MS - 1 }), now)).toBe(
      false
    )
    expect(isPlaceable(liveness({ lastSeenAt: now - 3 * 86_400_000 }), now)).toBe(false)
  })

  it("honours a caller-supplied TTL", () => {
    expect(isPlaceable(liveness({ lastSeenAt: now - 5_000 }), now, { ttlMs: 1_000 })).toBe(false)
    expect(isPlaceable(liveness({ lastSeenAt: now - 5_000 }), now, { ttlMs: 10_000 })).toBe(true)
  })

  it("does not read 'never seen' as 'here'", () => {
    for (const lastSeenAt of [0, Number.NaN, -1]) {
      expect(isPlaceable(liveness({ lastSeenAt }), now)).toBe(false)
    }
    expect(isPlaceable(liveness({ lastSeenAt: 0 }), now, { trustUnknownTimestamps: true })).toBe(
      true
    )
  })

  it("tolerates a peer whose clock runs ahead", () => {
    // Refusing a few seconds of NTP drift would strand an entire machine.
    expect(isPlaceable(liveness({ lastSeenAt: now + 5_000 }), now)).toBe(true)
  })

  it("respects an explicitly offline manifest peer regardless of freshness", () => {
    expect(isPlaceable(liveness({ source: "manifest", online: false }), now)).toBe(false)
    expect(isPlaceable(liveness({ source: "manifest", online: true }), now)).toBe(true)
  })
})

describe("livenessAgeMs", () => {
  it("reports staleness, negative under clock skew", () => {
    expect(livenessAgeMs(liveness({ lastSeenAt: now - 500 }), now)).toBe(500)
    expect(livenessAgeMs(liveness({ lastSeenAt: now + 500 }), now)).toBe(-500)
  })
})
