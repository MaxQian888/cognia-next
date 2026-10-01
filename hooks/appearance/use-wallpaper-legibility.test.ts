/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { Wallpaper } from "@/types/appearance"
import type { WallpaperThemeAnalysis } from "@/lib/appearance/wallpaper-theme-generator"

const analyzeWallpaperSource = jest.fn<
  Promise<WallpaperThemeAnalysis>,
  [Wallpaper["source"], { paintedCss?: string }?]
>()

jest.mock("@/lib/appearance/wallpaper-theme-generator", () => ({
  analyzeWallpaperSource: (...args: Parameters<typeof analyzeWallpaperSource>) =>
    analyzeWallpaperSource(...args),
}))

let role: string | null = null
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => role,
  isSecondaryOverlayRole: (r: string | null) => r === "pet-overlay",
}))

import {
  __INTERNALS__ as CACHE,
  writeCachedAnalysis,
  analysisCacheKey,
} from "@/lib/appearance/wallpaper-analysis-cache"
import { solveMaxImageWeight } from "@/lib/appearance/wallpaper-legibility"

import { useWallpaperLegibility, type UseWallpaperLegibilityArgs } from "./use-wallpaper-legibility"

const LIGHT = { foreground: "#0a0a0a", muted: "#737373", background: "#ffffff" }
const DARK = { foreground: "#fafafa", muted: "#a1a1a1", background: "#0a0a0a" }

const BUSY: WallpaperThemeAnalysis = {
  accent: "#3b82f6",
  secondary: "#f63b82",
  dominant: "#808080",
  averageLuminance: 0.5,
  luminanceSpread: 0.45,
  darkExtreme: "#101010",
  brightExtreme: "#f5f5f5",
  baseVariant: "dark",
}

function setTheme(ink: typeof LIGHT): void {
  const s = document.documentElement.style
  s.setProperty("--foreground", ink.foreground)
  s.setProperty("--muted-foreground", ink.muted)
  s.setProperty("--background", ink.background)
}

function image(id = "w1"): Wallpaper {
  return {
    id,
    name: id,
    kind: "image",
    source: {
      kind: "image",
      storage: "disk",
      relPath: `${id}.png`,
      mime: "image/png",
      width: 4,
      height: 4,
    },
    builtin: false,
    createdAt: 0,
  }
}

function gradient(): Wallpaper {
  return {
    id: "g1",
    name: "g1",
    kind: "gradient",
    source: { kind: "gradient", css: "linear-gradient(#000, #fff)" },
    builtin: false,
    createdAt: 0,
  }
}

const maxWeight = () => document.body.style.getPropertyValue("--wp-max-weight")

function expected(ink: typeof LIGHT, blurPx = 0): string {
  return String(
    solveMaxImageWeight({
      ink: { foreground: ink.foreground, mutedForeground: ink.muted, background: ink.background },
      extremes: { dark: BUSY.darkExtreme, bright: BUSY.brightExtreme, mean: BUSY.dominant },
      blurPx,
    })
  )
}

function render(args: Partial<UseWallpaperLegibilityArgs>) {
  const initial: UseWallpaperLegibilityArgs = {
    wallpaper: image(),
    blurPx: 0,
    guard: true,
    paintedCss: "url('blob:painted')",
    ...args,
  }
  return renderHook((props: UseWallpaperLegibilityArgs) => useWallpaperLegibility(props), {
    initialProps: initial,
  })
}

beforeEach(() => {
  role = null
  localStorage.clear()
  CACHE.resetMemory()
  analyzeWallpaperSource.mockReset()
  analyzeWallpaperSource.mockResolvedValue(BUSY)
  document.body.style.removeProperty("--wp-max-weight")
  setTheme(LIGHT)
})

