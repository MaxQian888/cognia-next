/** @jest-environment jsdom */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  armTraceDebugSession,
  disarmTraceDebugSession,
  getTraceDebugSession,
  isTraceDebugArmed,
  subscribeTraceDebugSession,
  traceDebugRemainingMs,
  DEFAULT_TRACE_DEBUG_DURATION_MS,
  MAX_TRACE_DEBUG_DURATION_MS,
  MIN_TRACE_DEBUG_DURATION_MS,
  TRACE_DEBUG_STORAGE_KEY,
  TRACE_DEBUG_TIERS,
} from "./debug-session"

const NOW = 1_700_000_000_000

beforeEach(() => {
  localStorage.clear()
})

describe("armTraceDebugSession", () => {
  it("arms every tier for the default window when nothing is specified", () => {
    const session = armTraceDebugSession({}, NOW)
    expect(session.startedAt).toBe(NOW)
    expect(session.expiresAt).toBe(NOW + DEFAULT_TRACE_DEBUG_DURATION_MS)
    expect(session.tiers).toEqual([...TRACE_DEBUG_TIERS])
    expect(session.sessionId).toBeUndefined()
  })

  it("clamps the duration instead of rejecting it", () => {
    // An "always on" debug session is the state this module exists to prevent.
    expect(armTraceDebugSession({ durationMs: 24 * 60 * 60_000 }, NOW).expiresAt).toBe(
      NOW + MAX_TRACE_DEBUG_DURATION_MS
    )
    expect(armTraceDebugSession({ durationMs: 5 }, NOW).expiresAt).toBe(
      NOW + MIN_TRACE_DEBUG_DURATION_MS
    )
    expect(armTraceDebugSession({ durationMs: Number.NaN }, NOW).expiresAt).toBe(
      NOW + DEFAULT_TRACE_DEBUG_DURATION_MS
    )
  })

  it("keeps only the requested tiers, in canonical order", () => {
    const session = armTraceDebugSession({ tiers: ["rawBodies", "deltas"] }, NOW)
    expect(session.tiers).toEqual(["deltas", "rawBodies"])
  })

  it("replaces a session that is already armed", () => {
    armTraceDebugSession({ tiers: ["deltas"], durationMs: 10 * 60_000 }, NOW)
    armTraceDebugSession({ tiers: ["prompts"], durationMs: 20 * 60_000 }, NOW)
    const session = getTraceDebugSession(NOW)
    expect(session?.tiers).toEqual(["prompts"])
    expect(session?.expiresAt).toBe(NOW + 20 * 60_000)
  })
})

describe("getTraceDebugSession", () => {
  it("returns null once the window has passed and clears the record", () => {
    armTraceDebugSession({ durationMs: 60_000 }, NOW)
    expect(getTraceDebugSession(NOW + 59_999)).not.toBeNull()
    // Expiry is evaluated on read, so a session armed before a crash is already
    // expired when the app comes back rather than capturing forever.
    expect(getTraceDebugSession(NOW + 60_000)).toBeNull()
    expect(localStorage.getItem(TRACE_DEBUG_STORAGE_KEY)).toBeNull()
  })

  it("drops a corrupt record rather than re-parsing it on every event", () => {
    localStorage.setItem(TRACE_DEBUG_STORAGE_KEY, "{not json")
    expect(getTraceDebugSession(NOW)).toBeNull()
    expect(localStorage.getItem(TRACE_DEBUG_STORAGE_KEY)).toBeNull()
  })

  it("refuses a record whose tiers are all unrecognised", () => {
    localStorage.setItem(
      TRACE_DEBUG_STORAGE_KEY,
      JSON.stringify({ startedAt: NOW, expiresAt: NOW + 60_000, tiers: ["nonsense"] })
    )
    // Falling back to "all tiers" here would arm more than the user asked for.
    expect(getTraceDebugSession(NOW)).toBeNull()
  })

  it("reads a record written without tiers as every tier", () => {
    localStorage.setItem(
      TRACE_DEBUG_STORAGE_KEY,
      JSON.stringify({ startedAt: NOW, expiresAt: NOW + 60_000 })
    )
    expect(getTraceDebugSession(NOW)?.tiers).toEqual([...TRACE_DEBUG_TIERS])
  })
})

