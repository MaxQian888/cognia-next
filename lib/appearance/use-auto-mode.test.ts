/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { useAutoMode, wallpaperPhase } from "./use-auto-mode"
import {
  __INTERNALS__ as CACHE,
  analysisCacheKey,
  writeCachedAnalysis,
} from "./wallpaper-analysis-cache"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"
import { DEFAULT_BACKGROUND_SETTINGS, type Wallpaper } from "@/types/appearance"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_AUTOMODE } from "@/types/appearance"
import type { AutoModeSettings } from "@/types/appearance"

const mockSetTheme = jest.fn()
jest.mock("next-themes", () => ({ useTheme: () => ({ setTheme: mockSetTheme }) }))

let prefersDark = false

function installMatchMedia() {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark") ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia
}

function setupStore(autoMode: AutoModeSettings, theme = "system") {
  const save = jest.fn().mockImplementation(async (patch: Record<string, unknown>) => {
    useSettingsStore.setState(patch)
  })
  useSettingsStore.setState({ autoMode, theme: theme as never, save: save as never })
  return save
}

const automode = (patch: Partial<AutoModeSettings>): AutoModeSettings => ({
  ...DEFAULT_AUTOMODE,
  ...patch,
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date(2024, 0, 1, 12, 0, 0))
  prefersDark = false
  mockSetTheme.mockClear()
  installMatchMedia()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useAutoMode", () => {
  it("does nothing while disabled", () => {
    const save = setupStore(automode({ enabled: false }))
    renderHook(() => useAutoMode())
    jest.advanceTimersByTime(120_000)
    expect(mockSetTheme).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("applies the system phase on mount (dark)", () => {
    prefersDark = true
    const save = setupStore(automode({ enabled: true, trigger: "system" }))
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("dark")
    expect(save).toHaveBeenCalledWith({ theme: "dark" })
  })

  it("applies the system phase on mount (light)", () => {
    prefersDark = false
    setupStore(automode({ enabled: true, trigger: "system" }))
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("light")
  })

  it("applies the schedule phase for the current time", () => {
    // 12:00 is inside the 07:00–19:00 light window.
    setupStore(
      automode({
        enabled: true,
        trigger: "schedule",
        schedule: { lightAt: "07:00", darkAt: "19:00" },
      })
    )
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("light")
  })

  it("does not re-apply when the theme already matches", () => {
    prefersDark = true
    const save = setupStore(automode({ enabled: true, trigger: "system" }), "dark")
    renderHook(() => useAutoMode())
    expect(mockSetTheme).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("suppresses switching during a manual snooze", () => {
    const save = setupStore(
      automode({
        enabled: true,
        trigger: "system",
        lastManualAt: Date.now(),
        snoozeMs: 60 * 60 * 1000,
      })
    )
    prefersDark = true
    renderHook(() => useAutoMode())
    expect(mockSetTheme).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("records a manual override when the live theme diverges", () => {
    prefersDark = true
    const save = setupStore(automode({ enabled: true, trigger: "system" }))
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("dark") // runner applied dark
    save.mockClear()
    // User flips it back to light by hand.
    useSettingsStore.setState({ theme: "light" as never })
    jest.advanceTimersByTime(60_000)
    expect(save).toHaveBeenCalledTimes(1)
    const patch = save.mock.calls[0][0] as { autoMode: AutoModeSettings }
    expect(typeof patch.autoMode.lastManualAt).toBe("number")
  })

  it("cleans up the interval and media listener on unmount", () => {
    setupStore(automode({ enabled: true, trigger: "system" }))
    const { unmount } = renderHook(() => useAutoMode())
    expect(() => unmount()).not.toThrow()
  })
})

describe("useAutoMode — wallpaper trigger", () => {
  const night: Wallpaper = {
    id: "wp_night",
    name: "night",
    kind: "color",
    source: { kind: "color", value: "#0b1020" },
    builtin: false,
    createdAt: 1,
  }
  const paper: Wallpaper = {
    id: "wp_paper",
    name: "paper",
    kind: "color",
    source: { kind: "color", value: "#fafaf9" },
    builtin: false,
    createdAt: 1,
  }
  const analysisOf = (hex: string): WallpaperThemeAnalysis => ({
    accent: hex,
    secondary: hex,
    dominant: hex,
    averageLuminance: 0.5,
    luminanceSpread: 0,
    darkExtreme: hex,
    brightExtreme: hex,
    baseVariant: "dark",
  })

  function showWallpaper(activeId: string | null): void {
    useSettingsStore.setState({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: activeId !== null, activeId },
      wallpapers: [night, paper],
    } as never)
  }

  beforeEach(() => {
    localStorage.clear()
    CACHE.resetMemory()
  })

  it("picks the variant the active wallpaper suits", () => {
    writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020"))
    setupStore(automode({ enabled: true, trigger: "wallpaper" }), "light")
    showWallpaper("wp_night")
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("dark")
  })

  it("follows the system until the wallpaper is measured, then switches", () => {
    prefersDark = false
    setupStore(automode({ enabled: true, trigger: "wallpaper" }), "system")
    showWallpaper("wp_night")
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenLastCalledWith("light")
    act(() => writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020")))
    expect(mockSetTheme).toHaveBeenLastCalledWith("dark")
  })

  it("re-evaluates straight away when the wallpaper changes", () => {
    writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020"))
    writeCachedAnalysis(analysisCacheKey(paper), analysisOf("#fafaf9"))
    setupStore(automode({ enabled: true, trigger: "wallpaper" }), "system")
    showWallpaper("wp_night")
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenLastCalledWith("dark")
    act(() => showWallpaper("wp_paper"))
    expect(mockSetTheme).toHaveBeenLastCalledWith("light")
  })

  it("follows the system with no wallpaper up", () => {
    prefersDark = true
    setupStore(automode({ enabled: true, trigger: "wallpaper" }), "light")
    showWallpaper(null)
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenCalledWith("dark")
  })

  it("ignores wallpaper analyses under the other triggers", () => {
    prefersDark = false
    writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020"))
    setupStore(automode({ enabled: true, trigger: "system" }), "system")
    showWallpaper("wp_night")
    renderHook(() => useAutoMode())
    expect(mockSetTheme).toHaveBeenLastCalledWith("light")
  })
})

describe("wallpaperPhase", () => {
  beforeEach(() => {
    localStorage.clear()
    CACHE.resetMemory()
  })

  it("is null without a painted, measured wallpaper", () => {
    expect(wallpaperPhase({ ...DEFAULT_BACKGROUND_SETTINGS }, [])).toBeNull()
    expect(
      wallpaperPhase({ ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, activeId: "missing" }, [])
    ).toBeNull()
  })
})
