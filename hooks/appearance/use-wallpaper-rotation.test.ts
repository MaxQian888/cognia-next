/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from "@/types/appearance"
import { DEFAULT_WALLPAPER_ROTATION } from "@/types/appearance/wallpaper-rotation"
import type { Wallpaper } from "@/types/appearance"

const setBackground = jest.fn(async () => {})

interface StoreState {
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  setBackground: typeof setBackground
}

const state: StoreState = {
  background: { ...DEFAULT_BACKGROUND_SETTINGS },
  wallpapers: [],
  setBackground,
}

jest.mock("@/stores/settings", () => {
  const useSettingsStore = jest.fn((selector: (s: StoreState) => unknown) => selector(state))
  ;(useSettingsStore as unknown as { getState: () => StoreState }).getState = () => state
  return { useSettingsStore }
})

// The built-in presets would otherwise add wallpapers the fixtures never
// declared, making pool assertions depend on how many presets ship.
jest.mock("@/lib/appearance/presets", () => ({
  withBuiltinPresets: (list: Wallpaper[]) => list,
}))

import { useWallpaperRotation } from "./use-wallpaper-rotation"

function image(id: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "image",
    source: {
      kind: "image",
      storage: "data-url",
      dataUrl: "data:image/png;base64,xx",
      mime: "image/png",
      width: 4,
      height: 4,
    },
    builtin: false,
    createdAt: 0,
  }
}

function setState(background: Partial<BackgroundSettings>, wallpapers: Wallpaper[] = []): void {
  state.background = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, ...background }
  state.wallpapers = wallpapers
}

beforeEach(() => {
  jest.useFakeTimers()
  setBackground.mockClear()
  setState({})
  Object.defineProperty(document, "hidden", { configurable: true, value: false, writable: true })
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useWallpaperRotation", () => {
  it("does nothing while rotation is off", () => {
    setState({ activeId: "a", rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: false } })
    renderHook(() => useWallpaperRotation())
    expect(setBackground).not.toHaveBeenCalled()
  })

  it("does nothing while the background itself is off", () => {
    // Rotating a wallpaper that is not being painted is pure write traffic.
    setState({
      enabled: false,
      activeId: "a",
      rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: true },
    })
    renderHook(() => useWallpaperRotation())
    expect(setBackground).not.toHaveBeenCalled()
  })

  it("starts the clock instead of advancing on the first evaluation", () => {
    // Enabling a carousel must not immediately replace the wallpaper the user
    // just picked.
    setState({ activeId: "a", rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: true } }, [
      image("a"),
      image("b"),
    ])
    renderHook(() => useWallpaperRotation())

    expect(setBackground).toHaveBeenCalledTimes(1)
    const patch = setBackground.mock.calls[0][0] as { rotation: { lastAdvancedAt?: number } }
    expect(typeof patch.rotation.lastAdvancedAt).toBe("number")
    expect(patch).not.toHaveProperty("activeId")
  })

  it("advances once the interval has elapsed", () => {
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          intervalMs: 60_000,
          lastAdvancedAt: Date.now() - 120_000,
        },
      },
      [image("a"), image("b")]
    )
    renderHook(() => useWallpaperRotation())

    expect(setBackground).toHaveBeenCalledTimes(1)
    const patch = setBackground.mock.calls[0][0] as { activeId?: string }
    expect(patch.activeId).toBe("b")
  })

  it("writes the wallpaper and the timestamp in ONE settings write", () => {
    // Two writes would mean two Dexie round-trips and two re-renders of the
    // applier per advance, and the applier would see a half-applied state.
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          lastAdvancedAt: Date.now() - 10_000_000,
        },
      },
      [image("a"), image("b")]
    )
    renderHook(() => useWallpaperRotation())

    expect(setBackground).toHaveBeenCalledTimes(1)
    const patch = setBackground.mock.calls[0][0] as {
      activeId?: string
      rotation?: { lastAdvancedAt?: number }
    }
    expect(patch.activeId).toBe("b")
    expect(typeof patch.rotation?.lastAdvancedAt).toBe("number")
  })

  it("stamps the clock even when the pool offers nowhere to go", () => {
    // A single-item playlist would otherwise re-evaluate as due on every tick,
    // forever, without ever settling.
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          lastAdvancedAt: Date.now() - 10_000_000,
        },
      },
      [image("a")]
    )
    renderHook(() => useWallpaperRotation())

    expect(setBackground).toHaveBeenCalledTimes(1)
    const patch = setBackground.mock.calls[0][0] as { activeId?: string; rotation?: object }
    expect(patch).not.toHaveProperty("activeId")
    expect(patch.rotation).toBeDefined()
  })

  it("holds while the document is hidden and arms no timer at all", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true, writable: true })
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          lastAdvancedAt: Date.now() - 10_000_000,
        },
      },
      [image("a"), image("b")]
    )
    renderHook(() => useWallpaperRotation())

    expect(setBackground).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("catches up the moment the document becomes visible again", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true, writable: true })
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          lastAdvancedAt: Date.now() - 10_000_000,
        },
      },
      [image("a"), image("b")]
    )
    renderHook(() => useWallpaperRotation())
    expect(setBackground).not.toHaveBeenCalled()

    Object.defineProperty(document, "hidden", { configurable: true, value: false, writable: true })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    expect(setBackground).toHaveBeenCalledTimes(1)
  })

  it("keeps ticking while hidden when the user opted out of the pause", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true, writable: true })
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          pauseWhenHidden: false,
          lastAdvancedAt: Date.now() - 10_000_000,
        },
      },
      [image("a"), image("b")]
    )
    renderHook(() => useWallpaperRotation())

    expect(setBackground).toHaveBeenCalledTimes(1)
  })

  it("advances immediately on launch, exactly once", () => {
    setState(
      {
        activeId: "a",
        rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: true, trigger: "launch" },
      },
      [image("a"), image("b")]
    )
    const { rerender } = renderHook(() => useWallpaperRotation())
    expect(setBackground).toHaveBeenCalledTimes(1)
    expect((setBackground.mock.calls[0][0] as { activeId?: string }).activeId).toBe("b")

    setBackground.mockClear()
    act(() => {
      rerender()
    })
    expect(setBackground).not.toHaveBeenCalled()
  })

  it("caps a long delay so setTimeout cannot overflow and fire instantly", () => {
    // A 7-day interval exceeds the signed 32-bit setTimeout limit, which fires
    // immediately rather than late. That failure looks like a carousel that
    // will not stop advancing.
    setState(
      {
        activeId: "a",
        rotation: {
          ...DEFAULT_WALLPAPER_ROTATION,
          enabled: true,
          intervalMs: 7 * 24 * 60 * 60_000,
          lastAdvancedAt: Date.now(),
        },
      },
      [image("a"), image("b")]
    )
    const spy = jest.spyOn(window, "setTimeout")
    renderHook(() => useWallpaperRotation())

    const delays = spy.mock.calls.map((c) => c[1])
    expect(delays.some((d) => typeof d === "number" && d > 2_147_483_647)).toBe(false)
    spy.mockRestore()
  })

  it("clears its timer on unmount", () => {
    setState(
      {
        activeId: "a",
        rotation: { ...DEFAULT_WALLPAPER_ROTATION, enabled: true, lastAdvancedAt: Date.now() },
      },
      [image("a"), image("b")]
    )
    const { unmount } = renderHook(() => useWallpaperRotation())
    expect(jest.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})
