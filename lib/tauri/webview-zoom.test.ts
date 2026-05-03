/**
 * @jest-environment jsdom
 */

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const setZoom = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom }),
}))

const logError = jest.fn()
jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: { error: (...args: unknown[]) => logError(...args), info: jest.fn(), warn: jest.fn() },
  },
}))

import {
  applyZoom,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoomPercent,
  MAX_ZOOM,
  MIN_ZOOM,
  resetZoom,
  ZOOM_STEP,
  zoomIn,
  zoomOut,
} from "./webview-zoom"

beforeEach(() => {
  isTauriMock.mockReset()
  setZoom.mockReset().mockResolvedValue(undefined)
  logError.mockReset()
  document.documentElement.style.zoom = ""
})

describe("clampZoom", () => {
  test("clamps to MIN_ZOOM", () => {
    expect(clampZoom(-1)).toBe(MIN_ZOOM)
    // ensure MIN_ZOOM is reachable as a literal value
    expect(MIN_ZOOM).toBe(0.5)
  })
  test("clamps to MAX_ZOOM", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(MAX_ZOOM).toBe(2.0)
  })
  test("returns DEFAULT_ZOOM for non-finite", () => {
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM)
    // Infinity is also non-finite — we treat it as DEFAULT_ZOOM (not MAX_ZOOM)
    // so a corrupted persisted value rounds to the safest baseline.
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM)
  })
  test("rounds to 0.05 to avoid float drift", () => {
    expect(clampZoom(1.000000001)).toBe(1.0)
    expect(clampZoom(1.234)).toBe(1.25)
  })
})

describe("applyZoom (Tauri)", () => {
  test("calls webview setZoom with clamped value and returns it", async () => {
    isTauriMock.mockReturnValue(true)
    const result = await applyZoom(1.7)
    expect(setZoom).toHaveBeenCalledWith(1.7)
    expect(result).toBe(1.7)
  })

  test("logs an error and still returns next when setZoom rejects", async () => {
    isTauriMock.mockReturnValue(true)
    setZoom.mockRejectedValueOnce(new Error("denied"))
    const result = await applyZoom(1.5)
    expect(logError).toHaveBeenCalledWith("webview-zoom setZoom failed", expect.any(Error))
    expect(result).toBe(1.5)
  })
})

describe("applyZoom (web fallback)", () => {
  test("writes html.style.zoom in web mode", async () => {
    isTauriMock.mockReturnValue(false)
    const result = await applyZoom(1.2)
    expect(document.documentElement.style.zoom).toBe("1.2")
    expect(result).toBe(1.2)
  })
})

describe("zoom step helpers", () => {
  test("zoomIn adds one step", async () => {
    isTauriMock.mockReturnValue(true)
    const r = await zoomIn(1.0)
    expect(r).toBe(clampZoom(1.0 + ZOOM_STEP))
  })

  test("zoomOut subtracts one step", async () => {
    isTauriMock.mockReturnValue(true)
    const r = await zoomOut(1.0)
    expect(r).toBe(clampZoom(1.0 - ZOOM_STEP))
  })

  test("resetZoom returns DEFAULT_ZOOM", async () => {
    isTauriMock.mockReturnValue(true)
    const r = await resetZoom()
    expect(r).toBe(DEFAULT_ZOOM)
  })

  test("zoomIn caps at MAX_ZOOM", async () => {
    isTauriMock.mockReturnValue(true)
    const r = await zoomIn(MAX_ZOOM)
    expect(r).toBe(MAX_ZOOM)
  })

  test("zoomOut caps at MIN_ZOOM", async () => {
    isTauriMock.mockReturnValue(true)
    const r = await zoomOut(MIN_ZOOM)
    expect(r).toBe(MIN_ZOOM)
  })
})

describe("formatZoomPercent", () => {
  test("renders integer percent", () => {
    expect(formatZoomPercent(1)).toBe("100%")
    expect(formatZoomPercent(1.5)).toBe("150%")
    expect(formatZoomPercent(0.5)).toBe("50%")
  })
})