describe("useWallpaperLegibility", () => {
  it("analyses the painted image and caps the layer", async () => {
    render({})
    await waitFor(() => expect(maxWeight()).toBe(expected(LIGHT)))
    expect(analyzeWallpaperSource).toHaveBeenCalledWith(image().source, {
      paintedCss: "url('blob:painted')",
    })
    expect(Number(maxWeight())).toBeLessThan(1)
  })

  it("waits for the painted image instead of resolving the source itself", () => {
    render({ paintedCss: null })
    expect(analyzeWallpaperSource).not.toHaveBeenCalled()
    expect(maxWeight()).toBe("")
  })

  it("analyses gradients from their declaration", async () => {
    render({ wallpaper: gradient(), paintedCss: null })
    await waitFor(() => expect(maxWeight()).not.toBe(""))
    expect(analyzeWallpaperSource).toHaveBeenCalledWith(gradient().source, {})
  })

  it("applies a cached analysis synchronously, without decoding again", () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    render({})
    expect(maxWeight()).toBe(expected(LIGHT))
    expect(analyzeWallpaperSource).not.toHaveBeenCalled()
  })

  it("persists what it analysed for the next launch", async () => {
    render({})
    await waitFor(() => expect(maxWeight()).not.toBe(""))
    CACHE.resetMemory()
    expect(localStorage.getItem(CACHE.STORAGE_KEY)).toContain("#101010")
  })

  it("solves blind when the image cannot be analysed", async () => {
    analyzeWallpaperSource.mockRejectedValueOnce(new Error("decode failed"))
    render({})
    await waitFor(() => expect(maxWeight()).not.toBe(""))
    expect(Number(maxWeight())).toBeLessThanOrEqual(Number(expected(LIGHT)))
  })

  it("re-solves when blur changes", async () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    const hook = render({})
    hook.rerender({
      wallpaper: image(),
      blurPx: 32,
      guard: true,
      paintedCss: "url('blob:painted')",
    })
    expect(maxWeight()).toBe(expected(LIGHT, 32))
  })

  it("re-solves when the theme's colours change", async () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    render({})
    expect(maxWeight()).toBe(expected(LIGHT))
    await act(async () => {
      setTheme(DARK)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(maxWeight()).toBe(expected(DARK))
  })

  it("removes the cap when the guard is turned off or the wallpaper goes away", () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    const hook = render({})
    expect(maxWeight()).not.toBe("")
    hook.rerender({
      wallpaper: image(),
      blurPx: 0,
      guard: false,
      paintedCss: "url('blob:painted')",
    })
    expect(maxWeight()).toBe("")
    hook.rerender({ wallpaper: image(), blurPx: 0, guard: true, paintedCss: "url('blob:painted')" })
    expect(maxWeight()).not.toBe("")
    hook.rerender({ wallpaper: null, blurPx: 0, guard: true, paintedCss: null })
    expect(maxWeight()).toBe("")
  })

  it("still analyses with the guard off, for theme fit and auto light/dark", async () => {
    render({ guard: false })
    await waitFor(() => expect(localStorage.getItem(CACHE.STORAGE_KEY)).toContain("#101010"))
    expect(maxWeight()).toBe("")
  })

  it("never runs in paint-through overlay windows", () => {
    role = "pet-overlay"
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    render({})
    expect(maxWeight()).toBe("")
    expect(analyzeWallpaperSource).not.toHaveBeenCalled()
  })

  it("leaves the layer uncapped when the theme colours are unreadable", () => {
    document.documentElement.style.setProperty("--foreground", "var(--nope)")
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    render({})
    expect(maxWeight()).toBe("")
  })

  it("clears the cap on unmount", () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    const hook = render({})
    hook.unmount()
    expect(maxWeight()).toBe("")
  })

  it("does not carry the previous wallpaper's cap onto one still being analysed", async () => {
    writeCachedAnalysis(analysisCacheKey(image()), BUSY)
    let resolveNext: (a: WallpaperThemeAnalysis) => void = () => {}
    analyzeWallpaperSource.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve))
    )
    const hook = render({})
    expect(maxWeight()).toBe(expected(LIGHT))
    hook.rerender({ wallpaper: image("w2"), blurPx: 0, guard: true, paintedCss: "url('blob:w2')" })
    expect(maxWeight()).toBe("")
    await act(async () => resolveNext(BUSY))
    expect(maxWeight()).toBe(expected(LIGHT))
  })

  it("drops a stale analysis that lands after the wallpaper changed", async () => {
    let resolveFirst: (a: WallpaperThemeAnalysis) => void = () => {}
    analyzeWallpaperSource.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    const hook = render({})
    writeCachedAnalysis(analysisCacheKey(image("w2")), {
      ...BUSY,
      darkExtreme: "#fafafa",
      brightExtreme: "#ffffff",
      dominant: "#fcfcfc",
    })
    hook.rerender({ wallpaper: image("w2"), blurPx: 0, guard: true, paintedCss: "url('blob:w2')" })
    expect(maxWeight()).toBe("1")
    await act(async () => resolveFirst(BUSY))
    expect(maxWeight()).toBe("1")
  })
})