describe("isTraceDebugArmed", () => {
  it("is false with nothing armed", () => {
    expect(isTraceDebugArmed("deltas", "session-1", NOW)).toBe(false)
  })

  it("is true only for armed tiers", () => {
    armTraceDebugSession({ tiers: ["deltas"] }, NOW)
    expect(isTraceDebugArmed("deltas", "session-1", NOW)).toBe(true)
    expect(isTraceDebugArmed("rawBodies", "session-1", NOW)).toBe(false)
  })

  it("does not capture other conversations when scoped to one session", () => {
    armTraceDebugSession({ sessionId: "session-1" }, NOW)
    expect(isTraceDebugArmed("deltas", "session-1", NOW)).toBe(true)
    expect(isTraceDebugArmed("deltas", "session-2", NOW)).toBe(false)
    // An unattributed event cannot be proven to belong to the scoped session.
    expect(isTraceDebugArmed("deltas", undefined, NOW)).toBe(false)
  })

  it("captures every session when unscoped", () => {
    armTraceDebugSession({}, NOW)
    expect(isTraceDebugArmed("deltas", "anything", NOW)).toBe(true)
    expect(isTraceDebugArmed("deltas", undefined, NOW)).toBe(true)
  })

  it("stops capturing at expiry", () => {
    armTraceDebugSession({ durationMs: 60_000 }, NOW)
    expect(isTraceDebugArmed("deltas", "s", NOW + 60_000)).toBe(false)
  })
})

describe("disarmTraceDebugSession", () => {
  it("clears the session and is idempotent", () => {
    armTraceDebugSession({}, NOW)
    disarmTraceDebugSession()
    expect(getTraceDebugSession(NOW)).toBeNull()
    expect(() => disarmTraceDebugSession()).not.toThrow()
  })
})

describe("traceDebugRemainingMs", () => {
  it("counts down and floors at zero", () => {
    armTraceDebugSession({ durationMs: 60_000 }, NOW)
    expect(traceDebugRemainingMs(NOW)).toBe(60_000)
    expect(traceDebugRemainingMs(NOW + 20_000)).toBe(40_000)
    expect(traceDebugRemainingMs(NOW + 999_999)).toBe(0)
  })
})

describe("subscribeTraceDebugSession", () => {
  it("fires on arm and disarm and stops after unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeTraceDebugSession(listener)
    armTraceDebugSession({}, NOW)
    expect(listener).toHaveBeenCalledTimes(1)
    disarmTraceDebugSession()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    armTraceDebugSession({}, NOW)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("survives a throwing subscriber", () => {
    const unsubscribe = subscribeTraceDebugSession(() => {
      throw new Error("boom")
    })
    expect(() => armTraceDebugSession({}, NOW)).not.toThrow()
    unsubscribe()
  })
})

describe("data boundary", () => {
  it("is absent from the backup snapshot allowlist, so it can never ride an export", () => {
    // `SNAPSHOT_DOMAIN_KEYS` in `lib/data/domain/index.ts` is an allowlist:
    // only keys listed there are snapshotted into a backup / transfer package.
    // Absence is the whole guarantee, so pin it against a later accidental add.
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "data", "domain", "index.ts"),
      "utf8"
    )
    expect(source).toContain("SNAPSHOT_DOMAIN_KEYS")
    expect(source).not.toContain(TRACE_DEBUG_STORAGE_KEY)
  })

  it("is absent from the support-report sections, so it cannot reach a .cognia-diagnostic package", () => {
    // ADR-0102: `.cognia-diagnostic` is assembled from registered sections. A
    // debug session captures user content locally; shipping that content to an
    // issue tracker is the one thing it must never do.
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "support-report", "sections.ts"),
      "utf8"
    )
    expect(source).not.toContain(TRACE_DEBUG_STORAGE_KEY)
    expect(source).not.toContain("debug-session")
  })
})
