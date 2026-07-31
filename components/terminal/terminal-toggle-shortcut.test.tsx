/**
 * @jest-environment jsdom
 */

import { render, cleanup, act } from "@testing-library/react"

const mockDispatchShortcut = jest.fn()
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: (id: string) => mockDispatchShortcut(id),
  }),
}))

import { TerminalToggleShortcut } from "./terminal-toggle-shortcut"
import { AppShortcutDispatcher } from "@/components/providers/app-shortcut-dispatcher"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import {
  setContextKeys,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

// End-to-end: the component registers `terminal.toggle`, the dispatcher drives
// it. `when: "platform.tauri"` (from the catalog descriptor) gates dispatch.
function mountBoth() {
  return render(
    <>
      <AppShortcutDispatcher />
      <TerminalToggleShortcut />
    </>
  )
}

function fireCtrlBacktick(target?: EventTarget): void {
  const event = new KeyboardEvent("keydown", {
    key: "`",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  if (target) Object.defineProperty(event, "target", { value: target })
  window.dispatchEvent(event)
}

beforeEach(() => {
  __resetAppRuntimeForTesting()
  __resetAppKeybindingStoreForTesting()
  __resetContextKeysForTesting()
  localStorage.clear()
  setContextKeys({ "platform.tauri": true })
})

afterEach(() => {
  cleanup()
  useTerminalStore.getState().reset()
  mockDispatchShortcut.mockReset()
})

describe("TerminalToggleShortcut", () => {
  it("toggles panelOpen on Ctrl+`", () => {
    mountBoth()
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    act(() => fireCtrlBacktick())
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    act(() => fireCtrlBacktick())
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("fires dispatchShortcut('terminal.toggle') on each press", () => {
    mountBoth()
    act(() => fireCtrlBacktick())
    expect(mockDispatchShortcut).toHaveBeenCalledWith("terminal.toggle")
  })

  it.each(["input", "textarea"])("does not steal the chord when target is a %s", (tag) => {
    mountBoth()
    const el = document.createElement(tag)
    document.body.appendChild(el)
    act(() => fireCtrlBacktick(el))
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    el.remove()
  })

  it("does not steal the chord when target is contenteditable", () => {
    mountBoth()
    const div = document.createElement("div")
    div.setAttribute("contenteditable", "true")
    document.body.appendChild(div)
    act(() => fireCtrlBacktick(div))
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    div.remove()
  })

  it("is a no-op when platform.tauri is false", () => {
    __resetContextKeysForTesting() // platform.tauri unset ⇒ when clause false
    mountBoth()
    act(() => fireCtrlBacktick())
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    expect(mockDispatchShortcut).not.toHaveBeenCalled()
  })

  it("unregisters on unmount", () => {
    const { unmount } = mountBoth()
    unmount()
    act(() => fireCtrlBacktick())
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("ignores plain ` without Ctrl/Cmd", () => {
    mountBoth()
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", bubbles: true }))
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })
})
