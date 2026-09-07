/** @jest-environment jsdom */

const invoke = jest.fn(async () => undefined)
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const isTauri = jest.fn(() => false)
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => isTauri() }))

import {
  __resetScreenWakeLockForTests,
  isScreenHoldAvailable,
  releaseAllScreenWakeHolders,
  screenWakeHolders,
  syncScreenWakeHolders,
} from "./screen-wake-lock"

type FakeSentinel = { released: boolean; release: jest.Mock }

function installWakeLock(): { request: jest.Mock; sentinels: FakeSentinel[] } {
  const sentinels: FakeSentinel[] = []
  const request = jest.fn(async () => {
    const sentinel: FakeSentinel = {
      released: false,
      release: jest.fn(async () => {
        sentinel.released = true
      }),
    }
    sentinels.push(sentinel)
    return sentinel
  })
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true })
  return { request, sentinels }
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("screen wake lock", () => {
  beforeEach(() => {
    __resetScreenWakeLockForTests()
    invoke.mockClear()
    isTauri.mockReturnValue(false)
    Object.defineProperty(navigator, "wakeLock", { value: undefined, configurable: true })
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
  })

  it("reports no hold available in a browser without the API", () => {
    // The settings card says so out loud rather than offering a dead switch.
    expect(isScreenHoldAvailable()).toBe(false)
  })

  it("requests one browser lock for any number of holders and releases at zero", async () => {
    const { request, sentinels } = installWakeLock()
    expect(isScreenHoldAvailable()).toBe(true)

    await syncScreenWakeHolders(["s_a"])
    await syncScreenWakeHolders(["s_a", "s_b"])
    // One page, one lock. A second request per conversation would leak.
    expect(request).toHaveBeenCalledTimes(1)
    expect(screenWakeHolders()).toEqual(["s_a", "s_b"])

    await syncScreenWakeHolders(["s_b"])
    expect(sentinels[0]!.release).not.toHaveBeenCalled()

    await releaseAllScreenWakeHolders()
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1)
    expect(screenWakeHolders()).toEqual([])
  })

  it("re-takes the lock the user agent drops while the page is hidden", async () => {
    const { request, sentinels } = installWakeLock()
    await syncScreenWakeHolders(["s_a"])

    // The user agent releases on hide and does NOT restore on return.
    sentinels[0]!.released = true
    setVisibility("hidden")
    setVisibility("visible")
    await Promise.resolve()
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it("does not re-request on a visibility edge once nothing holds", async () => {
    const { request } = installWakeLock()
    await syncScreenWakeHolders(["s_a"])
    await releaseAllScreenWakeHolders()

    setVisibility("visible")
    await Promise.resolve()
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it("sends the desktop the whole set, not the edges", async () => {
    isTauri.mockReturnValue(true)
    await syncScreenWakeHolders(["s_b", "s_a"])
    expect(invoke).toHaveBeenLastCalledWith("power_screen_holds_set", {
      holders: ["s_a", "s_b"],
    })

    invoke.mockClear()
    await syncScreenWakeHolders(["s_b"])
    expect(invoke).toHaveBeenLastCalledWith("power_screen_holds_set", { holders: ["s_b"] })

    invoke.mockClear()
    await syncScreenWakeHolders(["s_b"])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("tells the desktop about an empty set once, to clear a reload's stale hold", async () => {
    isTauri.mockReturnValue(true)
    // A reload during a run leaves Rust holding a set no live conversation
    // claims. Skipping the first empty sync as a no-op would pin the display
    // for the rest of the process.
    await syncScreenWakeHolders([])
    expect(invoke).toHaveBeenCalledWith("power_screen_holds_set", { holders: [] })

    invoke.mockClear()
    await syncScreenWakeHolders([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("keeps the desired set out of the record when the platform refuses", async () => {
    isTauri.mockReturnValue(true)
    invoke.mockRejectedValueOnce(new Error("denied"))
    await syncScreenWakeHolders(["s_a"])
    // Recording it as held would make the next sync a no-op and the hold would
    // never be retried, so a transient failure would silently become permanent.
    expect(screenWakeHolders()).toEqual([])

    await syncScreenWakeHolders(["s_a"])
    expect(screenWakeHolders()).toEqual(["s_a"])
  })
})
