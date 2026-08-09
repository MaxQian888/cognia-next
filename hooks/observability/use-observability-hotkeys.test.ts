/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { useObservabilityHotkeys, type HotkeyHandlers } from "./use-observability-hotkeys"
import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"

// The editable-target guard now lives in `lib/shortcuts/dom.ts` (tested there);
// this suite covers the observability hook's dispatch contract end-to-end.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut: jest.fn() }),
}))

function mount(handlers: HotkeyHandlers) {
  return renderHook(
    (props: { h: HotkeyHandlers }) => {
      useAppShortcutDispatcher()
      useObservabilityHotkeys(props.h)
    },
    { initialProps: { h: handlers } }
  )
}

function press(key: string, opts: KeyboardEventInit = {}, target: EventTarget = window) {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts })
  target.dispatchEvent(evt)
  return evt
}

beforeEach(() => {
  __resetAppRuntimeForTesting()
  __resetAppKeybindingStoreForTesting()
  __resetContextKeysForTesting()
  localStorage.clear()
})

describe("useObservabilityHotkeys", () => {
  it("dispatches e/r/f/s to their handlers", () => {
    const h = {
      onToggleEdit: jest.fn(),
      onRefresh: jest.fn(),
      onFocusFilter: jest.fn(),
      onOpenSettings: jest.fn(),
    }
    mount(h)
    press("e")
    press("r")
    press("f")
    press("s")
    expect(h.onToggleEdit).toHaveBeenCalledTimes(1)
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    expect(h.onFocusFilter).toHaveBeenCalledTimes(1)
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("is case-insensitive and calls preventDefault", () => {
    const onToggleEdit = jest.fn()
    mount({ onToggleEdit })
    const evt = press("E")
    expect(onToggleEdit).toHaveBeenCalled()
    expect(evt.defaultPrevented).toBe(true)
  })

  it("ignores presses with modifiers", () => {
    const onRefresh = jest.fn()
    mount({ onRefresh })
    press("r", { ctrlKey: true })
    press("r", { metaKey: true })
    press("r", { altKey: true })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("ignores presses that originate from an editable field", () => {
    const onToggleEdit = jest.fn()
    mount({ onToggleEdit })
    const input = document.createElement("input")
    document.body.appendChild(input)
    press("e", {}, input)
    expect(onToggleEdit).not.toHaveBeenCalled()
    input.remove()
  })

  it("no-ops for keys without a handler and unmounts cleanly", () => {
    const onRefresh = jest.fn()
    const { unmount } = mount({ onRefresh })
    // 'e' has no handler → does nothing, no preventDefault.
    expect(press("e").defaultPrevented).toBe(false)
    unmount()
    press("r")
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("always reads the latest handlers", () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = mount({ onRefresh: first })
    rerender({ h: { onRefresh: second } })
    press("r")
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
