/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  useAppShortcutChord,
  useAppShortcutLabel,
  useAppShortcutLabels,
  usePinnedNavShortcutLabels,
} from "./use-app-shortcut-label"
import {
  __resetContextKeysForTesting,
  setContextKeys,
} from "@/lib/plugin/context-keys/context-key-store"
import { PINNED_NAV_SHORTCUT_IDS } from "@/lib/shortcuts/app-catalog"
import { formatKeybinding, toAriaKeyShortcuts } from "@/lib/shortcuts/utils"
import {
  __resetAppKeybindingStoreForTesting,
  useAppKeybindingStore,
} from "@/stores/shortcuts/app-keybinding-store"

beforeEach(() => {
  __resetAppKeybindingStoreForTesting()
  __resetContextKeysForTesting()
})

describe("useAppShortcutChord", () => {
  it("is the catalog default until the user rebinds it", () => {
    const { result } = renderHook(() => useAppShortcutChord("shell.settings.open"))
    expect(result.current).toBe("ctrl+,")
    act(() => useAppKeybindingStore.getState().setOverride("shell.settings.open", "ctrl+shift+p"))
    expect(result.current).toBe("ctrl+shift+p")
  })

  it("is empty for an unknown id or a cleared binding", () => {
    expect(renderHook(() => useAppShortcutChord("nope")).result.current).toBe("")
    act(() => useAppKeybindingStore.getState().setOverride("shell.settings.open", ""))
    expect(renderHook(() => useAppShortcutChord("shell.settings.open")).result.current).toBe("")
  })
})

describe("useAppShortcutLabel", () => {
  it("formats the chord for display and for aria-keyshortcuts", () => {
    const { result } = renderHook(() => useAppShortcutLabel("shell.settings.open"))
    expect(result.current).toEqual({
      label: formatKeybinding("ctrl+,"),
      aria: toAriaKeyShortcuts("ctrl+,"),
    })
  })

  it("prints nothing for an unbound shortcut", () => {
    act(() => useAppKeybindingStore.getState().setOverride("shell.settings.open", ""))
    const { result } = renderHook(() => useAppShortcutLabel("shell.settings.open"))
    expect(result.current).toEqual({ label: "", aria: undefined })
  })
})

describe("useAppShortcutLabels", () => {
  it("labels every pinned slot in order, and follows a rebind", () => {
    const { result } = renderHook(() => useAppShortcutLabels(PINNED_NAV_SHORTCUT_IDS))
    expect(result.current.map((entry) => entry.aria)).toEqual(
      PINNED_NAV_SHORTCUT_IDS.map((_, index) => `Alt+${index + 1}`)
    )
    const before = result.current
    act(() =>
      useAppKeybindingStore.getState().setOverride(PINNED_NAV_SHORTCUT_IDS[0], "alt+shift+1")
    )
    expect(result.current).not.toBe(before)
    expect(result.current[0].aria).toBe("Alt+Shift+1")
  })

  it("keeps its result stable while nothing changes", () => {
    const { result, rerender } = renderHook(() => useAppShortcutLabels(PINNED_NAV_SHORTCUT_IDS))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe("usePinnedNavShortcutLabels", () => {
  it("prints the slots in the desktop app and in a browser off Linux", () => {
    setContextKeys({ "platform.tauri": true, "platform.linux": true })
    const { result } = renderHook(() => usePinnedNavShortcutLabels())
    expect(result.current[0].aria).toBe("Alt+1")
    act(() => setContextKeys({ "platform.tauri": false, "platform.linux": false }))
    expect(result.current[8].aria).toBe("Alt+9")
  })

  it("prints nothing in a browser on Linux, where the browser takes Alt+digit", () => {
    setContextKeys({ "platform.tauri": false, "platform.web": true, "platform.linux": true })
    const { result } = renderHook(() => usePinnedNavShortcutLabels())
    expect(result.current.every((entry) => entry.label === "" && entry.aria === undefined)).toBe(
      true
    )
  })

  it("leaves the ungated list untouched by the context", () => {
    setContextKeys({ "platform.tauri": false, "platform.linux": true })
    const { result } = renderHook(() => useAppShortcutLabels(PINNED_NAV_SHORTCUT_IDS))
    expect(result.current[0].aria).toBe("Alt+1")
  })
})
