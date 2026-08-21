/** @jest-environment jsdom */
import {
  DEFAULT_AUTHORITY_CONFIG,
  readExecutionAuthorityConfig,
  resolveExecutionAuthority,
  writeExecutionAuthorityConfig,
  type ExecutionAuthorityConfig,
} from "./authority"
import type { PlacementLiveness } from "./liveness"

const NOW = 10_000_000

const configured: ExecutionAuthorityConfig = { hostId: "host-a", degradeAfterMs: 300_000 }

const live: PlacementLiveness = { online: true, lastSeenAt: NOW, source: "manifest" }

describe("resolveExecutionAuthority", () => {
  it("makes an unconfigured host its own authority, exactly as before", () => {
    // Zero regression is the point: a single-machine install must behave
    // byte-for-byte as it did with no authority concept at all.
    expect(
      resolveExecutionAuthority({
        config: DEFAULT_AUTHORITY_CONFIG,
        authorityLiveness: null,
        now: NOW,
      })
    ).toEqual({ isAuthority: true, degraded: false, authorityHostId: null })
  })

  it("stands down when the configured authority is reachable", () => {
    expect(
      resolveExecutionAuthority({ config: configured, authorityLiveness: live, now: NOW })
    ).toEqual({ isAuthority: false, degraded: false, authorityHostId: "host-a" })
  })

  it("does not fail over for a laptop that merely slept", () => {
    const napping = { ...live, lastSeenAt: NOW - 120_000 }
    expect(
      resolveExecutionAuthority({ config: configured, authorityLiveness: napping, now: NOW })
    ).toMatchObject({ isAuthority: false, degraded: false })
  })

  it("takes over, visibly, once the authority stays unreachable", () => {
    // Silence would mean the team's cron simply stops the day that laptop is
    // closed, with nothing anywhere explaining why.
    const gone = { ...live, lastSeenAt: NOW - 600_000 }
    expect(
      resolveExecutionAuthority({ config: configured, authorityLiveness: gone, now: NOW })
    ).toEqual({
      isAuthority: true,
      degraded: true,
      authorityHostId: "host-a",
      unreachableForMs: 600_000,
    })
  })

  it("runs locally rather than stranding schedules on a host it has never seen", () => {
    expect(
      resolveExecutionAuthority({ config: configured, authorityLiveness: null, now: NOW })
    ).toEqual({ isAuthority: true, degraded: true, authorityHostId: "host-a" })
  })
})

describe("execution authority config storage", () => {
  beforeEach(() => globalThis.localStorage?.clear())

  it("round-trips a configured authority", () => {
    writeExecutionAuthorityConfig(configured)
    expect(readExecutionAuthorityConfig()).toEqual(configured)
  })

  it("falls back to self-authority for anything unreadable", () => {
    // The failure mode to avoid is "nobody fires anything".
    expect(readExecutionAuthorityConfig()).toEqual(DEFAULT_AUTHORITY_CONFIG)
    globalThis.localStorage?.setItem("cognia-execution-authority-v1", "{not json")
    expect(readExecutionAuthorityConfig()).toEqual(DEFAULT_AUTHORITY_CONFIG)
    globalThis.localStorage?.setItem(
      "cognia-execution-authority-v1",
      JSON.stringify({ hostId: 42 })
    )
    expect(readExecutionAuthorityConfig()).toEqual(DEFAULT_AUTHORITY_CONFIG)
  })

  it("survives storage that refuses to write", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    expect(() => writeExecutionAuthorityConfig(configured)).not.toThrow()
    setItem.mockRestore()
  })
})
