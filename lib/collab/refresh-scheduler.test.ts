import {
  COLLAB_REFRESH_INTERVAL_MS,
  COLLAB_REFRESH_MAX_BACKOFF_MS,
  collabRefreshDelay,
  collabRefreshInFlight,
  installCollabRefreshScheduler,
  isCollabFeedLive,
  requestCollabRefresh,
  setCollabFeedLive,
} from "./refresh-scheduler"

describe("collaboration refresh scheduling", () => {
  it("deduplicates concurrent refreshes for one account", async () => {
    let resolve!: (value: never) => void
    const refresh = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const first = requestCollabRefresh("account-dedupe", refresh as never)
    const second = requestCollabRefresh("account-dedupe", refresh as never)
    expect(refresh).toHaveBeenCalledTimes(1)
    resolve({ status: "skipped", reason: "not-configured" } as never)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it("backs off exponentially and caps at fifteen minutes", () => {
    expect(collabRefreshDelay(0)).toBe(60_000)
    expect(collabRefreshDelay(2)).toBe(240_000)
    expect(collabRefreshDelay(20)).toBe(COLLAB_REFRESH_MAX_BACKOFF_MS)
  })
})

describe("the change feed and the timed poll (ADR-0206)", () => {
  function fakeWindow() {
    const listeners = new Map<string, () => void>()
    let pending: (() => void) | undefined
    return {
      fire: (name: string) => listeners.get(name)?.(),
      runTimer: () => {
        const fn = pending
        pending = undefined
        fn?.()
      },
      window: {
        addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
        removeEventListener: (name: string) => listeners.delete(name),
        setTimeout: (fn: () => void) => {
          pending = fn
          return 1
        },
        clearTimeout: () => {
          pending = undefined
        },
      } as never,
    }
  }
  const visible = {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as never

  it("tracks which profiles have a live feed", () => {
    setCollabFeedLive("acct-live", true)
    expect(isCollabFeedLive("acct-live")).toBe(true)
    setCollabFeedLive("acct-live", false)
    expect(isCollabFeedLive("acct-live")).toBe(false)
  })

  it("skips the timed refresh while the feed is live but still refreshes on focus", async () => {
    const refresh = jest.fn(async () => ({ status: "skipped", reason: "not-configured" }) as never)
    let live = true
    const win = fakeWindow()
    const stop = installCollabRefreshScheduler("acct-gated", {
      refresh,
      window: win.window,
      document: visible,
      feedLive: () => live,
    })
    win.runTimer()
    expect(refresh).not.toHaveBeenCalled()
    win.fire("focus")
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    live = false
    await new Promise((resolve) => setTimeout(resolve, 0))
    win.runTimer()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    expect(COLLAB_REFRESH_INTERVAL_MS).toBe(60_000)
  })

  it("exposes the refresh in flight so a later frame can wait it out", async () => {
    let resolve!: (value: never) => void
    const running = requestCollabRefresh(
      "acct-inflight",
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    expect(collabRefreshInFlight("acct-inflight")).toBeDefined()
    resolve({ status: "skipped", reason: "no-org" } as never)
    await running
    expect(collabRefreshInFlight("acct-inflight")).toBeUndefined()
  })
})
