import {
  __resetNativeMenuClaimsForTesting,
  claimNativeMenuAction,
  MENU_CLAIM_FALLBACK_MS,
  MENU_CLAIM_WINDOW_MS,
  takeNativeMenuClaim,
} from "./menu-focus-claims"

describe("native menu keyboard claims", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    __resetNativeMenuClaimsForTesting()
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it("hands a fresh claim to the matching menu event exactly once", () => {
    const run = jest.fn()
    claimNativeMenuAction("toggle-sidebar", run, { now: 1_000 })

    const taken = takeNativeMenuClaim("toggle-sidebar", 1_200)
    expect(taken).toBe(run)
    expect(takeNativeMenuClaim("toggle-sidebar", 1_210)).toBeNull()
  })

  it("never redirects a different menu action", () => {
    claimNativeMenuAction("toggle-sidebar", jest.fn(), { now: 1_000 })

    expect(takeNativeMenuClaim("go-inbox", 1_010)).toBeNull()
    // The mismatched read leaves the claim in place for its own event.
    expect(takeNativeMenuClaim("toggle-sidebar", 1_020)).not.toBeNull()
  })

  it("expires a claim whose menu event never arrived in time", () => {
    claimNativeMenuAction("command-palette", jest.fn(), { now: 1_000 })

    expect(takeNativeMenuClaim("command-palette", 1_000 + MENU_CLAIM_WINDOW_MS + 1)).toBeNull()
    // Expired claims are consumed, not left to match a much later event.
    expect(takeNativeMenuClaim("command-palette", 1_000 + MENU_CLAIM_WINDOW_MS + 2)).toBeNull()
  })

  it("lets the latest keystroke's claim replace an older one", () => {
    const first = jest.fn()
    const second = jest.fn()
    claimNativeMenuAction("go-inbox", first, { now: 1_000 })
    claimNativeMenuAction("go-workflows", second, { now: 1_050 })

    expect(takeNativeMenuClaim("go-inbox", 1_060)).toBeNull()
    expect(takeNativeMenuClaim("go-workflows", 1_070)).toBe(second)
  })

  it("runs the claim itself when no menu event takes it", () => {
    const run = jest.fn()
    claimNativeMenuAction("toggle-sidebar", run)

    jest.advanceTimersByTime(MENU_CLAIM_FALLBACK_MS - 1)
    expect(run).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    // The fallback consumed it — a late menu event gets the app action.
    expect(takeNativeMenuClaim("toggle-sidebar")).toBeNull()
  })

  it("does not run a claim the router already took", () => {
    const run = jest.fn()
    claimNativeMenuAction("go-workflows", run)
    expect(takeNativeMenuClaim("go-workflows")).toBe(run)

    jest.advanceTimersByTime(MENU_CLAIM_FALLBACK_MS)
    expect(run).not.toHaveBeenCalled()
  })

  it("drops a superseded claim's fallback", () => {
    const stale = jest.fn()
    const fresh = jest.fn()
    claimNativeMenuAction("go-inbox", stale)
    claimNativeMenuAction("toggle-sidebar", fresh)

    jest.advanceTimersByTime(MENU_CLAIM_FALLBACK_MS)
    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it("returns nothing when no claim is pending", () => {
    expect(takeNativeMenuClaim("toggle-sidebar")).toBeNull()
  })
})
