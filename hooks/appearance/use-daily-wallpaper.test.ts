/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from "@/types/appearance"
import {
  DEFAULT_DAILY_WALLPAPER,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"
import type { Wallpaper } from "@/types/appearance"

const setBackground = jest.fn(async () => {})
const addWallpaper = jest.fn(async () => {})
const deleteWallpaper = jest.fn(async () => {})

interface StoreState {
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  setBackground: typeof setBackground
  addWallpaper: typeof addWallpaper
  deleteWallpaper: typeof deleteWallpaper
}

const state: StoreState = {
  background: { ...DEFAULT_BACKGROUND_SETTINGS },
  wallpapers: [],
  setBackground,
  addWallpaper,
  deleteWallpaper,
}

jest.mock("@/stores/settings", () => {
  const useSettingsStore = jest.fn((selector: (s: StoreState) => unknown) => selector(state))
  ;(useSettingsStore as unknown as { getState: () => StoreState }).getState = () => state
  return { useSettingsStore }
})

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

const fetchDailyWallpaper = jest.fn()
const selectExpiredDailyWallpapers = jest.fn(() => [] as Wallpaper[])
jest.mock("@/lib/appearance/daily-wallpaper/fetch-daily-wallpaper", () => ({
  fetchDailyWallpaper: (...args: unknown[]) => fetchDailyWallpaper(...args),
  selectExpiredDailyWallpapers: (...args: unknown[]) => selectExpiredDailyWallpapers(...args),
}))

const deleteImage = jest.fn(async () => {})
jest.mock("@/lib/appearance/wallpaper-storage", () => ({
  deleteImage: (...args: unknown[]) => deleteImage(...args),
}))

let metered = false
let online = true
jest.mock("@/lib/appearance/daily-wallpaper/network-cost", () => ({
  isLikelyMeteredConnection: () => metered,
  isOnline: () => online,
}))

import { FAILURE_BACKOFF_MS, msUntilNextFetch, useDailyWallpaper } from "./use-daily-wallpaper"

function daily(patch: Partial<DailyWallpaperSettings> = {}): DailyWallpaperSettings {
  return { ...DEFAULT_DAILY_WALLPAPER, enabled: true, ...patch }
}

function setState(patch: Partial<DailyWallpaperSettings>, wallpapers: Wallpaper[] = []): void {
  state.background = { ...DEFAULT_BACKGROUND_SETTINGS, daily: daily(patch) }
  state.wallpapers = wallpapers
}

const stored: Wallpaper = {
  id: "daily_bing_x",
  name: "Test",
  kind: "image",
  source: {
    kind: "image",
    storage: "indexeddb",
    blobKey: "daily_bing_x",
    mime: "image/jpeg",
    width: 1,
    height: 1,
  },
  builtin: false,
  createdAt: 1,
}

beforeEach(() => {
  jest.useFakeTimers()
  // Testing Library's auto-cleanup is registered before this file's own
  // afterEach, so it unmounts AFTER the switch back to real timers and its
  // clearTimeout misses the fake ids. Without this, timers leak between tests.
  jest.clearAllTimers()
  jest.clearAllMocks()
  selectExpiredDailyWallpapers.mockReturnValue([])
  metered = false
  online = true
  setState({})
})

afterEach(() => {
  jest.useRealTimers()
})

describe("msUntilNextFetch", () => {
  const now = 1_000_000_000

  it("is due immediately when nothing has ever been fetched", () => {
    // Switching the feature on should produce a wallpaper, not a wait.
    expect(msUntilNextFetch(daily(), now)).toBe(0)
  })

  it("counts down the configured period", () => {
    const settings = daily({ refreshHours: 24, lastFetchedAt: now - 60_000 })
    expect(msUntilNextFetch(settings, now)).toBe(24 * 3_600_000 - 60_000)
  })

  it("is due once the period has elapsed", () => {
    expect(msUntilNextFetch(daily({ refreshHours: 1, lastFetchedAt: now - 3_600_000 }), now)).toBe(
      0
    )
  })

  it("holds briefly after a failure instead of retrying at full speed", () => {
    const settings = daily({ lastError: { code: "network", at: now - 60_000 } })
    expect(msUntilNextFetch(settings, now)).toBe(FAILURE_BACKOFF_MS - 60_000)
  })

  it("resumes the normal schedule once the backoff has passed", () => {
    const settings = daily({
      lastFetchedAt: now - 100 * 3_600_000,
      lastError: { code: "network", at: now - FAILURE_BACKOFF_MS - 1 },
    })
    expect(msUntilNextFetch(settings, now)).toBe(0)
  })

  it("retries rather than wedging on a clock that moved backwards", () => {
    expect(msUntilNextFetch(daily({ lastFetchedAt: now + 5_000 }), now)).toBe(0)
    expect(msUntilNextFetch(daily({ lastError: { code: "network", at: now + 5_000 } }), now)).toBe(
      0
    )
  })

  it("clamps an absurd period from a restored settings row", () => {
    const settings = daily({ refreshHours: 0, lastFetchedAt: now })
    expect(msUntilNextFetch(settings, now)).toBe(3_600_000)
  })
})

describe("useDailyWallpaper", () => {
  it("does nothing while disabled", async () => {
    setState({ enabled: false })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(fetchDailyWallpaper).not.toHaveBeenCalled()
  })

  it("fetches immediately when the source has never run", async () => {
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      wallpaper: stored,
      candidate: { entryKey: "20260903", imageUrl: "x", title: "Test" },
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(fetchDailyWallpaper).toHaveBeenCalledTimes(1)
    expect(addWallpaper).toHaveBeenCalledWith(stored)
  })

  it("activates the new wallpaper when autoApply is on", async () => {
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      wallpaper: stored,
      candidate: { entryKey: "20260903", imageUrl: "x", title: "Test" },
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    const patch = setBackground.mock.calls.at(-1)?.[0] as { activeId?: string; enabled?: boolean }
    expect(patch.activeId).toBe(stored.id)
    // Turning the layer on too: a fetched wallpaper nobody can see is not what
    // "apply automatically" promised.
    expect(patch.enabled).toBe(true)
  })

  it("stores without activating when autoApply is off", async () => {
    setState({ autoApply: false })
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      wallpaper: stored,
      candidate: { entryKey: "20260903", imageUrl: "x", title: "Test" },
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(addWallpaper).toHaveBeenCalled()
    const patch = setBackground.mock.calls.at(-1)?.[0] as { activeId?: string }
    expect(patch).not.toHaveProperty("activeId")
  })

  it("records a failure rather than swallowing it", async () => {
    // A daily wallpaper that silently stopped working looks exactly like one
    // that was never switched on.
    fetchDailyWallpaper.mockResolvedValue({ ok: false, code: "rate-limited", status: 429 })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    const patch = setBackground.mock.calls.at(-1)?.[0] as {
      daily: { lastError?: { code: string; status?: number } }
    }
    expect(patch.daily.lastError).toMatchObject({ code: "rate-limited", status: 429 })
    expect(addWallpaper).not.toHaveBeenCalled()
  })

  it("clears a previous failure on success", async () => {
    setState({ lastError: { code: "network", at: Date.now() - FAILURE_BACKOFF_MS - 1 } })
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      wallpaper: stored,
      candidate: { entryKey: "20260903", imageUrl: "x", title: "Test" },
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    const patch = setBackground.mock.calls.at(-1)?.[0] as { daily: { lastError?: unknown } }
    expect(patch.daily.lastError).toBeUndefined()
  })

  it("stamps the clock when the image is already current", async () => {
    // Otherwise a source with nothing new re-checks on every effect run.
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      skipped: "already-current",
      entryKey: "20260903",
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    const patch = setBackground.mock.calls.at(-1)?.[0] as {
      daily: { lastFetchedAt?: number; lastEntryKey?: string }
    }
    expect(typeof patch.daily.lastFetchedAt).toBe("number")
    expect(patch.daily.lastEntryKey).toBe("20260903")
    expect(addWallpaper).not.toHaveBeenCalled()
  })

  it("holds on a metered connection when the user asked it to", async () => {
    metered = true
    setState({ wifiOnly: true })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(fetchDailyWallpaper).not.toHaveBeenCalled()
  })

  it("fetches on a metered connection when the user opted out of the guard", async () => {
    metered = true
    setState({ wifiOnly: false })
    fetchDailyWallpaper.mockResolvedValue({ ok: false, code: "network" })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(fetchDailyWallpaper).toHaveBeenCalledTimes(1)
  })

  it("holds while offline and retries when the shell comes back", async () => {
    online = false
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(fetchDailyWallpaper).not.toHaveBeenCalled()

    online = true
    fetchDailyWallpaper.mockResolvedValue({ ok: false, code: "network" })
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(fetchDailyWallpaper).toHaveBeenCalledTimes(1)
  })

  it("reaps expired wallpapers, bytes before row", async () => {
    const old = { ...stored, id: "daily_bing_old" }
    selectExpiredDailyWallpapers.mockReturnValue([old])
    fetchDailyWallpaper.mockResolvedValue({
      ok: true,
      wallpaper: stored,
      candidate: { entryKey: "20260903", imageUrl: "x", title: "Test" },
    })
    await act(async () => {
      renderHook(() => useDailyWallpaper())
    })
    expect(deleteImage).toHaveBeenCalledWith(old.source)
    expect(deleteWallpaper).toHaveBeenCalledWith(old.id)
    // A failure to delete the bytes must not leave a row pointing at nothing,
    // which is what the reverse order would produce.
    expect(deleteImage.mock.invocationCallOrder[0]).toBeLessThan(
      deleteWallpaper.mock.invocationCallOrder[0]
    )
  })

  it("does not start a second fetch while one is in flight", async () => {
    let release: (() => void) | undefined
    fetchDailyWallpaper.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, code: "network" })
        })
    )
    const { rerender, unmount } = renderHook(() => useDailyWallpaper())
    await act(async () => {
      rerender()
      rerender()
    })
    expect(fetchDailyWallpaper).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.()
    })
    unmount()
  })

  it("clears the timer it armed on unmount", async () => {
    // Asserted against the id this hook actually armed, rather than against
    // jest.getTimerCount(): under fake timers React's own scheduler leaves a
    // pending timer in the same pool, so the global count is not a proxy for
    // "did this hook clean up".
    setState({ lastFetchedAt: Date.now() })
    const setSpy = jest.spyOn(window, "setTimeout")
    const clearSpy = jest.spyOn(window, "clearTimeout")

    let view: ReturnType<typeof renderHook> | undefined
    await act(async () => {
      view = renderHook(() => useDailyWallpaper())
    })

    const armed = setSpy.mock.results.at(-1)?.value
    expect(armed).toBeDefined()

    view!.unmount()
    expect(clearSpy).toHaveBeenCalledWith(armed)

    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})
