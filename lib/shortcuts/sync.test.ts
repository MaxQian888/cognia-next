/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

// Controllable store state read by the hook's selectors.
let storeState = {
  hydrated: false,
  hydrate: jest.fn().mockResolvedValue(undefined),
}

jest.mock("./registry", () => ({
  useShortcutStore: <T>(selector: (s: typeof storeState) => T) => selector(storeState),
}))

import { useSyncShortcutsToRust } from "./sync"

const TAURI_KEY = "__TAURI_INTERNALS__"
function setPetWindow() {
  ;(window as unknown as Record<string, unknown>)[TAURI_KEY] = {
    metadata: { currentWebview: { label: "pet" } },
  }
}

beforeEach(() => {
  storeState = { hydrated: false, hydrate: jest.fn().mockResolvedValue(undefined) }
  // Default: web / main window (no Tauri internals present).
  delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
})

describe("useSyncShortcutsToRust", () => {
  it("hydrates the shortcut store on mount in the main/web window", () => {
    renderHook(() => useSyncShortcutsToRust())
    expect(storeState.hydrate).toHaveBeenCalledTimes(1)
  })

  it("does not re-hydrate once the store is hydrated", () => {
    storeState.hydrated = true
    renderHook(() => useSyncShortcutsToRust())
    expect(storeState.hydrate).not.toHaveBeenCalled()
  })

  it("does not hydrate in a least-privilege pet window", () => {
    // The pet window can't load `shortcuts.custom.v1` via the store plugin.
    setPetWindow()
    renderHook(() => useSyncShortcutsToRust())
    expect(storeState.hydrate).not.toHaveBeenCalled()
  })
})
