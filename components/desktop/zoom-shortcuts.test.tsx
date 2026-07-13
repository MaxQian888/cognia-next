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
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: { warn: (...args: unknown[]) => logWarn(...args), info: jest.fn(), error: jest.fn() },
  },
  // Pulled in transitively by @/lib/plugin → hooks-system → core/logger.
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
}))

// The plugin runtime is reachable via getPluginEventHooks. Stub it with a
// no-op surface so the shortcut wiring doesn't drag the real plugin store
// (and its Tauri bindings) into the zoom-shortcuts test environment.
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: jest.fn().mockResolvedValue(false),
  }),
}))

import { ZoomShortcuts } from "./zoom-shortcuts"
import { AppShortcutDispatcher } from "@/components/providers/app-shortcut-dispatcher"
import { DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import { __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import {
  setContextKeys,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

// ZoomShortcuts registers the actions; the single dispatcher fires them. The
// zoom descriptors carry `when: "platform.tauri"`, so the context key gates them.
function renderZoom() {
  return render(
    <>
      <AppShortcutDispatcher />
      <ZoomShortcuts />
    </>
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  applyZoom.mockReset().mockImplementation(async (n: number) => Math.round(n * 20) / 20)
  save.mockReset().mockResolvedValue(undefined)
  logWarn.mockReset()
  settingsRef.loaded = true
  settingsRef.webviewZoom = DEFAULT_ZOOM
  __resetAppRuntimeForTesting()
  __resetAppKeybindingStoreForTesting()
  __resetContextKeysForTesting()
  localStorage.clear()
  setContextKeys({ "platform.tauri": true })
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
  renderZoom()
  await act(async () => {
    press("=")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM + ZOOM_STEP, 4))
  )
})

test("Ctrl++ also triggers zoom-in (shifted form)", async () => {
  renderZoom()
  await act(async () => {
    press("+")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM + ZOOM_STEP, 4))
  )
})

test("Ctrl+- triggers zoom-out by one step", async () => {
  renderZoom()
  await act(async () => {
    press("-")
  })
  await waitFor(() =>
    expect(applyZoom).toHaveBeenCalledWith(expect.closeTo(DEFAULT_ZOOM - ZOOM_STEP, 4))
  )
})

test("Ctrl+0 resets zoom to default", async () => {
  settingsRef.webviewZoom = 1.5
  renderZoom()
  await act(async () => {
    press("0")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM))
})

test("Cmd+= works on macOS", async () => {
  renderZoom()
  await act(async () => {
    press("=", "meta")
  })
  await waitFor(() => expect(applyZoom).toHaveBeenCalled())
})

test("non-mod keys are ignored", async () => {
  renderZoom()
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "=" }))
  })
  expect(applyZoom).not.toHaveBeenCalled()
})

test("debounced save fires after the timer", async () => {
  renderZoom()
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
  renderZoom()
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
  const { unmount } = renderZoom()
  unmount()
  await act(async () => {
    press("=")
  })
  expect(applyZoom).not.toHaveBeenCalled()
})
