/**
 * @jest-environment jsdom
 */
import { render, act, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri/webview-zoom", () => {
  const actual = jest.requireActual<typeof import("@/lib/tauri/webview-zoom")>(
    "@/lib/tauri/webview-zoom"
  )
  return { ...actual, applyZoom: jest.fn() }
})

import * as webviewZoom from "@/lib/tauri/webview-zoom"
const applyZoom = webviewZoom.applyZoom as jest.Mock

const save = jest.fn().mockResolvedValue(undefined)
const settingsRef = {
  loaded: true,
  webviewZoom: 1.0 as number | undefined,
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      loaded: settingsRef.loaded,
      settings: { webviewZoom: settingsRef.webviewZoom },
      save,
    }),
}))

const logWarn = jest.fn()
jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: { warn: (...args: unknown[]) => logWarn(...args), info: jest.fn(), error: jest.fn() },
  },
}))

import { ZoomShortcuts } from "./zoom-shortcuts"
import { DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"

beforeEach(() => {
  jest.useFakeTimers()
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  save.mockReset().mockResolvedValue(undefined)
  logWarn.mockReset()
  settingsRef.loaded = true
  settingsRef.webviewZoom = DEFAULT_ZOOM
})

afterEach(() => {
  jest.useRealTimers()
})

function press(key: string, mod: "ctrl" | "meta" = "ctrl") {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: mod === "ctrl", metaKey: mod === "meta" })
  )
}

test("Ctrl+= triggers zoom-in by one step", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    press("=")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM + ZOOM_STEP, 4))
  )
})

test("Ctrl++ also triggers zoom-in (shifted form)", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    press("+")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM + ZOOM_STEP, 4))
  )
})

test("Ctrl+- triggers zoom-out by one step", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    press("-")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM - ZOOM_STEP, 4))
  )
})

test("Ctrl+0 resets zoom to default", async () => {
  settingsRef.webviewZoom = 1.5
  render(<ZoomShortcuts />)
  await act(async () => {
    press("0")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM))
})

test("Cmd+= works on macOS", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    press("=", "meta")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
})

test("non-mod keys are ignored", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "=" }))
  })
  expect(applyZoom).not.toHaveBeenCalled()
})

test("debounced save fires after the timer", async () => {
  render(<ZoomShortcuts />)
  await act(async () => {
    press("=")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
  // No persist yet (still inside debounce window).
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    jest.advanceTimersByTime(500)
  })
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ webviewZoom: expect.any(Number) }))
  )
})

test("logs a warning when persist rejects", async () => {
  save.mockRejectedValueOnce(new Error("io"))
  render(<ZoomShortcuts />)
  await act(async () => {
    press("=")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
  await act(async () => {
    jest.advanceTimersByTime(500)
  })
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "zoom persist failed",
      expect.objectContaining({ error: "io" })
    )
  )
})

test("removes the listener on unmount", async () => {
  const { unmount } = render(<ZoomShortcuts />)
  unmount()
  await act(async () => {
    press("=")
  })
  expect(applyZoom).not.toHaveBeenCalled()
})
