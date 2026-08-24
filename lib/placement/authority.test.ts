/** @jest-environment jsdom */
import {
  DEFAULT_AUTHORITY_CONFIG,
  getExecutionAuthorityConfigServerSnapshot,
  getExecutionAuthorityConfigSnapshot,
  readExecutionAuthorityConfig,
  resolveExecutionAuthority,
  subscribeExecutionAuthorityConfig,
  writeExecutionAuthorityConfig,
  __resetExecutionAuthorityConfigForTests,
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

  describe("react seam", () => {
    beforeEach(() => {
      globalThis.localStorage?.clear()
      __resetExecutionAuthorityConfigForTests()
    })

    it("keeps the snapshot referentially stable so useSyncExternalStore settles", () => {
      const first = getExecutionAuthorityConfigSnapshot()
      expect(getExecutionAuthorityConfigSnapshot()).toBe(first)
      expect(first).toEqual(DEFAULT_AUTHORITY_CONFIG)
    })

    it("notifies subscribers and re-snapshots after a write", () => {
      const listener = jest.fn()
      const unsubscribe = subscribeExecutionAuthorityConfig(listener)
      const before = getExecutionAuthorityConfigSnapshot()

      const next = { hostId: "host-a", degradeAfterMs: 60_000 }
      writeExecutionAuthorityConfig(next)

      expect(listener).toHaveBeenCalledTimes(1)
      expect(getExecutionAuthorityConfigSnapshot()).toEqual(next)
      expect(getExecutionAuthorityConfigSnapshot()).not.toBe(before)

      unsubscribe()
      writeExecutionAuthorityConfig(DEFAULT_AUTHORITY_CONFIG)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("re-reads storage when another tab rewrites the key", () => {
      const listener = jest.fn()
      subscribeExecutionAuthorityConfig(listener)
      getExecutionAuthorityConfigSnapshot()

      globalThis.localStorage.setItem(
        "cognia-execution-authority-v1",
        JSON.stringify({ hostId: "host-b", degradeAfterMs: 900_000 })
      )
      window.dispatchEvent(new StorageEvent("storage", { key: "cognia-execution-authority-v1" }))

      expect(listener).toHaveBeenCalled()
      expect(getExecutionAuthorityConfigSnapshot()).toEqual({
        hostId: "host-b",
        degradeAfterMs: 900_000,
      })
    })

    it("prerenders the default, because storage is unreadable during a static export", () => {
      writeExecutionAuthorityConfig({ hostId: "host-a", degradeAfterMs: 60_000 })
      expect(getExecutionAuthorityConfigServerSnapshot()).toEqual(DEFAULT_AUTHORITY_CONFIG)
    })
  })
})
