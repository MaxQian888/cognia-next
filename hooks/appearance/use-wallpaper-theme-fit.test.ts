/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import {
  __INTERNALS__ as CACHE,
  analysisCacheKey,
  writeCachedAnalysis,
} from "@/lib/appearance/wallpaper-analysis-cache"
import type { WallpaperThemeAnalysis } from "@/lib/appearance/wallpaper-theme-generator"
import type { Wallpaper } from "@/types/appearance"

import { useWallpaperThemeFit } from "./use-wallpaper-theme-fit"

const night: Pick<Wallpaper, "id" | "source"> = {
  id: "wp_night",
  source: { kind: "color", value: "#0b1020" },
}

function analysisOf(hex: string): WallpaperThemeAnalysis {
  return {
    accent: hex,
    secondary: hex,
    dominant: hex,
    averageLuminance: 0.1,
    luminanceSpread: 0,
    darkExtreme: hex,
    brightExtreme: hex,
    baseVariant: "dark",
  }
}

beforeEach(() => {
  localStorage.clear()
  CACHE.resetMemory()
})

describe("useWallpaperThemeFit", () => {
  it("is empty with no wallpaper", () => {
    const { result } = renderHook(() => useWallpaperThemeFit(null, 0))
    expect(result.current).toEqual({ fit: null, measured: false })
  })

  it("waits for a measurement, then recommends as soon as it lands", () => {
    const { result } = renderHook(() => useWallpaperThemeFit(night, 0))
    expect(result.current.measured).toBe(false)
    act(() => writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020")))
    expect(result.current.measured).toBe(true)
    expect(result.current.fit?.recommended).toBe("dark")
  })

  it("uses the caller's own analysis until the cache has one", () => {
    const { result } = renderHook(() => useWallpaperThemeFit(night, 0, analysisOf("#fafaf9")))
    expect(result.current.fit?.recommended).toBe("light")
    // The cache is the guard's measurement of what is painted; it wins.
    act(() => writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020")))
    expect(result.current.fit?.recommended).toBe("dark")
  })

  it("keeps a stable result between unrelated renders", () => {
    writeCachedAnalysis(analysisCacheKey(night), analysisOf("#0b1020"))
    const { result, rerender } = renderHook(() => useWallpaperThemeFit(night, 0))
    const first = result.current.fit
    rerender()
    expect(result.current.fit).toBe(first)
  })
})
